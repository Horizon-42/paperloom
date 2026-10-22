// 一个项目的数据目录（data/projects/<id>/，见 projects.ts）的读写：library.json（原子写入、revision 校验、滚动备份）、
// PDF（按哈希存放，不再引用的移到回收站）、附加文件组（Markdown、画布等，按清单删除旧文件）。只用 Node 内置模块。
//
// 目录结构（相对项目目录）：
//   library.json          全部结构化数据（前端生成，逐行一条记录）
//   pdfs/<sha256>.pdf     PDF 原文件，写入一次不再改
//   backups/              library.json 的滚动备份（gzip）
//   trash/                不再被引用的 PDF（从不物理删除）
//   <group>/              附加文件组（markdown、canvas…），.paperlens-manifest.json 记录上次写入的文件；
//                         用户放进来或改过的同名文件不覆盖、不删除，移到 <group>/.paperlens-replaced/
//   .lock/owner           跨进程写锁（持有者定期刷新 mtime 作为心跳）
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const HASH_RE = /^[0-9a-f]{64}$/;
const SHA1_RE = /^[0-9a-f]{40}$/;
export const GROUP_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** data/ 下由存储服务自己使用的目录，不能作为附加文件组 */
export const RESERVED_GROUPS = new Set(["pdfs", "backups", "trash", "tmp"]);
export const REASON_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MANIFEST = ".paperlens-manifest.json";
const REPLACED_DIR = ".paperlens-replaced";
const PDF_NAME_RE = /^([0-9a-f]{64})\.pdf$/;
const AUTO_BACKUP_RE = /^library-(\d{8})-(\d{6})-r(\d+)(?:-(\d+))?\.json(?:\.gz)?$/;
const MANUAL_BACKUP_RE = /^library-(\d{8})-(\d{6})-r(\d+)-([a-z][a-z0-9-]*)\.json(?:\.gz)?$/;
/** 记录的是文件夹自己的历史状态（而不是某个浏览器里的数据）的备份原因，从备份恢复时优先 */
const FOLDER_STATE_REASONS = /^(shrink|before-overwrite|manual)\d*$/;
/** 判断"是否有数据"时计入的表（kv 是设置，boardNodes 依附于 boards） */
const CONTENT_TABLES = ["domains", "papers", "annotations", "terms", "links", "notes", "boards"];

export class StorageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface LibraryInfo {
  exists: boolean;
  /** 文件不存在或无法解析时为 0 */
  revision: number;
  /** 数据格式版本 */
  version: number | null;
  savedAt: number | null;
  size: number;
  counts: Record<string, number> | null;
  hasData: boolean;
  /** 写入方给出的数据内容哈希（tables 部分的 SHA-256），用来认出"这就是我写的那份" */
  contentHash: string | null;
  /** 文件存在但无法解析 */
  error?: string;
}

export interface DataStoreOptions {
  dir: string;
  now?: () => Date;
  /** 自动备份最短间隔，默认 1 小时 */
  backupIntervalMs?: number;
  /** 保留最近多少个自动备份，默认 72 */
  keepRecent?: number;
  /** 另外保留最近多少天每天最后一个自动备份，默认 30 */
  keepDaily?: number;
  /** 保留最近多少个带原因的备份（导入前、覆盖前等），默认 30 */
  keepManual?: number;
  /** 备份总大小上限（字节），超出时删最旧的（至少保留最新 3 个），默认 512 MB */
  maxBackupBytes?: number;
  /** 跨进程锁的心跳超过这么久没有刷新视为持有者已崩溃，默认 15 秒 */
  lockStaleMs?: number;
  /**
   * 需要写入而目录还不存在时调用（应创建目录或抛出错误）；缺省直接递归创建。
   * 项目注册表用它保证只有已登记的项目才有目录（见 projects.ts）
   */
  ensureDir?: () => Promise<void>;
}

interface Envelope {
  format: "paperlens";
  version: number;
  revision?: number;
  contentHash?: unknown;
  tables: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 解析并校验 library.json 的外层结构（不校验每条记录，那是前端导入时的事） */
export function parseEnvelope(text: string): Envelope {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new StorageError(400, "invalid-json", "不是有效的 JSON");
  }
  if (!isObject(doc) || doc.format !== "paperlens") throw new StorageError(400, "invalid-format", "不是 Paperloom 数据文件");
  if (typeof doc.version !== "number" || !Number.isFinite(doc.version) || doc.version < 1)
    throw new StorageError(400, "invalid-format", "缺少有效的数据格式版本");
  if (!isObject(doc.tables)) throw new StorageError(400, "invalid-format", "缺少数据表");
  return doc as unknown as Envelope;
}

export function countEnvelope(doc: Envelope): { counts: Record<string, number>; hasData: boolean } {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(doc.tables)) if (Array.isArray(v)) counts[k] = v.length;
  return { counts, hasData: CONTENT_TABLES.some((t) => (counts[t] ?? 0) > 0) };
}

/**
 * 文件里记录的内容哈希，只有与实际内容相符才采信：前端写入的文件是 {...,"tables":<tablesJson>}\n，
 * contentHash 是 tablesJson 的 SHA-256。手工改过的文件对不上，按"不知道是哪份数据"处理。
 */
function verifiedContentHash(text: string, doc: Envelope): string | null {
  const claimed = typeof doc.contentHash === "string" && HASH_RE.test(doc.contentHash) ? doc.contentHash : null;
  if (!claimed) return null;
  const i = text.indexOf(',"tables":');
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (i < 0 || text[end - 1] !== "}") return null;
  return createHash("sha256").update(text.slice(i + ',"tables":'.length, end - 1)).digest("hex") === claimed ? claimed : null;
}

function referencedHashes(doc: Envelope): Set<string> {
  const out = new Set<string>();
  const papers = doc.tables.papers;
  if (Array.isArray(papers)) {
    for (const p of papers) if (isObject(p) && typeof p.fileHash === "string" && HASH_RE.test(p.fileHash)) out.add(p.fileHash);
  }
  return out;
}

/**
 * 附加文件的相对路径：用 "/" 分隔，每段非空、不以 "." 开头（排除 ".."、隐藏文件和清单）、
 * 不含控制字符和 Windows 不允许的字符、不以空格或句点结尾、不超过 255 字节。返回各段，非法时返回 null。
 */
export function validateRelativeName(name: unknown): string[] | null {
  if (typeof name !== "string" || !name || name.length > 1024) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  if (name.startsWith("/") || name.includes("\\") || /^[a-zA-Z]:/.test(name)) return null;
  const segs = name.split("/");
  if (segs.length > 8) return null;
  for (const s of segs) {
    if (!s || s.startsWith(".") || /[<>:"|?*]/.test(s) || /[. ]$/.test(s) || Buffer.byteLength(s) > 255) return null;
  }
  return segs;
}

const foldName = (name: string) => name.normalize("NFC").toLowerCase();

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha1 = (data: string | Buffer) => createHash("sha1").update(data).digest("hex");

async function sha256File(p: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(p), async function* (src: AsyncIterable<Buffer>) {
    for await (const chunk of src) h.update(chunk);
  });
  return h.digest("hex");
}

async function dirSize(p: string): Promise<number> {
  let total = 0;
  const entries = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += (await fsp.stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** 本地时间 YYYYMMDD-HHMMSS（备份按本地日期轮转） */
function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function parseStamp(day: string, time: string): number {
  const d = new Date(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4), +time.slice(4, 6));
  return d.getTime();
}

interface BackupEntry {
  name: string;
  /** 用于排序：时间戳 + 同一秒内的序号 */
  key: string;
  day: string;
  reason: string | null;
}

function parseBackupName(name: string): BackupEntry | null {
  const a = AUTO_BACKUP_RE.exec(name);
  if (a) return { name, key: `${a[1]}${a[2]}${a[4]?.padStart(4, "0") ?? "0000"}`, day: a[1], reason: null };
  const m = MANUAL_BACKUP_RE.exec(name);
  if (m) return { name, key: `${m[1]}${m[2]}0000`, day: m[1], reason: m[4] };
  return null;
}

const newestFirst = (x: BackupEntry, y: BackupEntry) => (x.key < y.key ? 1 : x.key > y.key ? -1 : x.name < y.name ? 1 : -1);

/** 备份轮转：自动备份保留最近 keepRecent 个，外加最近 keepDaily 天每天最后一个；带原因的保留最近 keepManual 个。返回要删除的文件名 */
export function backupsToPrune(names: string[], keepRecent: number, keepDaily: number, keepManual: number): string[] {
  const all = names.map(parseBackupName).filter((b): b is BackupEntry => !!b);
  const auto = all.filter((b) => b.reason === null).sort(newestFirst);
  const manual = all.filter((b) => b.reason !== null).sort(newestFirst);
  const keep = new Set(auto.slice(0, keepRecent).map((b) => b.name));
  const days = new Set<string>();
  for (const b of auto) {
    if (days.has(b.day)) continue;
    if (days.size >= keepDaily) break;
    days.add(b.day);
    keep.add(b.name); // 列表已按时间倒序，每天第一个就是当天最后一个
  }
  return [...auto.filter((b) => !keep.has(b.name)).map((b) => b.name), ...manual.slice(keepManual).map((b) => b.name)];
}

export interface FilesResult {
  written: number;
  unchanged: number;
  deleted: number;
  /** 用户放进来或改过、因而移到 .paperlens-replaced/ 的文件数 */
  replaced: number;
  /** 只给了 sha、但服务端没有这份内容的文件：客户端需要带内容重发 */
  missing: string[];
}

export interface StorageUsage {
  library: number;
  pdfs: number;
  backups: number;
  trash: number;
  /** 附加文件组（markdown、canvas…） */
  groups: Record<string, number>;
  total: number;
}

export interface LockHandle {
  /** 锁是否仍归自己（没有因心跳中断被别的进程接管） */
  owned(): Promise<boolean>;
}

/**
 * 跨进程锁（例如两个开发服务器指向同一个 data/）。mkdir 是原子的；锁里写入随机令牌，持有期间定期刷新 mtime（心跳），
 * 只有心跳停止超过 staleMs 才会被别的进程接管；释放时只删自己的锁。lockDir 的上级目录必须已存在。
 */
export async function withDirLock<T>(lockDir: string, staleMs: number, fn: (lock: LockHandle) => Promise<T>): Promise<T> {
  const token = randomBytes(12).toString("hex");
  const ownerFile = path.join(lockDir, "owner");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fsp.mkdir(lockDir);
      await fsp.writeFile(ownerFile, token);
      break;
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
      const st = (await fsp.stat(ownerFile).catch(() => null)) ?? (await fsp.stat(lockDir).catch(() => null));
      if (st && Date.now() - st.mtimeMs > staleMs) {
        // 先改名再删：几个进程同时判定残留时只有一个能改名成功
        const grave = `${lockDir}.stale-${randomBytes(4).toString("hex")}`;
        if (await fsp.rename(lockDir, grave).then(() => true, () => false)) await fsp.rm(grave, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new StorageError(503, "busy", "数据目录正被另一个进程写入，请稍后再试");
      await sleep(25);
    }
  }
  const beat = setInterval(() => {
    const t = new Date();
    void fsp.utimes(ownerFile, t, t).catch(() => {});
  }, Math.max(10, Math.floor(staleMs / 3)));
  beat.unref?.();
  const owned = async () => (await fsp.readFile(ownerFile, "utf8").catch(() => "")) === token;
  try {
    return await fn({ owned });
  } finally {
    clearInterval(beat);
    if (await owned()) await fsp.rm(lockDir, { recursive: true, force: true });
  }
}

export class DataStore {
  readonly dir: string;
  readonly libraryPath: string;
  readonly pdfDir: string;
  readonly backupDir: string;
  readonly trashDir: string;
  private readonly lockDir: string;
  private readonly now: () => Date;
  private readonly ensureDir: (() => Promise<void>) | undefined;
  private readonly opts: Required<Omit<DataStoreOptions, "dir" | "now" | "ensureDir">>;
  private cache: { mtimeMs: number; size: number; info: LibraryInfo } | null = null;
  /** 进程内互斥：library、备份、PDF 清扫串行执行 */
  private chain: Promise<unknown> = Promise.resolve();
  private groupChains = new Map<string, Promise<unknown>>();

  constructor(options: DataStoreOptions) {
    this.dir = path.resolve(options.dir);
    this.libraryPath = path.join(this.dir, "library.json");
    this.pdfDir = path.join(this.dir, "pdfs");
    this.backupDir = path.join(this.dir, "backups");
    this.trashDir = path.join(this.dir, "trash");
    this.lockDir = path.join(this.dir, ".lock");
    this.now = options.now ?? (() => new Date());
    this.ensureDir = options.ensureDir;
    this.opts = {
      backupIntervalMs: options.backupIntervalMs ?? 3600_000,
      keepRecent: options.keepRecent ?? 72,
      keepDaily: options.keepDaily ?? 30,
      keepManual: options.keepManual ?? 30,
      maxBackupBytes: options.maxBackupBytes ?? 512 * 1024 * 1024,
      lockStaleMs: options.lockStaleMs ?? 15_000,
    };
  }

  // ---------- 通用 ----------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /** 目录是否存在：只有 ENOENT 算不存在，其他错误（权限等）抛出，不往下写 */
  private async dirExists(): Promise<boolean> {
    try {
      await fsp.stat(this.dir);
      return true;
    } catch (e) {
      if (errCode(e) === "ENOENT") return false;
      throw e;
    }
  }

  /** 要写入前确保目录存在（缺省递归创建；由项目注册表创建的实例只接受已登记项目的目录） */
  private async ensureRoot(): Promise<void> {
    if (await this.dirExists()) return;
    if (this.ensureDir) await this.ensureDir();
    else await fsp.mkdir(this.dir, { recursive: true });
  }

  /** 本目录的跨进程写锁（见 withDirLock）；项目注册表删除项目前也要先拿到它 */
  async withFsLock<T>(fn: (lock: LockHandle) => Promise<T>): Promise<T> {
    await this.ensureRoot();
    return withDirLock(this.lockDir, this.opts.lockStaleMs, fn);
  }

  /** 写临时文件（与目标同目录，保证能 rename）并落盘；派生文件（Markdown 等）不必等落盘 */
  private async writeTemp(dest: string, data: Buffer | string, durable: boolean): Promise<string> {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fh = await fsp.open(tmp, "w");
    try {
      await fh.writeFile(data);
      if (durable) await fh.datasync();
    } finally {
      await fh.close();
    }
    return tmp;
  }

  private async commitTemp(tmp: string, dest: string): Promise<void> {
    try {
      await fsp.rename(tmp, dest);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  private async atomicWrite(dest: string, data: Buffer | string, durable = true): Promise<void> {
    await this.commitTemp(await this.writeTemp(dest, data, durable), dest);
  }

  /** 清掉崩溃残留的临时文件（超过 1 小时的） */
  async cleanupTemp(): Promise<void> {
    const cutoff = Date.now() - 3600_000;
    for (const d of [this.dir, this.pdfDir, this.backupDir]) {
      const names = await fsp.readdir(d).catch(() => [] as string[]);
      for (const n of names) {
        if (!/^\..+\.tmp$/.test(n)) continue;
        const p = path.join(d, n);
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoff) await fsp.rm(p, { force: true });
      }
    }
  }

  // ---------- library.json ----------

  /** 当前 library.json 的摘要。按 mtime + size 缓存解析结果，外部改动（另一个进程、手工编辑）会被发现 */
  async libraryInfo(): Promise<LibraryInfo> {
    const st = await fsp.stat(this.libraryPath).catch(() => null);
    if (!st) {
      this.cache = null;
      return { exists: false, revision: 0, version: null, savedAt: null, size: 0, counts: null, hasData: false, contentHash: null };
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.info;
    let info: LibraryInfo;
    try {
      const text = await fsp.readFile(this.libraryPath, "utf8");
      const doc = parseEnvelope(text);
      const { counts, hasData } = countEnvelope(doc);
      const revision = Number.isInteger(doc.revision) && doc.revision! > 0 ? doc.revision! : 0;
      info = { exists: true, revision, version: doc.version, savedAt: Math.round(st.mtimeMs), size: st.size, counts, hasData, contentHash: verifiedContentHash(text, doc) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      info = { exists: true, revision: 0, version: null, savedAt: Math.round(st.mtimeMs), size: st.size, counts: null, hasData: false, contentHash: null, error: message };
    }
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, info };
    return info;
  }

  async openLibrary(): Promise<{ stream: ReadStream; info: LibraryInfo } | null> {
    const info = await this.libraryInfo();
    if (!info.exists) return null;
    return { stream: createReadStream(this.libraryPath), info };
  }

  /**
   * 写入 library.json。乐观并发：baseRevision 必须等于当前 revision，新内容的 revision 必须是当前 +1；
   * 文件不存在时接受任何 revision。现有文件无法解析时拒绝覆盖，除非 overwriteUnreadable（会先备份）。
   * 成功后按需备份旧文件、清扫不再引用的 PDF。数据骤减时额外备份，并在结果里给出备份文件名。
   */
  async putLibrary(
    body: Buffer,
    baseRevision: number,
    opts: { overwriteUnreadable?: boolean } = {},
  ): Promise<{ revision: number; savedAt: number; hasData: boolean; backup?: string }> {
    const bodyText = body.toString("utf8");
    const doc = parseEnvelope(bodyText);
    const revision = doc.revision;
    if (!Number.isInteger(revision) || revision! < 1) throw new StorageError(400, "invalid-revision", "revision 必须是正整数");
    const next = countEnvelope(doc);
    const contentHash = verifiedContentHash(bodyText, doc);
    return this.exclusive(() =>
      this.withFsLock(async (lock) => {
        const cur = await this.libraryInfo();
        let backup: string | undefined;
        if (cur.exists && cur.error) {
          if (!opts.overwriteUnreadable)
            throw new StorageError(409, "unreadable", "data/library.json 无法读取（可能已损坏），不能直接覆盖", { revision: 0, contentHash: null });
          await this.backupCurrent(cur, "unreadable");
        } else if (cur.exists) {
          if (baseRevision !== cur.revision)
            throw new StorageError(409, "conflict", "文件夹中的数据已被另一个窗口更新", { revision: cur.revision, contentHash: cur.contentHash });
          if (revision !== cur.revision + 1)
            throw new StorageError(400, "invalid-revision", `revision 应为 ${cur.revision + 1}`, { revision: cur.revision });
          if (cur.version !== null && Math.floor(cur.version) > Math.floor(doc.version))
            throw new StorageError(409, "newer-format", "文件夹中的数据由更新版本的 Paperloom 写入，旧版本不能覆盖", { revision: cur.revision });
          const total = (c: Record<string, number> | null) => CONTENT_TABLES.reduce((s, t) => s + (c?.[t] ?? 0), 0);
          // 数据大幅减少（例如浏览器数据被清空后写回）时不受每小时一次的限制，先留一份
          if (cur.hasData && total(next.counts) < total(cur.counts) / 2) backup = await this.backupCurrent(cur, "shrink");
          else await this.maybeAutoBackup(cur);
        }
        const tmp = await this.writeTemp(this.libraryPath, body, true);
        // 提交前再确认：锁仍归自己，文件也没有在此期间被别人改过
        const again = await this.libraryInfo();
        if (!(await lock.owned()) || again.exists !== cur.exists || again.revision !== cur.revision || again.contentHash !== cur.contentHash) {
          await fsp.rm(tmp, { force: true });
          throw new StorageError(409, "conflict", "文件夹中的数据已被另一个窗口更新", { revision: again.revision, contentHash: again.contentHash });
        }
        await this.commitTemp(tmp, this.libraryPath);
        // 刚解析过，直接更新缓存，不必重读
        const st = await fsp.stat(this.libraryPath);
        const info: LibraryInfo = {
          exists: true,
          revision: revision!,
          version: doc.version,
          savedAt: Math.round(st.mtimeMs),
          size: st.size,
          ...next,
          contentHash,
        };
        this.cache = { mtimeMs: st.mtimeMs, size: st.size, info };
        await this.sweepPdfs(referencedHashes(doc));
        return { revision: revision!, savedAt: Math.round(st.mtimeMs), hasData: next.hasData, ...(backup ? { backup } : {}) };
      }),
    );
  }

  /**
   * library.json 无法读取时，用最近一个可读的备份替换它（损坏的文件先另存为 -unreadable 备份）。
   * 优先选记录文件夹自身状态的备份（自动备份、shrink、before-overwrite），没有时再用其他备份。
   */
  async recoverFromBackup(): Promise<{ name: string; revision: number }> {
    // 目录都还没有：没有可恢复的备份（不为此建目录）
    if (!(await this.dirExists())) throw new StorageError(404, "no-backup", "没有可读的备份");
    return this.exclusive(() =>
      this.withFsLock(async () => {
        const cur = await this.libraryInfo();
        if (cur.exists && !cur.error) throw new StorageError(409, "readable", "library.json 可以正常读取，不需要从备份恢复");
        const all = (await fsp.readdir(this.backupDir).catch(() => [] as string[]))
          .map(parseBackupName)
          .filter((b): b is BackupEntry => !!b && b.reason !== "unreadable")
          .sort(newestFirst);
        const ordered = [...all.filter((b) => b.reason === null || FOLDER_STATE_REASONS.test(b.reason)), ...all.filter((b) => b.reason !== null && !FOLDER_STATE_REASONS.test(b.reason))];
        for (const b of ordered) {
          let text: string;
          let doc: Envelope;
          try {
            text = await this.readBackup(b.name);
            doc = parseEnvelope(text);
          } catch {
            continue;
          }
          if (cur.exists) await this.backupCurrent(cur, "unreadable");
          await this.atomicWrite(this.libraryPath, text);
          this.cache = null;
          const info = await this.libraryInfo();
          await this.sweepPdfs(referencedHashes(doc));
          return { name: b.name, revision: info.revision };
        }
        throw new StorageError(404, "no-backup", "没有可读的备份");
      }),
    );
  }

  // ---------- 备份 ----------

  private async readBackup(name: string): Promise<string> {
    const raw = await fsp.readFile(path.join(this.backupDir, name));
    return (name.endsWith(".gz") ? await gunzipAsync(raw) : raw).toString("utf8");
  }

  private async backupName(rev: number, reason?: string): Promise<string> {
    await fsp.mkdir(this.backupDir, { recursive: true });
    const base = `library-${stamp(this.now())}-r${rev}`;
    for (let i = 1; ; i++) {
      const name = reason ? `${base}-${reason}${i > 1 ? i : ""}.json.gz` : `${base}${i > 1 ? `-${i}` : ""}.json.gz`;
      if (!(await exists(path.join(this.backupDir, name)))) return name;
    }
  }

  private async writeBackup(name: string, raw: Buffer): Promise<void> {
    await this.atomicWrite(path.join(this.backupDir, name), await gzipAsync(raw));
    await this.prune();
  }

  /** 把当前 library.json 压缩存一份到 backups/ */
  private async backupCurrent(cur: LibraryInfo, reason?: string): Promise<string> {
    const name = await this.backupName(cur.revision, reason);
    await this.writeBackup(name, await fsp.readFile(this.libraryPath));
    return name;
  }

  private async maybeAutoBackup(cur: LibraryInfo): Promise<void> {
    const names = await fsp.readdir(this.backupDir).catch(() => [] as string[]);
    let newest = 0;
    for (const n of names) {
      const m = AUTO_BACKUP_RE.exec(n);
      if (m) newest = Math.max(newest, parseStamp(m[1], m[2]));
    }
    if (this.now().getTime() - newest >= this.opts.backupIntervalMs) await this.backupCurrent(cur);
  }

  /** 先按数量轮转，再按总大小：超过上限时从最旧的删起（至少保留最新 3 个） */
  private async prune(): Promise<void> {
    const names = await fsp.readdir(this.backupDir).catch(() => [] as string[]);
    const drop = new Set(backupsToPrune(names, this.opts.keepRecent, this.opts.keepDaily, this.opts.keepManual));
    for (const n of drop) await fsp.rm(path.join(this.backupDir, n), { force: true });
    const left = names
      .filter((n) => !drop.has(n))
      .map(parseBackupName)
      .filter((b): b is BackupEntry => !!b)
      .sort(newestFirst);
    let total = 0;
    for (let i = 0; i < left.length; i++) {
      total += (await fsp.stat(path.join(this.backupDir, left[i].name)).catch(() => null))?.size ?? 0;
      if (i >= 3 && total > this.opts.maxBackupBytes) await fsp.rm(path.join(this.backupDir, left[i].name), { force: true });
    }
  }

  /** 手动备份：body 为空时备份当前 library.json，否则把 body（另一份数据，例如浏览器中将被替换的数据）存为备份 */
  async createBackup(reason: string, body: Buffer | null): Promise<{ name: string | null }> {
    if (!REASON_RE.test(reason)) throw new StorageError(400, "invalid-reason", "备份原因只能包含小写字母、数字和连字符，并以字母开头");
    if (body && body.length) {
      const doc = parseEnvelope(body.toString("utf8"));
      return this.exclusive(async () => {
        await this.ensureRoot();
        const rev = Number.isInteger(doc.revision) ? doc.revision! : 0;
        const name = await this.backupName(rev, reason);
        await this.writeBackup(name, body);
        return { name };
      });
    }
    // 还没有 library.json：没什么可备份的（不为此建目录）
    if (!(await this.libraryInfo()).exists) return { name: null };
    return this.exclusive(() =>
      this.withFsLock(async () => {
        const cur = await this.libraryInfo();
        if (!cur.exists) return { name: null };
        return { name: await this.backupCurrent(cur, reason) };
      }),
    );
  }

  // ---------- PDF ----------

  /** pdfs/（或 trash/）中的 PDF 哈希 */
  async listPdfs(where: "pdfs" | "trash" = "pdfs"): Promise<string[]> {
    const names = await fsp.readdir(where === "pdfs" ? this.pdfDir : this.trashDir).catch(() => [] as string[]);
    const out: string[] = [];
    for (const n of names) {
      const m = PDF_NAME_RE.exec(n);
      if (m) out.push(m[1]);
    }
    return out.sort();
  }

  /** PDF 文件路径：pdfs/ 中没有时也看回收站（例如恢复了引用它的旧备份） */
  async pdfPath(hash: string): Promise<string | null> {
    if (!HASH_RE.test(hash)) throw new StorageError(400, "invalid-hash", "无效的文件哈希");
    for (const d of [this.pdfDir, this.trashDir]) {
      const p = path.join(d, `${hash}.pdf`);
      if (await exists(p)) return p;
    }
    return null;
  }

  /**
   * 流式写入 PDF，边写边算 SHA-256；与路径中的哈希不一致则丢弃。落盘后再改名。
   * 已存在且内容正确时不重写；已存在但损坏（哈希不符）时用这次上传替换。
   */
  async putPdf(hash: string, src: Readable, maxBytes: number): Promise<{ stored: boolean }> {
    if (!HASH_RE.test(hash)) throw new StorageError(400, "invalid-hash", "无效的文件哈希");
    const dest = path.join(this.pdfDir, `${hash}.pdf`);
    if ((await exists(dest)) && (await sha256File(dest).catch(() => "")) === hash) {
      src.resume();
      return { stored: false };
    }
    await this.ensureRoot();
    await fsp.mkdir(this.pdfDir, { recursive: true });
    const tmp = path.join(this.pdfDir, `.${hash}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const sha = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new StorageError(413, "too-large", "文件过大"));
        sha.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      // flush：关闭前 fsync，改名后断电也不会留下空文件
      await pipeline(src, meter, createWriteStream(tmp, { flush: true }));
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    if (size === 0 || sha.digest("hex") !== hash) {
      await fsp.rm(tmp, { force: true });
      throw new StorageError(400, "hash-mismatch", "文件内容与哈希不一致");
    }
    await this.commitTemp(tmp, dest);
    // 回收站里同哈希的副本内容完全相同，可以去掉
    await fsp.rm(path.join(this.trashDir, `${hash}.pdf`), { force: true });
    return { stored: true };
  }

  /** 不再被任何论文引用的 PDF 移到 trash/；被引用但在回收站里的移回来 */
  private async sweepPdfs(referenced: Set<string>): Promise<void> {
    for (const hash of await this.listPdfs()) {
      if (referenced.has(hash)) continue;
      await fsp.mkdir(this.trashDir, { recursive: true });
      const from = path.join(this.pdfDir, `${hash}.pdf`);
      const to = path.join(this.trashDir, `${hash}.pdf`);
      if (await exists(to)) await fsp.rm(from, { force: true });
      else await fsp.rename(from, to).catch(() => {});
    }
    const trashed = await fsp.readdir(this.trashDir).catch(() => [] as string[]);
    for (const n of trashed) {
      const m = PDF_NAME_RE.exec(n);
      if (!m || !referenced.has(m[1])) continue;
      const dest = path.join(this.pdfDir, n);
      if (await exists(dest)) continue;
      await fsp.mkdir(this.pdfDir, { recursive: true });
      await fsp.rename(path.join(this.trashDir, n), dest).catch(() => {});
    }
  }

  // ---------- 附加文件组 ----------

  /** 把用户放进来或改过的文件移到 <group>/.paperlens-replaced/<时间>/ 下（不覆盖、不删除） */
  private async setAside(groupDir: string, name: string, abs: string): Promise<void> {
    const dest = path.join(groupDir, REPLACED_DIR, stamp(this.now()), ...name.split("/"));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    let target = dest;
    for (let i = 2; await exists(target); i++) target = `${dest}.${i}`;
    await fsp.rename(abs, target);
  }

  /**
   * 写入 data/<group>/ 下的一组文件。files 中每项为 { name, content } 或 { name, sha }（客户端认为内容没变，只给 SHA-1）：
   * - 内容与清单一致的跳过（不动 mtime，方便 Obsidian 等工具同步）；只给 sha 而服务端对不上的列入 missing，等客户端带内容重发；
   * - 要覆盖或删除的文件如果不是上次写入的样子（用户放的同名文件、或生成后被编辑过），先移到 .paperlens-replaced/；
   * - 上次写入、这次没有的文件删除；清单没变就不重写清单。
   */
  async putFiles(group: string, files: unknown): Promise<FilesResult> {
    if (!GROUP_RE.test(group) || RESERVED_GROUPS.has(group)) throw new StorageError(400, "invalid-group", "无效的文件组名");
    if (!Array.isArray(files) || files.length > 50_000) throw new StorageError(400, "invalid-files", "files 必须是数组");
    const groupDir = path.join(this.dir, group);
    const entries: { name: string; abs: string; content?: string; sha: string }[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const name = isObject(f) ? f.name : undefined;
      const content = isObject(f) ? f.content : undefined;
      const givenSha = isObject(f) ? f.sha : undefined;
      const segs = validateRelativeName(name);
      const shaOnly = content === undefined && typeof givenSha === "string" && SHA1_RE.test(givenSha);
      if (!segs || (typeof content !== "string" && !shaOnly)) throw new StorageError(400, "invalid-name", `无效的文件名：${String(name).slice(0, 80)}`);
      const folded = foldName(name as string);
      // macOS / Windows 的文件系统默认不区分大小写
      if (seen.has(folded)) throw new StorageError(400, "duplicate-name", `文件名重复：${name as string}`);
      seen.add(folded);
      const abs = path.resolve(groupDir, ...segs);
      if (!abs.startsWith(groupDir + path.sep)) throw new StorageError(400, "invalid-name", "文件名超出目录范围");
      entries.push(
        typeof content === "string" ? { name: name as string, abs, content, sha: sha1(content) } : { name: name as string, abs, sha: givenSha as string },
      );
    }

    const prev = this.groupChains.get(group) ?? Promise.resolve();
    const run = prev.then(async (): Promise<FilesResult> => {
      // 只在真要写入时才确保目录存在（空的文件组不会创建任何目录）
      let rootReady = false;
      const ready = async () => {
        if (!rootReady) await this.ensureRoot();
        rootReady = true;
      };
      const manifestPath = path.join(groupDir, MANIFEST);
      let old: Record<string, string> = {};
      try {
        const m = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { files?: unknown };
        if (isObject(m.files)) old = m.files as Record<string, string>;
      } catch {
        // 没有清单或已损坏：只写不删
      }
      const diskSha = async (abs: string) => sha1(await fsp.readFile(abs));
      const res: FilesResult = { written: 0, unchanged: 0, deleted: 0, replaced: 0, missing: [] };
      const manifest: Record<string, string> = {};
      for (const e of entries) {
        const present = await exists(e.abs);
        if (e.content === undefined) {
          if (old[e.name] === e.sha && present) {
            manifest[e.name] = e.sha;
            res.unchanged++;
          } else {
            res.missing.push(e.name);
            if (old[e.name] !== undefined) manifest[e.name] = old[e.name];
          }
          continue;
        }
        manifest[e.name] = e.sha;
        if (old[e.name] === e.sha && present) {
          res.unchanged++;
          continue;
        }
        if (present) {
          const cur = await diskSha(e.abs);
          if (cur === e.sha) {
            res.unchanged++;
            continue;
          }
          if (cur !== old[e.name]) {
            await ready();
            await this.setAside(groupDir, e.name, e.abs);
            res.replaced++;
          }
        }
        await ready();
        await this.atomicWrite(e.abs, e.content, false);
        res.written++;
      }
      for (const name of Object.keys(old)) {
        if (seen.has(foldName(name))) continue;
        const segs = validateRelativeName(name);
        if (!segs) continue;
        const abs = path.resolve(groupDir, ...segs);
        if (!abs.startsWith(groupDir + path.sep) || !(await exists(abs))) continue;
        await ready();
        if ((await diskSha(abs)) === old[name]) {
          await fsp.unlink(abs);
        } else {
          await this.setAside(groupDir, name, abs);
          res.replaced++;
        }
        res.deleted++;
        // 删掉因此变空的子目录
        for (let d = path.dirname(abs); d.startsWith(groupDir + path.sep); d = path.dirname(d)) {
          if ((await fsp.readdir(d).catch(() => ["x"])).length) break;
          await fsp.rmdir(d).catch(() => {});
        }
      }
      const same = Object.keys(manifest).length === Object.keys(old).length && Object.entries(manifest).every(([k, v]) => old[k] === v);
      if (!same) {
        await ready();
        const doc = { note: "由 Paperloom 自动生成：记录上次写入的文件，用于清理旧文件", files: manifest };
        await this.atomicWrite(manifestPath, JSON.stringify(doc, null, 1), false);
      }
      return res;
    });
    this.groupChains.set(
      group,
      run.catch(() => {}),
    );
    return run;
  }

  // ---------- 占用空间 ----------

  async usage(): Promise<StorageUsage> {
    const library = (await fsp.stat(this.libraryPath).catch(() => null))?.size ?? 0;
    const [pdfs, backups, trash] = await Promise.all([dirSize(this.pdfDir), dirSize(this.backupDir), dirSize(this.trashDir)]);
    const groups: Record<string, number> = {};
    const entries = await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && GROUP_RE.test(e.name) && !RESERVED_GROUPS.has(e.name)) groups[e.name] = await dirSize(path.join(this.dir, e.name));
    }
    const total = library + pdfs + backups + trash + Object.values(groups).reduce((a, b) => a + b, 0);
    return { library, pdfs, backups, trash, groups, total };
  }
}
