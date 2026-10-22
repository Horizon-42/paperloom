// 本地存储服务的 HTTP 接口（connect 中间件，挂在 Vite 开发/预览服务器上）。
//
// 路由（都在 /__paperlens 下）：
//   GET    /__paperlens/projects                 项目列表（旧版目录时 needsMigration: true）
//   POST   /__paperlens/projects                 新建项目 { name, id? }
//   PATCH  /__paperlens/projects/<id>            重命名 { name }
//   DELETE /__paperlens/projects/<id>            删除（目录移到 data/trash/projects/）
//   *      /__paperlens/p/<id>/storage/...       一个项目的数据（status、library、pdfs、files、backups、usage）
//   POST/DELETE /__paperlens/p/<id>/presence     页面心跳：正打开着这个项目（X-PaperLens-Client 为页面标识），删除项目前据此判断
//   *      /__paperlens/storage/...              旧版（不分项目）的接口：一律 410，旧页面的写入失败而不是写错地方
//
// 安全：其他网站也能向 localhost 发请求，所以每个请求都要满足——
//   1. 来自回环地址（即使用 --host 启动，局域网也访问不到这些接口）；
//   2. Host 是回环主机名且端口与本服务一致（防 DNS 重绑定）；
//   3. 有 Origin 时必须与 Host 同源；Sec-Fetch-Site 只接受 same-origin / none；
//   4. 带自定义请求头 X-PaperLens: 1（跨源请求因此必须先发预检，而预检一律拒绝）；
//   5. 路径参数严格白名单（哈希 64 位小写十六进制、组名、备份原因），请求体有大小上限。
// 另外 createDataDirGuard 阻止 Vite 把 data/ 当作静态文件直接返回。
import { createReadStream, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import { CLIENT_ID_RE, MIGRATION_BACKUP_PREFIX, PROJECT_ID_RE, ProjectRegistry } from "./projects.ts";
import { DataStore, HASH_RE, StorageError } from "./storageFs.ts";

/** 本服务的全部接口都在这个前缀下 */
export const API_ROOT = "/__paperlens";
export const PROJECTS_PREFIX = `${API_ROOT}/projects`;
/** 旧版不分项目的接口前缀：已停用 */
export const LEGACY_PREFIX = `${API_ROOT}/storage`;
export const API_VERSION = 2;

/** 一个项目的存储接口前缀 */
export function projectApiPrefix(id: string): string {
  return `${API_ROOT}/p/${id}/storage`;
}

export interface StorageLimits {
  /** library.json、备份、附加文件组等 JSON 请求体上限 */
  maxJsonBytes: number;
  maxPdfBytes: number;
}

export const DEFAULT_LIMITS: StorageLimits = {
  maxJsonBytes: 256 * 1024 * 1024,
  maxPdfBytes: 1024 * 1024 * 1024,
};

type Next = (err?: unknown) => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

// ---------- 请求检查（纯函数，便于单元测试） ----------

export interface RequestFacts {
  method: string;
  remoteAddress: string | undefined;
  localPort: number | undefined;
  headers: IncomingHttpHeaders;
}

export interface Rejection {
  status: number;
  code: string;
  message: string;
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Host 头：回环主机名，端口与本服务一致（无端口时视为 80） */
export function isLoopbackHost(host: string | undefined, localPort: number | undefined): boolean {
  if (!host) return false;
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+))(?::(\d{1,5}))?$/.exec(host);
  if (!m) return false;
  const name = (m[1] ?? m[2]).toLowerCase();
  const loopback = name === "localhost" || (m[1] !== undefined && isLoopbackAddress(name)) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
  if (!loopback) return false;
  if (localPort === undefined) return true;
  return (m[3] !== undefined ? Number(m[3]) : 80) === localPort;
}

function sameOrigin(origin: string, host: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

const header = (h: IncomingHttpHeaders, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** 不满足安全要求时返回拒绝原因 */
export function checkRequest(f: RequestFacts): Rejection | null {
  if (!isLoopbackAddress(f.remoteAddress)) return { status: 403, code: "not-loopback", message: "只接受本机请求" };
  // 不回应 CORS 预检：跨源页面带自定义头的请求因此根本发不出来
  if (f.method === "OPTIONS") return { status: 403, code: "preflight", message: "不支持跨源访问" };
  const host = header(f.headers, "host");
  if (!isLoopbackHost(host, f.localPort)) return { status: 403, code: "bad-host", message: "Host 不是本机地址" };
  const origin = header(f.headers, "origin");
  if (origin !== undefined && !sameOrigin(origin, host!)) return { status: 403, code: "bad-origin", message: "不接受其他网站的请求" };
  const site = header(f.headers, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") return { status: 403, code: "cross-site", message: "不接受其他网站的请求" };
  if (header(f.headers, "x-paperlens") !== "1") return { status: 403, code: "missing-header", message: "缺少 X-PaperLens 请求头" };
  return null;
}

// ---------- 响应 ----------

function baseHeaders(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  baseHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, e: unknown) {
  if (e instanceof StorageError) {
    sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra });
    return;
  }
  console.error("[paperlens-storage]", e);
  sendJson(res, 500, { error: "internal", message: e instanceof Error ? e.message : String(e) });
}

/** 读取请求体，超过上限时拒绝（不再继续接收） */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(header(req.headers, "content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      reject(new StorageError(413, "too-large", "请求体过大"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.pause();
        reject(new StorageError(413, "too-large", "请求体过大"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function parseJsonBody(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new StorageError(400, "invalid-json", "不是有效的 JSON");
  }
}

function streamFile(res: ServerResponse, stream: Readable) {
  stream.on("error", (e) => sendError(res, e));
  stream.pipe(res);
}

// ---------- 路由 ----------

export interface StorageHandlerOptions {
  registry: ProjectRegistry;
  limits?: Partial<StorageLimits>;
  /** 界面上显示的数据根目录，如 "data/"（缺省为绝对路径） */
  dataDirLabel?: string;
}

const PROJECT_ROUTE = new RegExp(`^${API_ROOT}/p/([^/]*)/storage(/.*)?$`);
const PRESENCE_ROUTE = new RegExp(`^${API_ROOT}/p/([^/]*)/presence$`);
const PROJECT_ITEM_ROUTE = new RegExp(`^${PROJECTS_PREFIX}/([^/]*)$`);
const PDF_ROUTE = /^\/pdfs\/([^/]*)$/;
const FILES_ROUTE = /^\/files\/([^/]*)$/;
/** 项目列表、新建、重命名的请求体很小 */
const SMALL_JSON_BYTES = 16 * 1024;

const EMPTY_LIBRARY = { exists: false, revision: 0, version: null, savedAt: null, size: 0, counts: null, hasData: false, contentHash: null };

export function createStorageHandler(opts: StorageHandlerOptions): Middleware {
  const { registry } = opts;
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const rootLabel = opts.dataDirLabel ?? `${registry.dir}/`;

  async function handle(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams) {
    const method = req.method ?? "GET";

    if (pathname === LEGACY_PREFIX || pathname.startsWith(`${LEGACY_PREFIX}/`)) {
      throw new StorageError(410, "gone", "这个接口已停用（数据已按项目存放）：请刷新页面");
    }

    if (pathname === PROJECTS_PREFIX) {
      if (method === "GET") {
        const list = await registry.list();
        sendJson(res, 200, { service: "paperlens-storage", apiVersion: API_VERSION, dataDir: registry.dir, dataDirLabel: rootLabel, ...list });
        return;
      }
      if (method === "POST") {
        const body = parseJsonBody(await readBody(req, SMALL_JSON_BYTES)) as { name?: unknown; id?: unknown } | null;
        sendJson(res, 200, { project: await registry.create(body?.name, body?.id) });
        return;
      }
      throw new StorageError(405, "method", "不支持的方法");
    }

    const item = PROJECT_ITEM_ROUTE.exec(pathname);
    if (item) {
      const id = item[1];
      if (!PROJECT_ID_RE.test(id)) throw new StorageError(404, "unknown-project", "没有这个项目");
      if (method === "PATCH") {
        const body = parseJsonBody(await readBody(req, SMALL_JSON_BYTES)) as { name?: unknown } | null;
        sendJson(res, 200, { project: await registry.rename(id, body?.name) });
        return;
      }
      if (method === "DELETE") {
        sendJson(res, 200, await registry.remove(id));
        return;
      }
      throw new StorageError(405, "method", "不支持的方法");
    }

    const presence = PRESENCE_ROUTE.exec(pathname);
    if (presence) {
      const id = presence[1];
      const client = header(req.headers, "x-paperlens-client") ?? "";
      if (!PROJECT_ID_RE.test(id)) throw new StorageError(404, "unknown-project", "没有这个项目");
      if (!CLIENT_ID_RE.test(client)) throw new StorageError(400, "invalid-client", "缺少有效的 X-PaperLens-Client");
      if (method === "POST") await registry.touch(id, client);
      else if (method === "DELETE") registry.leave(id, client);
      else throw new StorageError(405, "method", "不支持的方法");
      sendJson(res, 200, { ok: true });
      return;
    }

    const scoped = PROJECT_ROUTE.exec(pathname);
    if (!scoped) throw new StorageError(404, "not-found", "没有这个接口");
    const id = scoped[1];
    const route = scoped[2] ?? "";
    if (!PROJECT_ID_RE.test(id)) throw new StorageError(404, "unknown-project", "没有这个项目");

    if (route === "/status" && method === "GET") {
      // 旧版目录：告诉前端需要迁移（其他接口一律拒绝）
      const layout = await registry.layout();
      if (layout.kind === "legacy") {
        sendJson(res, 200, {
          service: "paperlens-storage",
          apiVersion: API_VERSION,
          needsMigration: true,
          dataRoot: registry.dir,
          dataDir: registry.dir,
          dataDirLabel: rootLabel,
          library: EMPTY_LIBRARY,
          pdfCount: 0,
        });
        return;
      }
    }

    const { entry, store, release } = await registry.open(id);
    try {
      await handleProject(req, res, method, route, query, store, entry);
    } finally {
      release();
    }
  }

  async function handleProject(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    route: string,
    query: URLSearchParams,
    store: DataStore,
    entry: { id: string; name: string },
  ) {
    if (route === "/status") {
      if (method !== "GET") throw new StorageError(405, "method", "不支持的方法");
      const [library, pdfs, strays] = await Promise.all([store.libraryInfo(), store.listPdfs(), registry.strayLegacyEntries()]);
      sendJson(res, 200, {
        service: "paperlens-storage",
        apiVersion: API_VERSION,
        needsMigration: false,
        // 迁移后根目录下又出现的旧版文件（例如又运行过旧版本）：前端提示
        strayLegacyFiles: strays,
        project: { id: entry.id, name: entry.name },
        dataRoot: registry.dir,
        dataDir: store.dir,
        dataDirLabel: `${rootLabel.replace(/\/+$/, "")}/projects/${entry.id}/`,
        library,
        pdfCount: pdfs.length,
      });
      return;
    }

    if (route === "/library") {
      if (method === "GET") {
        const lib = await store.openLibrary();
        if (!lib) throw new StorageError(404, "not-found", "还没有 library.json");
        baseHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("X-PaperLens-Revision", String(lib.info.revision));
        streamFile(res, lib.stream);
        return;
      }
      if (method === "PUT") {
        const base = header(req.headers, "x-paperlens-base-revision");
        if (base === undefined || !/^\d{1,15}$/.test(base)) throw new StorageError(400, "invalid-revision", "缺少 X-PaperLens-Base-Revision");
        const overwriteUnreadable = header(req.headers, "x-paperlens-overwrite-unreadable") === "1";
        const body = await readBody(req, limits.maxJsonBytes);
        sendJson(res, 200, await store.putLibrary(body, Number(base), { overwriteUnreadable }));
        return;
      }
      throw new StorageError(405, "method", "不支持的方法");
    }

    if (route === "/library/recover") {
      if (method !== "POST") throw new StorageError(405, "method", "不支持的方法");
      sendJson(res, 200, await store.recoverFromBackup());
      return;
    }

    if (route === "/usage") {
      if (method !== "GET") throw new StorageError(405, "method", "不支持的方法");
      sendJson(res, 200, await store.usage());
      return;
    }

    if (route === "/backups") {
      if (method !== "POST") throw new StorageError(405, "method", "不支持的方法");
      const reason = query.get("reason") ?? "manual";
      const body = await readBody(req, limits.maxJsonBytes);
      sendJson(res, 200, await store.createBackup(reason, body.length ? body : null));
      return;
    }

    if (route === "/pdfs") {
      if (method !== "GET") throw new StorageError(405, "method", "不支持的方法");
      const [hashes, trashed] = await Promise.all([store.listPdfs(), store.listPdfs("trash")]);
      sendJson(res, 200, { hashes, trashed });
      return;
    }

    const pdf = PDF_ROUTE.exec(route);
    if (pdf) {
      const hash = pdf[1];
      if (!HASH_RE.test(hash)) throw new StorageError(400, "invalid-hash", "无效的文件哈希");
      if (method === "GET") {
        const p = await store.pdfPath(hash);
        if (!p) throw new StorageError(404, "not-found", "没有这个 PDF 文件");
        const st = await stat(p);
        baseHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Length", String(st.size));
        streamFile(res, createReadStream(p));
        return;
      }
      if (method === "PUT") {
        const declared = Number(header(req.headers, "content-length"));
        if (Number.isFinite(declared) && declared > limits.maxPdfBytes) throw new StorageError(413, "too-large", "文件过大");
        sendJson(res, 200, await store.putPdf(hash, req, limits.maxPdfBytes));
        return;
      }
      throw new StorageError(405, "method", "不支持的方法");
    }

    const files = FILES_ROUTE.exec(route);
    if (files) {
      if (method !== "PUT") throw new StorageError(405, "method", "不支持的方法");
      const body = parseJsonBody(await readBody(req, limits.maxJsonBytes)) as { files?: unknown } | null;
      sendJson(res, 200, await store.putFiles(files[1], body?.files));
      return;
    }

    throw new StorageError(404, "not-found", "没有这个接口");
  }

  return (req, res, next) => {
    const raw = req.url ?? "/";
    const q = raw.indexOf("?");
    // 不解码、不规范化：编码过的或带 ".." 的路径都匹配不上白名单路由
    const pathname = q >= 0 ? raw.slice(0, q) : raw;
    if (pathname !== API_ROOT && !pathname.startsWith(`${API_ROOT}/`)) {
      next();
      return;
    }
    const rejection = checkRequest({
      method: req.method ?? "GET",
      remoteAddress: req.socket.remoteAddress,
      localPort: req.socket.localPort,
      headers: req.headers,
    });
    if (rejection) {
      sendJson(res, rejection.status, { error: rejection.code, message: rejection.message });
      req.resume();
      return;
    }
    const query = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "");
    handle(req, res, pathname, query).catch((e) => {
      sendError(res, e);
      // 拒绝过大的请求体后不再读取剩余部分
      if (e instanceof StorageError && e.status === 413) res.on("finish", () => req.destroy());
      else req.resume();
    });
  };
}

/** 解码到不再变化为止（防 %2564 这样的多重编码） */
function decodeRepeatedly(p: string): string {
  for (let i = 0; i < 5; i++) {
    let d: string;
    try {
      d = decodeURIComponent(p);
    } catch {
      return p;
    }
    if (d === p) return p;
    p = d;
  }
  return p;
}

/** 路径的真实位置：从最近的已存在的上级目录解析符号链接，再接上不存在的部分 */
export function realpathNearest(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (let i = 0; i < 128; i++) {
    try {
      return path.join(realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p);
}

/** Vite 把这些前缀后面的部分当作文件路径（/@fs/<绝对路径>、/@id/<模块 id>、/@id/__x00__<虚拟模块>） */
const FS_PREFIXES = ["/@fs/", "/@id/__x00__", "/@id/"];

/**
 * 一个请求可能读到的文件系统路径：去掉查询串、多重解码、反斜杠转正斜杠、规范化（含 "//data" 这类双斜杠），
 * 再反复剥掉 Vite 的 /@fs、/@id 前缀；每一步的结果既按项目根目录下的路径算，也按绝对路径算。
 */
export function candidatePaths(rawUrl: string, root: string): string[] {
  let p = rawUrl.split("?")[0].split("#")[0];
  p = decodeRepeatedly(p).replace(/\\/g, "/");
  const out = new Set<string>();
  for (let i = 0; i < 6; i++) {
    p = path.posix.normalize(`/${p}`).replace(/^\/+/, "/");
    out.add(path.join(root, p));
    out.add(path.resolve(p));
    const prefix = FS_PREFIXES.find((x) => p.toLowerCase().startsWith(x));
    if (!prefix) break;
    p = p.slice(prefix.length - (prefix.endsWith("/") ? 1 : 0));
  }
  return [...out];
}

/**
 * 阻止通过 Vite 的静态文件服务（含 /@fs/、/@id/、"//data"、?import / ?raw / ?inline / ?url 等变体）直接读取数据目录
 * （整个 data/：projects.json、projects/、trash/ 都在里面），以及迁移脚本放在数据目录旁边的完整备份
 * （data-backup-before-projects-*）。另外插件会把它们加进 server.fs.deny 并关闭 Vite 的 CORS，这里是第三道防线。
 * 存储接口本身由 createStorageHandler 处理（挂在它前面），这里不为 /__paperlens 开例外。
 */
export function createDataDirGuard(root: string, dataDir: string): Middleware {
  const fold = process.platform === "darwin" || process.platform === "win32" ? (p: string) => p.toLowerCase() : (p: string) => p;
  // 同时比较字面路径和真实路径：macOS 的 /var → /private/var、项目里指向数据目录的符号链接等
  const both = (p: string) => [...new Set([path.resolve(p), realpathNearest(p)].map(fold))];
  const backupPrefix = fold(MIGRATION_BACKUP_PREFIX);
  const inside = (p: string) => {
    const dirs = both(dataDir);
    const parents = both(path.dirname(path.resolve(dataDir)));
    return [path.resolve(p), realpathNearest(p)].some((c) => {
      const n = fold(c);
      if (dirs.some((t) => n === t || n.startsWith(t + path.sep))) return true;
      return parents.some((t) => n.startsWith(t + path.sep) && n.slice(t.length + 1).startsWith(backupPrefix));
    });
  };
  return (req, res, next) => {
    const raw = req.url ?? "/";
    if (candidatePaths(raw, root).some(inside)) {
      res.statusCode = 403;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden");
      req.resume();
      return;
    }
    next();
  };
}
