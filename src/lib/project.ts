// 项目（notebook）：每个项目是一套完全独立的数据——自己的 IndexedDB、自己的 data/projects/<id>/（见 docs/decisions.md D10）。
// 当前项目在页面启动时确定一次（main.tsx → services/projects.ts 的 bootProject），切换项目就是带 ?project=<id> 重新加载页面，
// 所以各模块可以在加载时读取 currentProjectId()，运行中不会变。
// Worker 读不到页面的 URL：创建 Worker 时把项目放进 Worker 名（workerName），Worker 里的 currentProjectId() 从 self.name 解析。
import { t } from "@/i18n";

export const DEFAULT_PROJECT_ID = "default";
/** 默认项目存进登记表的名字（"我的项目"，必须与 server/projects.ts 一致）。这是数据不是界面文字，显示时用 projectDisplayName */
export const DEFAULT_PROJECT_NAME = "我的项目"; // i18n-ignore: 数据里的默认项目名（服务端登记表也用它），显示时经 projectDisplayName 翻译
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/**
 * 显示用的项目名（页面标题、项目切换器、项目管理等所有显示项目名的地方都用它）：
 * 默认项目还叫原始的默认名时显示当前语言的默认名，重命名过的显示真实名字。不改登记表里存的值。
 */
export function projectDisplayName(p: { id: string; name: string }): string {
  return p.id === DEFAULT_PROJECT_ID && p.name === DEFAULT_PROJECT_NAME ? t.library.projects.defaultName : p.name;
}

/** 本浏览器上次打开的项目（所有项目共用一个键） */
export const LAST_PROJECT_KEY = "paperlens.lastProject";

export function isProjectId(v: unknown): v is string {
  return typeof v === "string" && PROJECT_ID_RE.test(v);
}

/** IndexedDB 数据库名：default 沿用原来的 "paperlens"（迁移前浏览器里的数据直接可用） */
export function dbNameFor(id: string): string {
  return id === DEFAULT_PROJECT_ID ? "paperlens" : `paperlens-p-${id}`;
}

const WORKER_SEP = "@";

/** 带项目的 Worker 名，如 "paperlens-storage@default" */
export function workerName(kind: string, id = currentProjectId()): string {
  return `${kind}${WORKER_SEP}${id}`;
}

export function projectIdFromWorkerName(name: string | undefined): string | null {
  if (!name) return null;
  const i = name.lastIndexOf(WORKER_SEP);
  const id = i >= 0 ? name.slice(i + 1) : "";
  return isProjectId(id) ? id : null;
}

function inWorker(): boolean {
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined";
}

let current: string | null = null;

/** 页面启动时调用一次（在加载任何用到数据库的模块之前） */
export function setCurrentProjectId(id: string): void {
  if (!isProjectId(id)) throw new Error(`Invalid project id: ${id}`);
  if (current !== null && current !== id) throw new Error(`Current project is already ${current}, can't change it to ${id} (switching projects requires a page reload)`);
  current = id;
}

export function currentProjectId(): string {
  if (current !== null) return current;
  if (inWorker()) {
    const name = (globalThis as { name?: string }).name;
    const id = projectIdFromWorkerName(name);
    // 不能悄悄退回 default：那会把另一个项目的数据写进 default 的数据库
    if (!id) throw new Error(`No project id in worker name "${name ?? ""}"`);
    current = id;
    return id;
  }
  // 页面上 main.tsx 已经设置过；单元测试等其他场景按 URL，缺省 default
  const fromUrl = typeof location !== "undefined" ? new URLSearchParams(location.search).get("project") : null;
  current = isProjectId(fromUrl) ? fromUrl : DEFAULT_PROJECT_ID;
  return current;
}

/**
 * 按项目区分的 localStorage 键：default 沿用原来的键（迁移前的同步记录、界面偏好继续有效），其他项目加 "@<id>"。
 */
export function projectKey(base: string, id = currentProjectId()): string {
  return id === DEFAULT_PROJECT_ID ? base : `${base}${WORKER_SEP}${id}`;
}

/** 某个项目在 localStorage 里的键都以这个结尾（default 除外，它用不带后缀的原键） */
export function projectKeySuffix(id: string): string {
  return `${WORKER_SEP}${id}`;
}

/** navigator.locks 与 BroadcastChannel 的名字：所有项目（含 default）都带后缀，不同项目的标签页各自选负责的标签页 */
export function projectScoped(base: string, id = currentProjectId()): string {
  return `${base}:${id}`;
}

/** 本地存储服务里这个项目的接口前缀（与 server/storageHandler.ts 的 projectApiPrefix 一致） */
export function projectApiBase(id = currentProjectId()): string {
  return `/__paperlens/p/${id}/storage`;
}

/** 打开某个项目的页面地址（保留当前路径，查询串只留 project） */
export function projectUrl(id: string): string {
  const path = typeof location !== "undefined" ? location.pathname : "/";
  return `${path}?project=${encodeURIComponent(id)}`;
}

/** 每个打开的标签页对自己的项目持有这个共享锁，删除项目前据此判断是否有标签页正打开着它 */
export function openLockName(id: string): string {
  return projectScoped("paperlens-open", id);
}
