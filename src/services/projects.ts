// 项目（notebook）：启动时确定当前项目、项目列表的读取与增删改（见 docs/decisions.md D10）。
// 有本地服务时以 data/projects.json 为准（同时在 localStorage 留一份，服务不在时还能列出）；
// 没有本地服务时项目列表只存在本浏览器的 localStorage 里（只是没有文件夹镜像）。
// 本模块在 main.tsx 里先于数据库加载：不能导入 db/schema 及依赖它的模块。
import { currentProject, useProjectsStore, type ProjectInfo } from "@/app/stores/projects";
import {
  dbNameFor,
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  isProjectId,
  LAST_PROJECT_KEY,
  openLockName,
  projectKey,
  projectKeySuffix,
  projectUrl,
  setCurrentProjectId,
} from "@/lib/project";
import { StorageApiError } from "@/services/storage/api";

const PROJECTS_API = "/__paperlens/projects";
/** 本浏览器记下的项目列表 */
const LOCAL_LIST_KEY = "paperlens.projects";
/** 项目列表变化时通知同源的其他标签页（所有项目共用一个频道） */
const CHANNEL_NAME = "paperlens-projects";
const NAME_MAX = 60;

/**
 * 各模块存在 localStorage 里、按项目区分的键（见 syncState.ts、stores/library.ts、glossary.ts、canvas.ts）。
 * 删除项目时一并清掉；非 default 项目另外清掉所有以 "@<id>" 结尾的键。
 */
const PROJECT_LOCAL_KEYS = ["paperlens:storage:sync", "paperlens:storage:dbInstance", "paperlens.library", "paperlens.glossary", "paperlens.canvas"];

export interface ProjectListResponse {
  needsMigration: boolean;
  projects: ProjectInfo[];
  dataDir: string;
  dataDirLabel: string;
}

/** 读取项目列表的结果：ok 拿到了；none 没有本地服务；error 本地服务在但列表读不了（projects.json 损坏、没有响应） */
export type ProjectListResult = ({ kind: "ok" } & ProjectListResponse) | { kind: "none" } | { kind: "error"; message: string };

// ---------- 本地服务 ----------

async function fail(res: Response): Promise<never> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // 不是 JSON
  }
  const message = typeof body.message === "string" ? body.message : `本地服务返回 ${res.status}`;
  throw new StorageApiError(res.status, typeof body.error === "string" ? body.error : "http", message, body);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${PROJECTS_API}${path}`, {
    cache: "no-store",
    ...init,
    headers: { "X-PaperLens": "1", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

function isInfo(v: unknown): v is ProjectInfo {
  const p = v as ProjectInfo | null;
  return !!p && isProjectId(p.id) && typeof p.name === "string";
}

/** 读取项目列表 */
export async function fetchProjectList(timeoutMs = 5000): Promise<ProjectListResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(PROJECTS_API, { headers: { "X-PaperLens": "1" }, cache: "no-store", signal: ctrl.signal });
    const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
    // 没有服务时开发服务器返回 index.html（单页应用回退）或 404
    if (!isJson) return { kind: "none" };
    const body = (await res.json().catch(() => null)) as (Partial<ProjectListResponse> & { service?: string; message?: string; error?: string }) | null;
    if (!res.ok) {
      if (res.status === 404 && body?.service !== "paperlens-storage" && !body?.error) return { kind: "none" };
      return { kind: "error", message: body?.message ?? `本地服务返回 ${res.status}` };
    }
    if (!body || body.service !== "paperlens-storage" || !Array.isArray(body.projects)) return { kind: "none" };
    return {
      kind: "ok",
      needsMigration: !!body.needsMigration,
      projects: body.projects.filter(isInfo),
      dataDir: String(body.dataDir ?? ""),
      dataDirLabel: String(body.dataDirLabel ?? "data/"),
    };
  } catch {
    // 超时：服务在但没有响应；其他网络错误按没有服务处理
    return ctrl.signal.aborted ? { kind: "error", message: "本地服务没有响应" } : { kind: "none" };
  } finally {
    clearTimeout(t);
  }
}

// ---------- 本浏览器里的列表 ----------

const defaultEntry = (): ProjectInfo => ({ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME, createdAt: 0, updatedAt: 0 });

export function loadLocalList(): ProjectInfo[] {
  let list: ProjectInfo[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_LIST_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) list = raw.filter(isInfo);
  } catch {
    // 不可用或已损坏
  }
  // 从没用过项目的浏览器：只有 default
  return list.length ? list : [defaultEntry()];
}

function saveLocalList(list: ProjectInfo[]): void {
  try {
    localStorage.setItem(LOCAL_LIST_KEY, JSON.stringify(list));
  } catch {
    // 忽略
  }
}

/** 名字里的英文字母和数字作为 id 的前半部分，后面接随机串（与 server/projects.ts 的 generateProjectId 一致） */
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
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join("");
    const id = slug ? `${slug}-${rand.slice(0, 4)}` : `p-${rand}`;
    if (isProjectId(id) && !taken.has(id) && id !== DEFAULT_PROJECT_ID) return id;
  }
}

export function validateProjectName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error("请输入项目名称");
  if ([...n].length > NAME_MAX) throw new Error(`项目名称最多 ${NAME_MAX} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(n)) throw new Error("项目名称不能包含控制字符");
  return n;
}

// ---------- 列表同步 ----------

let channel: BroadcastChannel | null = null;

function broadcastChanged(): void {
  channel?.postMessage({ type: "changed" });
}

/**
 * 有服务时：没有本地服务时建的项目（localOnly）登记到服务上（带着原来的 id，这样浏览器里的数据库对得上），
 * 然后以服务的列表为准；登记失败的仍留在列表里，标为仅本浏览器。
 */
async function mergeServerList(server: ProjectInfo[]): Promise<ProjectInfo[]> {
  const local = loadLocalList();
  const ids = new Set(server.map((p) => p.id));
  const out = [...server];
  let refetch = false;
  const pending: ProjectInfo[] = [];
  for (const p of local) {
    if (!p.localOnly || ids.has(p.id)) continue;
    try {
      const r = await call<{ project: ProjectInfo }>("", { method: "POST", body: JSON.stringify({ id: p.id, name: p.name }) });
      out.push(r.project);
    } catch (e) {
      // 409：可能是另一个标签页刚登记过同一个项目，重新取一次列表确认；不在列表里就仍留在本地
      if (e instanceof StorageApiError && e.code === "exists") refetch = true;
      pending.push(p);
    }
  }
  if (refetch) {
    const again = await fetchProjectList();
    if (again.kind === "ok") {
      for (const p of again.projects) if (!out.some((x) => x.id === p.id)) out.push(p);
    }
  }
  for (const p of pending) if (!out.some((x) => x.id === p.id)) out.push(p);
  saveLocalList(out);
  return out;
}

/** 重新读取项目列表（其他标签页增删改之后） */
export async function refreshProjects(): Promise<void> {
  const st = useProjectsStore.getState();
  if (st.source === "server") {
    const r = await fetchProjectList();
    if (r.kind !== "ok" || r.needsMigration) return;
    useProjectsStore.setState({ projects: await mergeServerList(r.projects) });
  } else if (st.source === "local") {
    useProjectsStore.setState({ projects: loadLocalList() });
  }
}

// ---------- 启动 ----------

export type BootResult = { kind: "ok"; projectId: string } | { kind: "not-found"; requested: string; projects: ProjectInfo[]; needsMigration: boolean };

/**
 * 页面启动时确定当前项目：URL 的 ?project= > 本浏览器上次打开的 > 列表里的第一个 > default。
 * URL 里没有时用 history.replaceState 补上。必须在加载任何用到数据库的模块之前调用。
 */
export async function bootProject(): Promise<BootResult> {
  const server = await fetchProjectList();
  let projects: ProjectInfo[];
  const needsMigration = server.kind === "ok" && server.needsMigration;
  const source = server.kind === "ok" ? "server" : server.kind === "error" ? "error" : "local";
  if (server.kind === "ok" && !needsMigration) projects = await mergeServerList(server.projects);
  else if (server.kind === "ok") projects = [defaultEntry()]; // 旧版目录：只有原来的数据（default）
  else projects = loadLocalList(); // 没有服务，或服务的列表读不了：先用本浏览器记下的
  if (!projects.length) projects = [defaultEntry()];

  const url = new URL(location.href);
  const requested = url.searchParams.get("project");
  let id: string;
  if (requested !== null) {
    // 列表读不了时无法确认，信任 URL（不在本浏览器的列表里也打开）
    const known = projects.some((p) => p.id === requested) || (source === "error" && isProjectId(requested));
    if (!isProjectId(requested) || !known) return { kind: "not-found", requested, projects, needsMigration };
    id = requested;
  } else {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      // 忽略
    }
    id = last && projects.some((p) => p.id === last) ? last : projects[0].id;
  }

  setCurrentProjectId(id);
  if (requested !== id) {
    url.searchParams.set("project", id);
    history.replaceState(history.state, "", url);
  }
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // 忽略
  }
  useProjectsStore.setState({ currentId: id, projects, source, needsMigration, error: server.kind === "error" ? server.message : null });

  // 标签页标题带项目名，多个标签页好区分
  const setTitle = () => {
    document.title = `${currentProject(useProjectsStore.getState()).name} · Paperloom`;
  };
  setTitle();
  useProjectsStore.subscribe(setTitle);

  holdOpenLock(id);
  if (source === "server" && !needsMigration) startPresence(id);
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => void refreshProjects();
  }
  return { kind: "ok", projectId: id };
}

/**
 * 向本地服务报告"本页面正打开着这个项目"（心跳），页面关闭时撤销。服务端据此拒绝删除别的地址（如 127.0.0.1）
 * 或别的浏览器正打开着的项目——那些页面不在本源的 navigator.locks 里。
 */
const PRESENCE_INTERVAL_MS = 20_000;
function startPresence(id: string): void {
  const client = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const url = `/__paperlens/p/${id}/presence`;
  const send = (method: "POST" | "DELETE", keepalive = false) =>
    void fetch(url, { method, keepalive, cache: "no-store", headers: { "X-PaperLens": "1", "X-PaperLens-Client": client } }).catch(() => {});
  send("POST");
  setInterval(() => send("POST"), PRESENCE_INTERVAL_MS);
  window.addEventListener("pagehide", () => send("DELETE", true));
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) send("POST");
  });
}

/** 本标签页打开着这个项目：持有共享锁直到标签页关闭（删除项目前据此判断） */
function holdOpenLock(id: string): void {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return;
  void locks.request(openLockName(id), { mode: "shared" }, () => new Promise<void>(() => {})).catch(() => {});
}

/** 是否有（别的）标签页正打开着这个项目 */
export async function isProjectOpenElsewhere(id: string): Promise<boolean> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.query) return false;
  const snap = await locks.query();
  const name = openLockName(id);
  return [...(snap.held ?? []), ...(snap.pending ?? [])].some((l) => l.name === name);
}

// ---------- 增删改 ----------

/** 项目列表读不了时不做只改本浏览器副本的操作（之后服务恢复时两边会对不上） */
function assertListAvailable(): void {
  const st = useProjectsStore.getState();
  if (st.source === "error") throw new Error(`本地服务的项目列表暂时无法读取（${st.error ?? "未知错误"}），请先解决后刷新页面`);
  if (st.needsMigration) throw new Error("数据需要先迁移到项目结构");
}

export async function createProject(name: string): Promise<ProjectInfo> {
  const n = validateProjectName(name);
  assertListAvailable();
  const st = useProjectsStore.getState();
  let entry: ProjectInfo;
  if (st.source === "server") {
    entry = (await call<{ project: ProjectInfo }>("", { method: "POST", body: JSON.stringify({ name: n }) })).project;
    useProjectsStore.setState({ projects: [...st.projects.filter((p) => p.id !== entry.id), entry] });
    saveLocalList(useProjectsStore.getState().projects);
  } else {
    const list = loadLocalList();
    const t = Date.now();
    entry = { id: generateProjectId(n, new Set(list.map((p) => p.id))), name: n, createdAt: t, updatedAt: t, localOnly: true };
    saveLocalList([...list, entry]);
    useProjectsStore.setState({ projects: loadLocalList() });
  }
  broadcastChanged();
  return entry;
}

export async function renameProject(id: string, name: string): Promise<ProjectInfo> {
  const n = validateProjectName(name);
  assertListAvailable();
  const st = useProjectsStore.getState();
  const cur = st.projects.find((p) => p.id === id);
  if (!cur) throw new Error("没有这个项目");
  let entry: ProjectInfo;
  if (st.source === "server" && !cur.localOnly) {
    entry = (await call<{ project: ProjectInfo }>(`/${id}`, { method: "PATCH", body: JSON.stringify({ name: n }) })).project;
  } else {
    entry = { ...cur, name: n, updatedAt: Date.now() };
  }
  const projects = st.projects.map((p) => (p.id === id ? entry : p));
  useProjectsStore.setState({ projects });
  saveLocalList(st.source === "server" ? projects : loadLocalList().map((p) => (p.id === id ? entry : p)));
  broadcastChanged();
  return entry;
}

export interface DeleteResult {
  /** 文件夹被移到的位置（相对 data/）；没有动文件夹时为 null */
  trashedTo: string | null;
  /** 本浏览器里的数据库：deleted 已删除；kept 保留；blocked 仍被占用（未删除）；failed 删除失败 */
  browserData: "deleted" | "kept" | "blocked" | "failed";
  /** 只在本浏览器里的项目：删除前下载的 JSON 备份文件名 */
  exportedAs?: string | null;
  /** 没有本地服务时只从本浏览器的列表里移除了（文件夹和数据库都保留） */
  listOnly?: boolean;
}

export class ProjectInUseError extends Error {
  override name = "ProjectInUseError";
}

/** 本浏览器里有这个项目尚未保存到文件夹的内容：不能连同浏览器里的数据库一起删除 */
export class ProjectUnsyncedError extends Error {
  override name = "ProjectUnsyncedError";
}

/** 删除本浏览器里某个项目的 IndexedDB（尽力而为：被占用时最多等 3 秒） */
function deleteBrowserDb(id: string): Promise<DeleteResult["browserData"]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: DeleteResult["browserData"]) => {
      if (!done) resolve(r);
      done = true;
    };
    try {
      const req = indexedDB.deleteDatabase(dbNameFor(id));
      req.onsuccess = () => finish("deleted");
      req.onerror = () => finish("failed");
      req.onblocked = () => setTimeout(() => finish("blocked"), 3000);
    } catch {
      finish("failed");
    }
  });
}

function clearProjectLocalKeys(id: string): void {
  try {
    for (const base of PROJECT_LOCAL_KEYS) localStorage.removeItem(projectKey(base, id));
    if (id !== DEFAULT_PROJECT_ID) {
      const suffix = projectKeySuffix(id);
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("paperlens") && k.endsWith(suffix)) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    }
    if (localStorage.getItem(LAST_PROJECT_KEY) === id) localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // 忽略
  }
}

/**
 * 删除项目（不能是当前项目）。原则：本浏览器里的副本绝不会是被删掉的唯一一份。
 * - 有本地服务：先确认本浏览器里的数据已完整地在它的文件夹里（否则拒绝，除非 keepBrowserData：只删文件夹、保留浏览器里的数据库），
 *   再把文件夹移到 data/trash/projects/（服务端还会拒绝删除别的地址或浏览器正打开着的项目），最后删掉浏览器里的数据库。
 * - 没有本地服务、项目在文件夹里登记过：只从本浏览器的列表移除，文件夹和数据库都不动。
 * - 只在本浏览器里的项目：先下载一份 JSON 备份，再删除浏览器里的数据库。
 * 本源的其他标签页正打开着它时拒绝（那些标签页还会继续写它的数据库）。
 */
export async function deleteProject(id: string, opts: { keepBrowserData?: boolean } = {}): Promise<DeleteResult> {
  assertListAvailable();
  const st = useProjectsStore.getState();
  if (id === st.currentId) throw new Error("不能删除当前打开的项目");
  const entry = st.projects.find((p) => p.id === id);
  if (!entry) throw new Error("没有这个项目");
  if (st.projects.length <= 1) throw new Error("不能删除最后一个项目");
  if (await isProjectOpenElsewhere(id)) throw new ProjectInUseError(`「${entry.name}」正在其他标签页中打开，请先关闭那些标签页再删除`);
  const data = await import("./projectData");
  let result: DeleteResult;
  if (st.source === "server" && !entry.localOnly) {
    if (!opts.keepBrowserData) {
      const c = await data.browserCopyState(id);
      if (c.state === "unsynced") {
        throw new ProjectUnsyncedError(`「${entry.name}」在本浏览器中有尚未保存到文件夹的内容（${c.detail}），删除会丢失它们。请先打开它，等左下角显示"已保存"后再删除。`);
      }
    }
    const trashedTo = (await call<{ trashedTo: string }>(`/${id}`, { method: "DELETE" })).trashedTo || null;
    result = { trashedTo, browserData: opts.keepBrowserData ? "kept" : await deleteBrowserDb(id) };
  } else if (!entry.localOnly) {
    result = { trashedTo: null, browserData: "kept", listOnly: true };
  } else {
    const exportedAs = await data.exportBrowserCopy(id, entry.name);
    result = { trashedTo: null, browserData: await deleteBrowserDb(id), exportedAs };
  }
  if (result.browserData === "deleted") clearProjectLocalKeys(id);
  const projects = useProjectsStore.getState().projects.filter((p) => p.id !== id);
  useProjectsStore.setState({ projects });
  saveLocalList(st.source === "server" ? projects : loadLocalList().filter((p) => p.id !== id));
  broadcastChanged();
  return result;
}

export function openProjectInNewTab(id: string): void {
  window.open(projectUrl(id), "_blank", "noopener");
}
