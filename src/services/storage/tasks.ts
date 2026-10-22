// 存储模块里读写整库的工作：生成快照并保存、比对与上传 PDF、生成 Markdown、恢复、导入导出。
// 默认在 storage.worker.ts 中执行（读表、序列化、哈希、解析都不占主线程），Worker 不可用时在主线程执行同样的代码。
import type { PaperLensDB } from "@/db/schema";
import { t } from "@/i18n";
import { sha256Hex } from "@/lib/hash";
import { StorageApiError, type FileEntry, type FilesResult, type StorageApi } from "./api";
import {
  countTables,
  describeRepairs,
  fingerprint,
  hasUserData,
  parseDataFile,
  serializeDataFile,
  serializeTables,
  type DataCounts,
} from "./format";
import { buildCombinedMarkdown, buildMarkdownFiles } from "./markdown";
import { localCounts, localFileHashes, readDataSnapshot, referencedFileHashes, replaceAllData, stampDbInstance } from "./snapshot";

export interface TaskContext {
  db: PaperLensDB;
  api: StorageApi;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const KEEPALIVE_LIMIT = 60_000; // keepalive 请求体上限约 64 KB

async function sha256Text(s: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(s).buffer as ArrayBuffer);
}

async function sha1Text(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function snapshot(ctx: TaskContext) {
  const t0 = performance.now();
  const { tables, dbInstance } = await readDataSnapshot(ctx.db);
  const t1 = performance.now();
  const tablesJson = serializeTables(tables);
  const t2 = performance.now();
  const hash = await sha256Text(tablesJson);
  const t3 = performance.now();
  return {
    tables,
    tablesJson,
    hash,
    fingerprint: fingerprint(tablesJson),
    counts: countTables(tables),
    dbInstance,
    timings: { readMs: t1 - t0, serializeMs: t2 - t1, hashMs: t3 - t2 },
  };
}

// ---------- 本地数据概况 ----------

export interface LocalInspection {
  counts: DataCounts;
  /** tables 部分的 SHA-256（与 library.json 的 contentHash 同一算法） */
  hash: string;
  /** 同步计算的快速指纹，替换数据前用来确认本地没有新改动 */
  fingerprint: string;
  /** 数据库实例标识；数据库被清空重建后为 null */
  dbInstance: string | null;
}

export async function inspectLocal(ctx: TaskContext): Promise<LocalInspection> {
  const s = await snapshot(ctx);
  return { counts: s.counts, hash: s.hash, fingerprint: s.fingerprint, dbInstance: s.dbInstance };
}

export async function stampDb(ctx: TaskContext, id: string): Promise<void> {
  await stampDbInstance(ctx.db, id);
}

// ---------- 保存 library.json ----------

export interface FolderState {
  exists: boolean;
  hasData: boolean;
  revision: number;
  /** 文件夹里那份数据的内容哈希（写入方记录的） */
  contentHash: string | null;
  /** library.json 存在但无法读取 */
  unreadable: boolean;
}

export interface MirrorArgs {
  /** 本地数据对应的文件夹 revision；0 表示未知 */
  baseRevision: number;
  /** 上次保存（或载入）时的本地数据哈希 */
  lastHash: string | null;
  /** 最近一次得知的文件夹状态 */
  folder: FolderState;
  /** 本地数据库应有的实例标识；不一致说明数据库被清空重建过。null 表示不检查 */
  dbInstance: string | null;
  keepalive?: boolean;
  /** 不比较哈希，总是写入（用本地数据覆盖文件夹时） */
  force?: boolean;
  /** 本地已没有数据时也写入（用户确认清空文件夹中的数据） */
  allowEmpty?: boolean;
  /** 文件夹里的 library.json 无法读取时也覆盖（用户确认；服务端会先备份损坏的文件） */
  overwriteUnreadable?: boolean;
}

export type MirrorStatus =
  /** 已写入 */
  | "saved"
  /** 与上次保存的内容相同 */
  | "unchanged"
  /** 文件夹里的就是本地这份数据（例如上次写入成功但没收到响应）：直接采用文件夹的 revision */
  | "adopted"
  /** 本地和文件夹都没有数据，不必写 */
  | "empty"
  /** 文件夹被其他窗口（另一个源）更新过，本地也有改动 */
  | "conflict"
  /** 本地没有改动，文件夹更新：可以直接载入 */
  | "behind"
  /** 本地数据被清空而文件夹还有数据：需要用户决定 */
  | "local-empty"
  /** 本地数据库被清空重建过（实例标识不符）：不能把残缺的数据写进文件夹 */
  | "db-reset"
  /** 文件夹里的 library.json 无法读取 */
  | "unreadable"
  /** 文件夹中的数据由更新版本写入 */
  | "newer-format";

export interface MirrorResult {
  status: MirrorStatus;
  revision: number;
  hash: string;
  fingerprint: string;
  bytes: number;
  savedAt?: number;
  hasData?: boolean;
  /** 数据骤减时服务端额外做的备份 */
  backup?: string;
  /** 冲突时文件夹的 revision */
  folderRevision?: number;
  /** 本地是否有用户内容 */
  localHasData: boolean;
  timings: { readMs: number; serializeMs: number; hashMs: number; putMs: number };
}

export async function mirrorLibrary(ctx: TaskContext, args: MirrorArgs): Promise<MirrorResult> {
  const snap = await snapshot(ctx);
  const f = args.folder;
  const localHasData = hasUserData(snap.counts);
  const base = {
    revision: args.baseRevision,
    hash: snap.hash,
    fingerprint: snap.fingerprint,
    bytes: 0,
    localHasData,
    timings: { ...snap.timings, putMs: 0 },
  };
  if (args.dbInstance !== null && snap.dbInstance !== args.dbInstance) return { ...base, status: "db-reset", folderRevision: f.revision };
  // 文件夹里就是这份数据
  if (!args.force && f.exists && !f.unreadable && f.contentHash === snap.hash) {
    const same = f.revision === args.baseRevision && args.lastHash === snap.hash;
    return { ...base, status: same ? "unchanged" : "adopted", revision: f.revision };
  }
  // 文件夹里的 library.json 被删掉了：即使本地没改动也重新写一份
  if (!args.force && snap.hash === args.lastHash && f.exists) {
    return { ...base, status: f.revision > args.baseRevision ? "behind" : "unchanged" };
  }
  if (!localHasData && f.hasData && !args.allowEmpty) return { ...base, status: "local-empty", folderRevision: f.revision };
  if (f.unreadable && !args.overwriteUnreadable) return { ...base, status: "unreadable", folderRevision: 0 };
  if (!localHasData && snap.counts.kv === 0 && !f.exists) return { ...base, status: "empty" };

  const revision = args.baseRevision + 1;
  const body = serializeDataFile(snap.tablesJson, { exportedAt: new Date().toISOString(), revision, contentHash: snap.hash });
  const t0 = performance.now();
  try {
    const res = await ctx.api.putLibrary(body, args.baseRevision, {
      keepalive: !!args.keepalive && body.length < KEEPALIVE_LIMIT,
      overwriteUnreadable: args.overwriteUnreadable,
    });
    return {
      ...base,
      status: "saved",
      revision: res.revision,
      bytes: body.length,
      savedAt: res.savedAt,
      hasData: res.hasData,
      ...(res.backup ? { backup: res.backup } : {}),
      timings: { ...base.timings, putMs: performance.now() - t0 },
    };
  } catch (e) {
    if (e instanceof StorageApiError && e.status === 409) {
      const folderRevision = typeof e.data.revision === "number" ? e.data.revision : f.revision;
      // 上次写入其实成功了（响应丢失、页面关闭时的 keepalive 请求等）
      if (e.code === "conflict" && e.data.contentHash === snap.hash) return { ...base, status: "adopted", revision: folderRevision };
      const status: MirrorStatus = e.code === "newer-format" ? "newer-format" : e.code === "unreadable" ? "unreadable" : "conflict";
      return { ...base, status, folderRevision };
    }
    throw e;
  }
}

// ---------- PDF ----------

export interface PdfDiff {
  /** 本地有、data/pdfs 没有的（被论文引用的） */
  toUpload: string[];
  /** 论文引用、本地没有、服务上有的 */
  toFetch: { hash: string; paperIds: string[] }[];
  /** 论文引用、本地和服务上都没有的 */
  missing: { hash: string; paperIds: string[] }[];
}

export async function pdfDiff(ctx: TaskContext): Promise<PdfDiff> {
  const [refs, local, remote] = await Promise.all([referencedFileHashes(ctx.db), localFileHashes(ctx.db), ctx.api.listPdfs()]);
  const inPdfs = new Set(remote.hashes);
  const onServer = new Set([...remote.hashes, ...remote.trashed]);
  const out: PdfDiff = { toUpload: [], toFetch: [], missing: [] };
  for (const [hash, paperIds] of refs) {
    if (local.has(hash)) {
      if (!inPdfs.has(hash) && HASH_RE.test(hash)) out.toUpload.push(hash);
    } else if (onServer.has(hash)) out.toFetch.push({ hash, paperIds });
    else out.missing.push({ hash, paperIds });
  }
  return out;
}

export async function uploadPdf(ctx: TaskContext, hash: string): Promise<boolean> {
  const f = await ctx.db.files.get(hash);
  if (!f) return false;
  await ctx.api.putPdf(hash, f.blob);
  return true;
}

/** 从服务取回一个 PDF 写入 db.files（校验哈希）；本地已有或服务上没有时返回 false */
export async function fetchPdfToDb(ctx: TaskContext, hash: string): Promise<Blob | null> {
  const existing = await ctx.db.files.get(hash);
  if (existing) return existing.blob;
  const blob = await ctx.api.getPdf(hash);
  if (!blob) return null;
  if ((await sha256Hex(blob)) !== hash) throw new Error(t.data.errors.pdfCorrupt);
  await ctx.db.files.put({ hash, blob, size: blob.size });
  return blob;
}

export async function backfillPdf(ctx: TaskContext, hash: string): Promise<boolean> {
  return !!(await fetchPdfToDb(ctx, hash));
}

// ---------- Markdown ----------

async function markdownInput(ctx: TaskContext) {
  const { db } = ctx;
  return db.transaction("r", [db.domains, db.papers, db.annotations, db.terms, db.occurrences], async () => {
    const [domains, papers, annotations, terms, occurrences] = await Promise.all([
      db.domains.toArray(),
      db.papers.toArray(),
      db.annotations.toArray(),
      db.terms.toArray(),
      db.occurrences.toArray(),
    ]);
    return { tables: { domains, papers, annotations, terms }, occurrences };
  });
}

/** 上次成功发给服务的 Markdown：内容没变的文件只发 SHA-1 */
const sentMarkdown = new Map<string, { content: string; sha: string }>();

export async function writeMarkdown(ctx: TaskContext): Promise<FilesResult & { files: number; sent: number }> {
  const files = buildMarkdownFiles(await markdownInput(ctx));
  const entries: FileEntry[] = files.map((f) => {
    const prev = sentMarkdown.get(f.name);
    return prev && prev.content === f.content ? { name: f.name, sha: prev.sha } : { name: f.name, content: f.content };
  });
  let sent = entries.filter((e) => e.content !== undefined).length;
  let res = await ctx.api.putFiles("markdown", entries);
  if (res.missing.length) {
    // 服务端对不上（目录换了、文件被删了）：这些带内容重发
    const missing = new Set(res.missing);
    const retry: FileEntry[] = files.map((f, i) => (missing.has(f.name) ? { name: f.name, content: f.content } : entries[i]));
    sent += missing.size;
    const r2 = await ctx.api.putFiles("markdown", retry);
    res = { ...r2, written: res.written + r2.written, replaced: res.replaced + r2.replaced, deleted: res.deleted + r2.deleted, unchanged: r2.unchanged };
  }
  const next = new Map<string, { content: string; sha: string }>();
  for (const f of files) {
    const prev = sentMarkdown.get(f.name);
    next.set(f.name, prev && prev.content === f.content ? prev : { content: f.content, sha: await sha1Text(f.content) });
  }
  sentMarkdown.clear();
  for (const [k, v] of next) sentMarkdown.set(k, v);
  return { ...res, files: files.length, sent };
}

export async function combinedMarkdown(ctx: TaskContext): Promise<string> {
  return buildCombinedMarkdown(await markdownInput(ctx), Date.now());
}

// ---------- 导出、导入、恢复 ----------

/** 当前数据的 JSON 备份（不含 revision，与文件夹无关） */
export async function exportJson(ctx: TaskContext): Promise<{ text: string; counts: DataCounts; fingerprint: string }> {
  const snap = await snapshot(ctx);
  return { text: serializeDataFile(snap.tablesJson, { exportedAt: new Date().toISOString() }), counts: snap.counts, fingerprint: snap.fingerprint };
}

/** 把本地当前数据备份到 data/backups/（替换本地数据之前）。返回所备份数据的指纹，替换时据此确认期间没有新改动 */
export async function backupLocal(ctx: TaskContext, reason: string): Promise<{ name: string | null; fingerprint: string }> {
  const snap = await snapshot(ctx);
  if (!hasUserData(snap.counts) && snap.counts.kv === 0) return { name: null, fingerprint: snap.fingerprint };
  const { name } = await ctx.api.backup(reason, serializeDataFile(snap.tablesJson, { exportedAt: new Date().toISOString() }));
  return { name, fingerprint: snap.fingerprint };
}

export interface ImportPreview {
  counts: DataCounts;
  exportedAt: string;
  version: number;
  revision?: number;
  repairs: string[];
}

export async function previewImport(_ctx: TaskContext, text: string): Promise<ImportPreview> {
  const { file, report } = parseDataFile(text);
  return {
    counts: countTables(file.tables),
    exportedAt: file.exportedAt,
    version: file.version,
    ...(file.revision !== undefined ? { revision: file.revision } : {}),
    repairs: describeRepairs(report),
  };
}

export interface ReplaceResult extends ImportPreview {
  /** 替换后本地数据的哈希（与 revision 一起记为已同步） */
  hash: string;
}

/** expect：本地数据在决定替换时的指纹；替换前在同一事务里核对，不一致则抛出 LocalChangedError、不做任何修改 */
async function replaceWith(ctx: TaskContext, text: string, expect?: string): Promise<ReplaceResult> {
  const { file, report } = parseDataFile(text);
  await replaceAllData(ctx.db, file.tables, expect !== undefined ? { expectFingerprint: expect } : {});
  const snap = await snapshot(ctx);
  return {
    counts: snap.counts,
    exportedAt: file.exportedAt,
    version: file.version,
    ...(file.revision !== undefined ? { revision: file.revision } : {}),
    repairs: describeRepairs(report),
    hash: snap.hash,
  };
}

/** 用 JSON 备份替换本地数据 */
export function applyImport(ctx: TaskContext, arg: { text: string; expect?: string }): Promise<ReplaceResult> {
  return replaceWith(ctx, arg.text, arg.expect);
}

/** 用 data/library.json 替换本地数据 */
export async function restoreFromService(ctx: TaskContext, arg: { expect?: string } = {}): Promise<ReplaceResult & { revision: number }> {
  const lib = await ctx.api.getLibrary();
  if (!lib) throw new Error(t.data.errors.noLibrary);
  const res = await replaceWith(ctx, lib.text, arg.expect);
  return { ...res, revision: res.revision ?? lib.revision };
}

export async function countLocal(ctx: TaskContext): Promise<DataCounts> {
  return localCounts(ctx.db);
}

/** 所有可以交给 Worker 的任务；第二个参数必须可结构化克隆 */
export const storageTasks = {
  countLocal,
  inspectLocal,
  stampDb,
  mirrorLibrary,
  pdfDiff,
  uploadPdf,
  backfillPdf,
  writeMarkdown,
  combinedMarkdown,
  exportJson,
  backupLocal,
  previewImport,
  applyImport,
  restoreFromService,
};

export type StorageTasks = typeof storageTasks;
export type TaskName = keyof StorageTasks;
export type TaskArg<K extends TaskName> = Parameters<StorageTasks[K]>[1];
export type TaskResult<K extends TaskName> = Awaited<ReturnType<StorageTasks[K]>>;
