// 本地存储服务（server/storageHandler.ts）的客户端：当前项目的 /__paperlens/p/<id>/storage/...。主线程和 Worker 都用它。
import { projectApiBase } from "@/lib/project";
import type { ExtraFile } from "./extraFiles";

export interface LibraryStatus {
  exists: boolean;
  revision: number;
  version: number | null;
  savedAt: number | null;
  size: number;
  counts: Record<string, number> | null;
  hasData: boolean;
  /** 写入方记录的数据内容哈希（tables 部分的 SHA-256） */
  contentHash: string | null;
  /** 文件存在但无法解析（可能已损坏） */
  error?: string;
}

export interface ServiceStatus {
  service: "paperlens-storage";
  apiVersion: number;
  /** data/ 还是旧版结构：服务不写入，需要先运行 npm run migrate:projects */
  needsMigration?: boolean;
  project?: { id: string; name: string };
  /** data/ 根目录（迁移前的同步记录以它为标识） */
  dataRoot?: string;
  /** 有 projects.json 时根目录下又出现的旧版文件（例如迁移后又运行过旧版本） */
  strayLegacyFiles?: string[];
  /** 本项目的目录，如 <项目根>/data/projects/default */
  dataDir: string;
  /** 界面显示用，如 "data/projects/default/" */
  dataDirLabel: string;
  library: LibraryStatus;
  pdfCount: number;
}

export interface FilesResult {
  written: number;
  unchanged: number;
  deleted: number;
  /** 用户放进来或改过、因而被移到 .paperlens-replaced/ 的文件数 */
  replaced: number;
  /** 只给了 sha、服务端对不上的文件（需要带内容重发） */
  missing: string[];
}

/** 附加文件：带内容，或只带 SHA-1（客户端认为与上次相同） */
export type FileEntry = { name: string; content: string; sha?: string } | { name: string; sha: string; content?: undefined };

export interface StorageUsage {
  library: number;
  pdfs: number;
  backups: number;
  trash: number;
  groups: Record<string, number>;
  total: number;
}

/** 服务返回的错误（含 HTTP 状态和错误码） */
export class StorageApiError extends Error {
  override name = "StorageApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface StorageApi {
  /** 探测服务；没有服务（静态部署、PAPERLENS_STORAGE=off、网络错误）时返回 null */
  status(timeoutMs?: number): Promise<ServiceStatus | null>;
  /** library.json 原文；不存在时返回 null */
  getLibrary(): Promise<{ text: string; revision: number } | null>;
  /** 冲突时抛出 status 409 的 StorageApiError，data.revision / data.contentHash 为文件夹当前的 revision 和内容哈希 */
  putLibrary(
    body: string,
    baseRevision: number,
    opts?: { keepalive?: boolean; overwriteUnreadable?: boolean },
  ): Promise<{ revision: number; savedAt: number; hasData: boolean; backup?: string }>;
  /** library.json 损坏时用最近的可读备份替换 */
  recoverLibrary(): Promise<{ name: string; revision: number }>;
  usage(): Promise<StorageUsage>;
  backup(reason: string, body?: string): Promise<{ name: string | null }>;
  /** hashes：data/pdfs 中的；trashed：回收站中的（读取时同样可用） */
  listPdfs(): Promise<{ hashes: string[]; trashed: string[] }>;
  getPdf(hash: string): Promise<Blob | null>;
  putPdf(hash: string, data: Blob): Promise<{ stored: boolean }>;
  putFiles(group: string, files: (ExtraFile | FileEntry)[]): Promise<FilesResult>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createStorageApi(base = projectApiBase(), fetchImpl: FetchLike = (i, init) => fetch(i, init)): StorageApi {
  const headers = (extra?: Record<string, string>) => ({ "X-PaperLens": "1", ...extra });

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

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, { cache: "no-store", ...init, headers: headers(init?.headers as Record<string, string>) });
    if (!res.ok) return fail(res);
    return (await res.json()) as T;
  }

  return {
    async status(timeoutMs = 4000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${base}/status`, { headers: headers(), cache: "no-store", signal: ctrl.signal });
        // 没有服务时开发服务器会返回 index.html（单页应用回退）或 404；没有这个项目时也是 404
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
        const body = (await res.json()) as Partial<ServiceStatus>;
        return body.service === "paperlens-storage" && body.library ? (body as ServiceStatus) : null;
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    },

    async getLibrary() {
      const res = await fetchImpl(`${base}/library`, { headers: headers(), cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) return fail(res);
      return { text: await res.text(), revision: Number(res.headers.get("x-paperlens-revision") ?? 0) };
    },

    putLibrary(body, baseRevision, opts) {
      return json("/library", {
        method: "PUT",
        body,
        keepalive: opts?.keepalive,
        headers: {
          "Content-Type": "application/json",
          "X-PaperLens-Base-Revision": String(baseRevision),
          ...(opts?.overwriteUnreadable ? { "X-PaperLens-Overwrite-Unreadable": "1" } : {}),
        },
      });
    },

    recoverLibrary() {
      return json("/library/recover", { method: "POST" });
    },

    usage() {
      return json("/usage");
    },

    backup(reason, body) {
      return json(`/backups?reason=${encodeURIComponent(reason)}`, {
        method: "POST",
        body: body ?? "",
        headers: { "Content-Type": "application/json" },
      });
    },

    async listPdfs() {
      const r = await json<{ hashes?: string[]; trashed?: string[] }>("/pdfs");
      return { hashes: r.hashes ?? [], trashed: r.trashed ?? [] };
    },

    async getPdf(hash) {
      const res = await fetchImpl(`${base}/pdfs/${hash}`, { headers: headers(), cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) return fail(res);
      return new Blob([await res.arrayBuffer()], { type: "application/pdf" });
    },

    putPdf(hash, data) {
      return json(`/pdfs/${hash}`, { method: "PUT", body: data, headers: { "Content-Type": "application/pdf" } });
    },

    async putFiles(group, files) {
      const r = await json<Partial<FilesResult>>(`/files/${encodeURIComponent(group)}`, {
        method: "PUT",
        body: JSON.stringify({ files }),
        headers: { "Content-Type": "application/json" },
      });
      return { written: r.written ?? 0, unchanged: r.unchanged ?? 0, deleted: r.deleted ?? 0, replaced: r.replaced ?? 0, missing: r.missing ?? [] };
    },
  };
}
