// 全文缓存（pageTexts 表）：后台扫描 occurrences、换文件后重新锚定批注都从这里读每页的规范化文本。
// 偏移与阅读器 ctx.text.normalized 完全一致（同样的 getTextContent 参数 + normalizeItems）。
import { db } from "@/db/schema";
import { normalizeItems } from "@/engine/normalize";
import { NORMALIZE_VERSION } from "@/engine/types";
import { acquirePdf } from "@/lib/pdfDocs";
import type { PageText, Paper } from "@/types/models";

export interface PageTextRow {
  page: number; // 从 1 开始
  text: string;
}

/** 在途提取，键为 paperId + fileHash：换文件后不会拿到旧文件的提取结果 */
const inflight = new Map<string, Promise<PageTextRow[]>>();

/** 缓存是否对当前文件和规范化规则有效 */
function isFresh(rows: PageText[], paper: Paper): boolean {
  return (
    rows.length > 0 &&
    rows.length === paper.pageCount &&
    rows.every((r) => r.fileHash === paper.fileHash && r.engineVersion === NORMALIZE_VERSION)
  );
}

async function readFresh(paper: Paper): Promise<PageTextRow[] | null> {
  const rows = await db.pageTexts.where("paperId").equals(paper.id).toArray();
  if (!isFresh(rows, paper)) return null;
  return rows.sort((a, b) => a.page - b.page).map(({ page, text }) => ({ page, text }));
}

/** 只读缓存：有效则返回（按页码排序），否则返回 null，不触发提取 */
export async function getCachedPageTexts(paperId: string): Promise<PageTextRow[] | null> {
  const paper = await db.papers.get(paperId);
  return paper ? readFresh(paper) : null;
}

/**
 * 读取论文各页的规范化文本；缺失、过期（换过文件或规范化规则变化）时从 PDF 重新提取并写回缓存。
 * 同一文件并发调用只提取一次；提取期间论文换了文件时，丢弃结果并按新文件重来。论文不存在时返回空数组。
 */
export async function ensurePageTexts(paperId: string): Promise<PageTextRow[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const paper = await db.papers.get(paperId);
    if (!paper) return [];
    const cached = await readFresh(paper);
    if (cached) return cached;
    const key = `${paperId}\u0000${paper.fileHash}`;
    let p = inflight.get(key);
    if (!p) {
      p = extractAndStore(paper).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const rows = await p;
    const now = await db.papers.get(paperId);
    if (!now) return [];
    if (now.fileHash === paper.fileHash) return rows;
  }
  throw new Error("论文的 PDF 在提取全文期间反复变化");
}

async function extractAndStore(paper: Paper): Promise<PageTextRow[]> {
  const { TEXT_CONTENT_PARAMS } = await import("@/lib/pdf");
  // 通过文档缓存获取：论文正在阅读器中打开时复用同一份文档，不再解析第二遍
  const lease = acquirePdf({ paperId: paper.id, fileHash: paper.fileHash });
  const rows: PageText[] = [];
  try {
    const doc = await lease.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent(TEXT_CONTENT_PARAMS);
      const items = content.items.filter((it) => "str" in it);
      rows.push({ paperId: paper.id, page: n, text: normalizeItems(items).text, fileHash: paper.fileHash, engineVersion: NORMALIZE_VERSION });
      // 每页之间让出主线程，避免长时间占用影响阅读
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    lease.release();
  }
  await db.transaction("rw", db.pageTexts, db.papers, async () => {
    // 提取期间论文可能被删除或换了文件，此时丢弃结果
    const now = await db.papers.get(paper.id);
    if (!now || now.fileHash !== paper.fileHash) return;
    await db.pageTexts.where("paperId").equals(paper.id).delete();
    await db.pageTexts.bulkPut(rows);
    if (now.pageCount !== rows.length) await db.papers.update(paper.id, { pageCount: rows.length });
  });
  return rows.map(({ page, text }) => ({ page, text }));
}

/** 换文件或删除论文前调用：清掉该论文的全文缓存 */
export async function invalidatePageTexts(paperId: string): Promise<void> {
  await db.pageTexts.where("paperId").equals(paperId).delete();
}
