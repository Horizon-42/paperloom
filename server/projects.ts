// 项目（notebook）注册表：每个项目是一套完全独立的数据，放在 data/projects/<id>/ 下（结构与旧版的 data/ 根目录相同，
// 见 storageFs.ts）。data/projects.json 记录有哪些项目。只用 Node 内置模块。
//
// data/ 的三种状态（每次请求都重新判断，迁移脚本可以在服务运行时执行）：
//   projects  有 projects.json：正常
//   fresh     空目录（或只有 projects/）：虚拟出 default 项目，第一次真正写入时才创建 projects/default/ 和 projects.json
//   legacy    没有 projects.json 但根目录有旧版数据（library.json、pdfs/ 等，或迁移脚本的 .paperlens-migrating 标记）：
//             需要先运行 npm run migrate:projects，期间一律不写
//   broken    projects.json 无法解析，或读取目录出错（权限等）：一律不写
// 有 projects.json 时根目录下还有旧版文件（迁移后又运行过旧版本）：照常工作，状态接口里报告 strayLegacyFiles。
// 删除项目：把 projects/<id>/ 整个移到 trash/projects/<id>-<时间>/，从不物理删除；不能删除最后一个项目；
// 有页面（任何源、任何浏览器）在最近 PRESENCE_TTL_MS 内报告过正在使用的项目不能删除。
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { DataStore, StorageError, withDirLock, type DataStoreOptions } from "./storageFs.ts";

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_PROJECT_ID = "default";
export const DEFAULT_PROJECT_NAME = "我的项目";
export const REGISTRY_FILE = "projects.json";
export const PROJECTS_DIR = "projects";
/** 迁移脚本把整个 data/ 备份到它的上级目录下的这个前缀开头的目录（静态文件服务同样要拦住） */
export const MIGRATION_BACKUP_PREFIX = "data-backup-before-projects-";
/** 迁移脚本执行期间放在 data/ 根目录的标记（见 scripts/migrate-projects.mjs）：有它就按旧版结构处理，不写入 */
export const MIGRATING_MARKER = ".paperlens-migrating";
/** 页面每 20 秒报告一次"我正打开着这个项目"（后台标签页最慢约 1 分钟一次）；超过这么久没报告视为已关闭 */
export const PRESENCE_TTL_MS = 90_000;
export const CLIENT_ID_RE = /^[a-z0-9]{8,32}$/;
const NAME_MAX = 60;

export interface ProjectEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegistryFile {
  version: 1;
  projects: ProjectEntry[];
}

export type DataLayout =
  | { kind: "projects"; registry: RegistryFile }
  | { kind: "fresh" }
  | { kind: "legacy"; entries: string[] }
  | { kind: "broken"; error: string };

export interface ProjectList {
  needsMigration: boolean;
  projects: ProjectEntry[];
}

/** data/ 根目录里不算"数据"的条目：锁、崩溃残留的临时文件、Finder 的 .DS_Store */
export function isIgnorableRootEntry(name: string): boolean {
  return name === ".DS_Store" || name === ".lock" || name.startsWith(".lock.stale-") || /^\..+\.tmp$/.test(name);
}

export function validateProjectName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || [...n].length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(n)) throw new StorageError(400, "invalid-name", `项目名称需为 1–${NAME_MAX} 个字符`);
  return n;
}

/** 名字里的英文字母和数字作为 id 的前半部分（方便在 data/projects/ 里认出来），后面接随机串 */
export function generateProjectId(name: string, taken: Set<string>): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  for (;;) {
    const rand = Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join("");
    const id = slug ? `${slug}-${rand.slice(0, 4)}` : `p-${rand}`;
    if (PROJECT_ID_RE.test(id) && !taken.has(id) && id !== DEFAULT_PROJECT_ID) return id;
  }
}

function isEntry(v: unknown): v is ProjectEntry {
  const o = v as ProjectEntry | null;
  return !!o && typeof o === "object" && PROJECT_ID_RE.test(String(o.id)) && typeof o.name === "string" && Number.isFinite(o.createdAt) && Number.isFinite(o.updatedAt);
}

export function parseRegistry(text: string): RegistryFile {
  const doc = JSON.parse(text) as Partial<RegistryFile> | null;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.projects) || !doc.projects.every(isEntry)) throw new Error("不是有效的 projects.json");
  const ids = new Set(doc.projects.map((p) => p.id));
  if (ids.size !== doc.projects.length) throw new Error("projects.json 中有重复的项目 id");
  return { version: 1, projects: doc.projects.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt })) };
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errCode = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

/** 只有 ENOENT 算不存在；权限等其他错误照常抛出（调用方按 500 处理，不写入） */
async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (e) {
    if (errCode(e) === "ENOENT") return false;
    throw e;
  }
}

export interface ProjectRegistryOptions {
  /** data/ 根目录 */
  dir: string;
  now?: () => Date;
  /** 传给每个项目的 DataStore（备份间隔等，测试用） */
  store?: Omit<DataStoreOptions, "dir" | "ensureDir">;
  /** 删除项目时等待进行中的写入最多多久，默认 30 秒 */
  drainTimeoutMs?: number;
}

export class ProjectRegistry {
  readonly dir: string;
  readonly registryPath: string;
  readonly projectsDir: string;
  /** 删除的项目移到这里 */
  readonly trashDir: string;
  private readonly lockDir: string;
  private readonly now: () => Date;
  private readonly storeOpts: Omit<DataStoreOptions, "dir" | "ensureDir">;
  private readonly drainTimeoutMs: number;
  private readonly stores = new Map<string, DataStore>();
  private cache: { mtimeMs: number; size: number; registry: RegistryFile } | null = null;
  /** 进程内串行：注册表的读改写 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 各项目进行中的请求数；删除时等它归零 */
  private readonly busy = new Map<string, number>();
  private readonly deleting = new Set<string>();
  /** 项目 → 页面标识 → 最近一次报告的时间 */
  private readonly presence = new Map<string, Map<string, number>>();

  constructor(opts: ProjectRegistryOptions) {
    this.dir = path.resolve(opts.dir);
    this.registryPath = path.join(this.dir, REGISTRY_FILE);
    this.projectsDir = path.join(this.dir, PROJECTS_DIR);
    this.trashDir = path.join(this.dir, "trash", PROJECTS_DIR);
    this.lockDir = path.join(this.dir, ".lock");
    this.now = opts.now ?? (() => new Date());
    this.storeOpts = opts.store ?? {};
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
  }

  projectDir(id: string): string {
    return path.join(this.projectsDir, id);
  }

  // ---------- 读 ----------

  private async readRegistry(): Promise<RegistryFile | null> {
    let st;
    try {
      st = await fsp.stat(this.registryPath);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
      this.cache = null;
      return null;
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.registry;
    const registry = parseRegistry(await fsp.readFile(this.registryPath, "utf8"));
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, registry };
    return registry;
  }

  async layout(): Promise<DataLayout> {
    let registry: RegistryFile | null;
    try {
      registry = await this.readRegistry();
    } catch (e) {
      return { kind: "broken", error: e instanceof Error ? e.message : String(e) };
    }
    if (registry) return { kind: "projects", registry };
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (e) {
      if (errCode(e) !== "ENOENT") return { kind: "broken", error: `无法读取数据目录：${e instanceof Error ? e.message : String(e)}` };
      names = [];
    }
    const entries = names.filter((n) => !isIgnorableRootEntry(n));
    // 只有 projects/：全新目录，或迁移在写 projects.json 之前中断（数据都已在 projects/ 下）
    if (entries.every((n) => n === PROJECTS_DIR)) return { kind: "fresh" };
    return { kind: "legacy", entries: entries.sort() };
  }

  private virtualDefault(): ProjectEntry {
    const t = this.now().getTime();
    return { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME, createdAt: t, updatedAt: t };
  }

  async list(): Promise<ProjectList> {
    const l = await this.layout();
    if (l.kind === "broken") throw new StorageError(500, "registry-unreadable", `data/${REGISTRY_FILE} 无法读取：${l.error}`);
    if (l.kind === "legacy") return { needsMigration: true, projects: [] };
    if (l.kind === "fresh") return { needsMigration: false, projects: [this.virtualDefault()] };
    return { needsMigration: false, projects: l.registry.projects };
  }

  /**
   * 有 projects.json 时根目录下不属于项目结构的条目（例如迁移后又运行过旧版本，它把 library.json、pdfs/ 写回了根目录）。
   * trash/ 下除了 projects/ 以外的条目也算（旧版本把不再引用的 PDF 移到 trash/）。
   */
  async strayLegacyEntries(): Promise<string[]> {
    const names = await fsp.readdir(this.dir).catch(() => [] as string[]);
    const out = names.filter((n) => !isIgnorableRootEntry(n) && n !== REGISTRY_FILE && n !== PROJECTS_DIR && n !== "trash" && n !== MIGRATING_MARKER);
    const trash = await fsp.readdir(path.join(this.dir, "trash")).catch(() => [] as string[]);
    for (const n of trash) if (n !== PROJECTS_DIR && !isIgnorableRootEntry(n)) out.push(`trash/${n}`);
    return out.sort();
  }

  /** 页面报告正在使用某个项目（心跳）；leave 为页面关闭时 */
  async touch(id: string, client: string): Promise<void> {
    await this.get(id);
    let m = this.presence.get(id);
    if (!m) this.presence.set(id, (m = new Map()));
    m.set(client, this.now().getTime());
  }

  leave(id: string, client: string): void {
    this.presence.get(id)?.delete(client);
  }

  /** 最近 PRESENCE_TTL_MS 内报告过的页面数，以及最近一次报告距今多久 */
  activeClients(id: string): { count: number; lastSeenMsAgo: number | null } {
    const m = this.presence.get(id);
    if (!m) return { count: 0, lastSeenMsAgo: null };
    const t = this.now().getTime();
    let count = 0;
    let newest = 0;
    for (const [c, seen] of m) {
      if (t - seen >= PRESENCE_TTL_MS) m.delete(c);
      else {
        count++;
        newest = Math.max(newest, seen);
      }
    }
    return { count, lastSeenMsAgo: count ? t - newest : null };
  }

  /** 项目条目；不存在时抛出 404，旧版目录抛出 409 needs-migration */
  async get(id: string): Promise<ProjectEntry> {
    if (!PROJECT_ID_RE.test(id)) throw new StorageError(404, "unknown-project", "没有这个项目");
    const l = await this.layout();
    if (l.kind === "broken") throw new StorageError(500, "registry-unreadable", `data/${REGISTRY_FILE} 无法读取：${l.error}`);
    if (l.kind === "legacy") throw needsMigration();
    const entry = l.kind === "fresh" ? (id === DEFAULT_PROJECT_ID ? this.virtualDefault() : null) : l.registry.projects.find((p) => p.id === id);
    if (!entry || this.deleting.has(id)) throw new StorageError(404, "unknown-project", "没有这个项目");
    return entry;
  }

  /**
   * 打开项目的数据目录。release 必须在请求结束时调用（删除项目要等进行中的请求结束）。
   * 目录不存在时 DataStore 只在真正写入时通过 ensureProjectDir 创建：只有空 data/ 里的 default 项目会被自动创建。
   */
  async open(id: string): Promise<{ entry: ProjectEntry; store: DataStore; release: () => void }> {
    const entry = await this.get(id);
    this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.busy.get(id) ?? 1) - 1;
      if (n > 0) this.busy.set(id, n);
      else this.busy.delete(id);
    };
    return { entry, store: this.storeFor(id), release };
  }

  private storeFor(id: string): DataStore {
    let s = this.stores.get(id);
    if (!s) {
      s = new DataStore({ ...this.storeOpts, dir: this.projectDir(id), ensureDir: () => this.ensureProjectDir(id) });
      this.stores.set(id, s);
    }
    return s;
  }

  /** DataStore 要写入而项目目录不存在时 */
  private async ensureProjectDir(id: string): Promise<void> {
    if (this.deleting.has(id)) throw new StorageError(404, "unknown-project", "没有这个项目");
    const l = await this.layout();
    if (l.kind === "legacy") throw needsMigration();
    if (l.kind === "fresh" && id === DEFAULT_PROJECT_ID) {
      await this.mutate(async () => undefined);
      return;
    }
    // 已登记但目录不在了（被手工删除或移走）：不悄悄重建
    throw new StorageError(404, "project-dir-missing", `项目目录 data/${PROJECTS_DIR}/${id}/ 不存在`);
  }

  /** 崩溃残留的临时文件（服务启动时调用，只处理已登记的项目） */
  async cleanupTemp(): Promise<void> {
    const l = await this.layout();
    if (l.kind !== "projects") return;
    for (const p of l.registry.projects) await this.storeFor(p.id).cleanupTemp().catch(() => {});
  }

  // ---------- 写 ----------

  private async writeRegistry(reg: RegistryFile): Promise<void> {
    const tmp = path.join(this.dir, `.${REGISTRY_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fh = await fsp.open(tmp, "w");
    try {
      await fh.writeFile(`${JSON.stringify(reg, null, 2)}\n`);
      await fh.datasync();
    } finally {
      await fh.close();
    }
    try {
      await fsp.rename(tmp, this.registryPath);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    this.cache = null;
  }

  /**
   * 读改写注册表（进程内串行 + data/.lock 跨进程锁）。空目录时先建好 default 项目（连同 projects/ 下已有的子目录一起登记）。
   * fn 返回新的注册表时写入。
   */
  private mutate<T>(fn: (reg: RegistryFile) => Promise<{ registry?: RegistryFile; result: T } | undefined>): Promise<T> {
    const run = this.chain.then(async () => {
      // 旧版结构或读不了的目录：连锁也不拿（拿锁会在 data/ 里建 .lock）
      const pre = await this.layout();
      if (pre.kind === "legacy") throw needsMigration();
      if (pre.kind === "broken") throw new StorageError(500, "registry-unreadable", `data/${REGISTRY_FILE} 无法读取：${pre.error}`);
      await fsp.mkdir(this.dir, { recursive: true });
      return withDirLock(this.lockDir, this.storeOpts.lockStaleMs ?? 15_000, async () => {
        const l = await this.layout();
        if (l.kind === "legacy") throw needsMigration();
        if (l.kind === "broken") throw new StorageError(500, "registry-unreadable", `data/${REGISTRY_FILE} 无法读取：${l.error}`);
        let reg: RegistryFile;
        if (l.kind === "fresh") {
          reg = await this.initialRegistry();
          await fsp.mkdir(this.projectDir(DEFAULT_PROJECT_ID), { recursive: true });
          await this.writeRegistry(reg);
        } else reg = l.registry;
        const out = await fn(reg);
        if (out?.registry) await this.writeRegistry(out.registry);
        return out?.result as T;
      });
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async initialRegistry(): Promise<RegistryFile> {
    const projects: ProjectEntry[] = [this.virtualDefault()];
    let dirs: import("node:fs").Dirent[] = [];
    try {
      dirs = await fsp.readdir(this.projectsDir, { withFileTypes: true });
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name === DEFAULT_PROJECT_ID || !PROJECT_ID_RE.test(d.name)) continue;
      const t = this.now().getTime();
      projects.push({ id: d.name, name: d.name, createdAt: t, updatedAt: t });
    }
    return { version: 1, projects };
  }

  /** 新建项目；id 缺省时按名字生成（浏览器里先建的项目带着自己的 id 登记） */
  create(name: unknown, id?: unknown): Promise<ProjectEntry> {
    const n = validateProjectName(name);
    if (id !== undefined && (typeof id !== "string" || !PROJECT_ID_RE.test(id))) throw new StorageError(400, "invalid-project", "无效的项目 id");
    return this.mutate(async (reg) => {
      const taken = new Set(reg.projects.map((p) => p.id));
      if (typeof id === "string" && taken.has(id)) throw new StorageError(409, "exists", "已有这个项目");
      let pid = typeof id === "string" ? id : generateProjectId(n, taken);
      // 目录已存在（未登记的残留）时不占用它
      while (await exists(this.projectDir(pid))) {
        if (typeof id === "string") throw new StorageError(409, "exists", `data/${PROJECTS_DIR}/${id}/ 已存在`);
        pid = generateProjectId(n, taken);
      }
      await fsp.mkdir(this.projectDir(pid), { recursive: true });
      const t = this.now().getTime();
      const entry: ProjectEntry = { id: pid, name: n, createdAt: t, updatedAt: t };
      return { registry: { version: 1, projects: [...reg.projects, entry] }, result: entry };
    });
  }

  async rename(id: string, name: unknown): Promise<ProjectEntry> {
    const n = validateProjectName(name);
    await this.get(id);
    return this.mutate(async (reg) => {
      const cur = reg.projects.find((p) => p.id === id);
      if (!cur) throw new StorageError(404, "unknown-project", "没有这个项目");
      const entry = { ...cur, name: n, updatedAt: this.now().getTime() };
      return { registry: { version: 1, projects: reg.projects.map((p) => (p.id === id ? entry : p)) }, result: entry };
    });
  }

  /** 删除项目：等进行中的请求结束，把目录移到 trash/projects/<id>-<时间>/，再从注册表去掉 */
  async remove(id: string): Promise<{ trashedTo: string }> {
    await this.get(id);
    const l = await this.layout();
    if (l.kind !== "projects" || l.registry.projects.length <= 1) throw new StorageError(409, "last-project", "不能删除最后一个项目");
    const active = this.activeClients(id);
    if (active.count) {
      const ago = Math.round((active.lastSeenMsAgo ?? 0) / 1000);
      throw new StorageError(409, "project-active", `这个项目正在别的窗口中打开（${ago} 秒前还在使用，可能是另一个地址或浏览器打开的页面）：请先关闭它；刚关闭的话请稍等一分钟再试`, {
        clients: active.count,
      });
    }
    this.deleting.add(id);
    try {
      const deadline = Date.now() + this.drainTimeoutMs;
      while ((this.busy.get(id) ?? 0) > 0) {
        if (Date.now() > deadline) throw new StorageError(503, "busy", "这个项目正在保存，请稍后再试");
        await sleep(25);
      }
      return await this.mutate(async (reg) => {
        if (!reg.projects.some((p) => p.id === id)) throw new StorageError(404, "unknown-project", "没有这个项目");
        if (reg.projects.length <= 1) throw new StorageError(409, "last-project", "不能删除最后一个项目");
        const src = this.projectDir(id);
        let rel: string | null = null;
        if (await exists(src)) {
          await fsp.mkdir(this.trashDir, { recursive: true });
          const base = `${id}-${stamp(this.now())}`;
          let name = base;
          for (let i = 2; await exists(path.join(this.trashDir, name)); i++) name = `${base}-${i}`;
          const dest = path.join(this.trashDir, name);
          // 拿着项目自己的写锁再移动：另一个进程正在写这个项目时等它写完
          await this.storeFor(id).withFsLock(() => fsp.rename(src, dest));
          // 锁目录随项目一起移走了，留在回收站里没有意义
          await fsp.rm(path.join(dest, ".lock"), { recursive: true, force: true });
          rel = path.posix.join("trash", PROJECTS_DIR, name);
        }
        this.stores.delete(id);
        this.presence.delete(id);
        return { registry: { version: 1, projects: reg.projects.filter((p) => p.id !== id) }, result: { trashedTo: rel ?? "" } };
      });
    } finally {
      this.deleting.delete(id);
    }
  }
}

function needsMigration(): StorageError {
  return new StorageError(409, "needs-migration", "data/ 还是旧版的目录结构，需要先迁移到项目结构：请运行 npm run migrate:projects");
}
