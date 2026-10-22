// 换 PDF 文件与批注重新锚定（开发文档第 6 节第 4 步）。
// 批注存创建时的 fileHash；与论文当前的 fileHash 不一致说明换过文件：用 quote 在新文件全文中重新查找，
// 找到则改页码并清空矩形（矩形需要该页的字形映射，由高亮层渲染时补算），找不到则标为未定位。
import { db } from "@/db/schema";
import { getPaper, getPaperByHash } from "@/db/repo/papers";
import { findQuote } from "@/engine/anchor";
import { t } from "@/i18n";
import { sha256Hex } from "@/lib/hash";
import { scheduleIndex } from "@/services/indexer";
import { ensurePageTexts, invalidatePageTexts } from "@/services/pageTextService";
import { hasPdfMagic, readPdfInfo, type ImportSource, type PdfInfoReader } from "@/services/paperService";
import type { Annotation, Paper } from "@/types/models";

// ---------------------------------------------------------------------------
// 纯函数：重新锚定的决定
// ---------------------------------------------------------------------------

export type ReanchorChange =
  | { id: string; kind: "relocated"; page: number; fileHash: string }
  | { id: string; kind: "orphaned" }
  /** 换回了批注创建时的文件：原矩形仍然有效 */
  | { id: string; kind: "restored" };

export interface ReanchorOptions {
  /** 也重试已标为未定位的批注（换文件时为 true；打开论文时只处理新出现的不一致） */
  retryOrphaned?: boolean;
}

/**
 * 需要重新锚定（或恢复）的批注。
 * 与当前文件一致但标为未定位的：有矩形说明是换回了原文件，可以恢复；没有矩形说明是重新定位后在该页补算矩形失败，
 * 保持未定位（再查一遍只会定位到同一处、再次失败，来回翻转）。
 */
export function needsReanchor(
  a: Pick<Annotation, "fileHash" | "anchorStatus" | "rects">,
  paperFileHash: string,
  opts: ReanchorOptions = {},
): boolean {
  if (a.fileHash === paperFileHash) return a.anchorStatus === "orphaned" && a.rects.length > 0;
  return a.anchorStatus !== "orphaned" || !!opts.retryOrphaned;
}

export function planReanchor(
  annotations: Annotation[],
  paperFileHash: string,
  pages: { page: number; text: string }[],
  opts: ReanchorOptions = {},
): ReanchorChange[] {
  const out: ReanchorChange[] = [];
  for (const a of annotations) {
    if (!needsReanchor(a, paperFileHash, opts)) continue;
    if (a.fileHash === paperFileHash) {
      out.push({ id: a.id, kind: "restored" });
      continue;
    }
    const m = findQuote(pages, a.quote, { page: a.page });
    if (m) out.push({ id: a.id, kind: "relocated", page: m.page, fileHash: paperFileHash });
    else if (a.anchorStatus !== "orphaned") out.push({ id: a.id, kind: "orphaned" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 重新锚定一篇论文
// ---------------------------------------------------------------------------

export interface ReanchorResult {
  relocated: number;
  orphaned: number;
  restored: number;
}

const EMPTY: ReanchorResult = { relocated: 0, orphaned: 0, restored: 0 };

// ---- 失败退避：同一篇论文同一个文件重新锚定失败后，一段时间内打开论文不再自动重试 ----

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const failures = new Map<string, { count: number; until: number }>();
const failKey = (paperId: string, fileHash: string) => `${paperId}\u0000${fileHash}`;

/** 第 n 次连续失败后的等待时间：30 s、60 s、2 min……最多 10 min */
export function backoffDelay(count: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, count - 1));
}

/** 是否处于失败退避期 */
export function inReanchorBackoff(paperId: string, fileHash: string, now = Date.now()): boolean {
  const f = failures.get(failKey(paperId, fileHash));
  return !!f && now < f.until;
}

/** 测试用：清空失败记录 */
export function resetReanchorBackoff(): void {
  failures.clear();
}

async function runReanchor(paperId: string, opts: ReanchorOptions): Promise<ReanchorResult> {
  const paper = await getPaper(paperId);
  if (!paper) return EMPTY;
  const key = failKey(paperId, paper.fileHash);
  try {
    const result = await reanchorOnce(paper, opts);
    failures.delete(key);
    return result;
  } catch (e) {
    const count = (failures.get(key)?.count ?? 0) + 1;
    failures.set(key, { count, until: Date.now() + backoffDelay(count) });
    throw e;
  }
}

async function reanchorOnce(paper: Paper, opts: ReanchorOptions): Promise<ReanchorResult> {
  const paperId = paper.id;
  const anns = await db.annotations.where("paperId").equals(paperId).toArray();
  const todo = anns.filter((a) => needsReanchor(a, paper.fileHash, opts));
  if (!todo.length) return EMPTY;
  // 只是恢复时不需要全文。ensurePageTexts 保证返回的是当前文件的全文（提取期间换了文件会按新文件重来）
  const pages = todo.some((a) => a.fileHash !== paper.fileHash) ? await ensurePageTexts(paperId) : [];
  const plan = planReanchor(todo, paper.fileHash, pages, opts);
  const result = { ...EMPTY };
  await db.transaction("rw", db.annotations, db.papers, async () => {
    // 计算期间论文又换了文件：放弃，由下一次调用处理
    if ((await db.papers.get(paperId))?.fileHash !== paper.fileHash) return;
    const before = new Map(todo.map((a) => [a.id, a]));
    for (const c of plan) {
      const now = await db.annotations.get(c.id);
      const was = before.get(c.id)!;
      if (!now || now.fileHash !== was.fileHash || now.anchorStatus !== was.anchorStatus) continue;
      if (c.kind === "relocated") {
        await db.annotations.update(c.id, { page: c.page, fileHash: c.fileHash, anchorStatus: "relocated", rects: [] });
        result.relocated++;
      } else if (c.kind === "orphaned") {
        await db.annotations.update(c.id, { anchorStatus: "orphaned" });
        result.orphaned++;
      } else {
        if (!now.rects.length) continue;
        await db.annotations.update(c.id, { anchorStatus: "ok" });
        result.restored++;
      }
    }
  });
  return result;
}

const queues = new Map<string, Promise<unknown>>();

/** 重新锚定论文中与当前文件不一致的批注。同一篇论文的调用依次执行 */
export function reanchorPaper(paperId: string, opts: ReanchorOptions = {}): Promise<ReanchorResult> {
  const prev = queues.get(paperId) ?? Promise.resolve();
  const p = prev.catch(() => {}).then(() => runReanchor(paperId, opts));
  queues.set(paperId, p);
  void p.finally(() => {
    if (queues.get(paperId) === p) queues.delete(paperId);
  }).catch(() => {});
  return p;
}

/**
 * 打开论文（及批注数据变化）时调用：有与当前文件不一致的批注才真正执行。
 * 该文件上次重新锚定失败且仍在退避期内时跳过，避免每次改笔记都重新提取整篇全文。
 */
export function ensureAnchored(
  paper: Pick<Paper, "id" | "fileHash">,
  annotations: Annotation[],
  now = Date.now(),
): Promise<ReanchorResult> | null {
  if (!annotations.some((a) => needsReanchor(a, paper.fileHash))) return null;
  if (inReanchorBackoff(paper.id, paper.fileHash, now)) return null;
  return reanchorPaper(paper.id);
}

// ---------------------------------------------------------------------------
// 替换 PDF 文件
// ---------------------------------------------------------------------------

export type ReplaceOutcome =
  | { status: "unchanged" }
  | { status: "conflict"; other: Pick<Paper, "id" | "title"> }
  | { status: "failed"; error: string }
  /** reanchorFailed：文件已替换，但重新锚定出错（如新文件提取全文失败），批注留待下次打开论文时重试 */
  | ({ status: "replaced"; pageCount: number; reanchorFailed: boolean } & ReanchorResult);

/**
 * 用新文件替换论文的 PDF（例如 arXiv 新版本）：
 * 哈希相同则不动；已被其他论文使用则报冲突；否则写入新文件、更新 fileHash/pageCount，
 * 旧文件无人引用时删除，清掉全文缓存和术语出现位置，然后重新锚定批注并安排重建索引。
 */
export async function replacePaperFile(
  paperId: string,
  source: ImportSource,
  opts: { readInfo?: PdfInfoReader } = {},
): Promise<ReplaceOutcome> {
  let data: ArrayBuffer;
  try {
    data = await source.arrayBuffer();
  } catch {
    return { status: "failed", error: t.reader.replace.errors.unreadable };
  }
  if (!hasPdfMagic(data)) return { status: "failed", error: t.reader.replace.errors.notPdf };
  const paper = await getPaper(paperId);
  if (!paper) return { status: "failed", error: t.reader.replace.errors.paperMissing };

  const hash = await sha256Hex(data);
  if (hash === paper.fileHash) return { status: "unchanged" };
  const other = await getPaperByHash(hash);
  if (other && other.id !== paperId) return { status: "conflict", other: { id: other.id, title: other.title } };

  let pageCount: number;
  try {
    pageCount = (await (opts.readInfo ?? readPdfInfo)(data)).pageCount;
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    return { status: "failed", error: name === "PasswordException" ? t.reader.replace.errors.encrypted : t.reader.replace.errors.corrupt };
  }
  if (!Number.isFinite(pageCount) || pageCount < 1) return { status: "failed", error: t.reader.replace.errors.noPages };

  const blob = new Blob([data], { type: "application/pdf" });
  const res = await db.transaction("rw", [db.papers, db.files, db.pageTexts, db.occurrences], async () => {
    const cur = await db.papers.get(paperId);
    if (!cur) return { status: "failed", error: t.reader.replace.errors.paperMissing } as const;
    const again = await db.papers.where("fileHash").equals(hash).first();
    if (again && again.id !== paperId) return { status: "conflict", other: { id: again.id, title: again.title } } as const;
    const oldHash = cur.fileHash;
    await db.files.put({ hash, blob, size: data.byteLength });
    await db.papers.update(paperId, { fileHash: hash, pageCount });
    if (!(await db.papers.where("fileHash").equals(oldHash).count())) await db.files.delete(oldHash);
    await invalidatePageTexts(paperId); // 在本事务内执行
    await db.occurrences.where("paperId").equals(paperId).delete();
    return null;
  });
  if (res) return res;

  // 从这里起文件已经换掉：之后的任何失败都不能报"替换失败"
  let anchored = EMPTY;
  let reanchorFailed = false;
  try {
    anchored = await reanchorPaper(paperId, { retryOrphaned: true });
  } catch (e) {
    console.error("Failed to re-anchor annotations after replacing the PDF", e);
    reanchorFailed = true;
  }
  scheduleIndex({ paperIds: [paperId] });
  return { status: "replaced", pageCount, reanchorFailed, ...anchored };
}
