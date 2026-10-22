// @vitest-environment node
// jsdom 的 Blob 经 fake-indexeddb 结构化克隆后会变成普通对象，这里用 node 环境
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/schema";
import { makeQuote } from "@/engine/anchor";
import { MATCH_VERSION, NORMALIZE_VERSION } from "@/engine/types";
import { sha256Hex } from "@/lib/hash";
import type { Annotation, Paper } from "@/types/models";

// 全文提取依赖 pdf.js：测试里由 texts[hash] 提供"新文件"的每页文本，按 pageTextService 的约定写缓存；
// failHashes 里的文件提取时抛错（模拟新 PDF 无法提取全文）
const texts: Record<string, string[]> = {};
const failHashes = new Set<string>();
const extractCalls: string[] = [];
vi.mock("@/services/pageTextService", async () => {
  const { db } = await import("@/db/schema");
  const { NORMALIZE_VERSION } = await import("@/engine/types");
  const getCachedPageTexts = async (paperId: string) => {
    const paper = await db.papers.get(paperId);
    if (!paper) return null;
    const rows = await db.pageTexts.where("paperId").equals(paperId).toArray();
    if (!rows.length || rows.length !== paper.pageCount || rows.some((r) => r.fileHash !== paper.fileHash)) return null;
    return rows.sort((a, b) => a.page - b.page).map(({ page, text }) => ({ page, text }));
  };
  return {
    getCachedPageTexts,
    ensurePageTexts: async (paperId: string) => {
      const cached = await getCachedPageTexts(paperId);
      if (cached) return cached;
      const paper = (await db.papers.get(paperId))!;
      extractCalls.push(paper.fileHash);
      if (failHashes.has(paper.fileHash)) throw new Error("提取全文失败");
      const pages = (texts[paper.fileHash] ?? []).map((text, i) => ({ page: i + 1, text }));
      await db.pageTexts.bulkPut(pages.map((p) => ({ paperId, ...p, fileHash: paper.fileHash, engineVersion: NORMALIZE_VERSION })));
      return pages;
    },
    invalidatePageTexts: async (paperId: string) => {
      await db.pageTexts.where("paperId").equals(paperId).delete();
    },
  };
});
const scheduleIndex = vi.fn();
vi.mock("@/services/indexer", () => ({ scheduleIndex: (o: unknown) => scheduleIndex(o), startIndexer: () => {} }));

const { planReanchor, reanchorPaper, replacePaperFile, needsReanchor, ensureAnchored, backoffDelay, inReanchorBackoff, resetReanchorBackoff } =
  await import("@/services/reanchorService");

const V1 = [
  "1. Introduction. Long Short-Term Memory networks are recurrent models.",
  "2. Method. We train a stacked LSTM on surveillance data from radar.",
  "3. Removed section. This sentence only exists in the first version.",
];
const V2 = [
  "Preface added in version two.",
  "1. Introduction. Long Short-Term Memory networks are recurrent models.",
  "2. Method. We train a stacked LSTM on surveillance data from radar.",
];

function quoteOf(pageText: string, exact: string) {
  const i = pageText.indexOf(exact);
  if (i < 0) throw new Error(`"${exact}" not in page`);
  return makeQuote(pageText, i, i + exact.length);
}

let n = 0;
function ann(page: number, exact: string, fileHash: string, extra: Partial<Annotation> = {}): Annotation {
  n++;
  return {
    id: `a${n}`,
    paperId: "p1",
    page,
    rects: [[72, 700, 200, 712]],
    quote: quoteOf(V1[page - 1], exact),
    fileHash,
    color: "#fde68a",
    note: "",
    createdAt: n,
    updatedAt: n,
    ...extra,
  };
}

const pdfBytes = (body: string) => new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF`);
const source = (bytes: Uint8Array) => ({ name: "v.pdf", arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer });
const readInfo = (pageCount: number) => async () => ({ pageCount });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  scheduleIndex.mockClear();
  failHashes.clear();
  extractCalls.length = 0;
  resetReanchorBackoff();
});

describe("planReanchor", () => {
  const pages = V2.map((text, i) => ({ page: i + 1, text }));

  it("relocates moved quotes, orphans missing ones and restores when the original file is back", () => {
    const moved = ann(1, "Long Short-Term Memory", "old");
    const gone = ann(3, "only exists in the first version", "old");
    const fine = ann(2, "stacked LSTM", "new");
    const back = ann(2, "stacked LSTM", "new", { anchorStatus: "orphaned" });
    const plan = planReanchor([moved, gone, fine, back], "new", pages);
    expect(plan).toEqual([
      { id: moved.id, kind: "relocated", page: 2, fileHash: "new" },
      { id: gone.id, kind: "orphaned" },
      { id: back.id, kind: "restored" },
    ]);
  });

  it("skips already orphaned annotations unless asked to retry", () => {
    const o = ann(2, "stacked LSTM", "old", { anchorStatus: "orphaned" });
    expect(planReanchor([o], "new", pages)).toEqual([]);
    expect(planReanchor([o], "new", pages, { retryOrphaned: true })).toEqual([{ id: o.id, kind: "relocated", page: 3, fileHash: "new" }]);
    // 重试仍找不到时不重复写
    const o2 = ann(3, "only exists in the first version", "old", { anchorStatus: "orphaned" });
    expect(planReanchor([o2], "new", pages, { retryOrphaned: true })).toEqual([]);
  });

  it("needsReanchor", () => {
    const r: [number, number, number, number][] = [[1, 2, 3, 4]];
    expect(needsReanchor({ fileHash: "a", anchorStatus: "ok", rects: r }, "a")).toBe(false);
    expect(needsReanchor({ fileHash: "a", rects: r }, "b")).toBe(true);
    expect(needsReanchor({ fileHash: "a", anchorStatus: "orphaned", rects: r }, "b")).toBe(false);
    expect(needsReanchor({ fileHash: "a", anchorStatus: "orphaned", rects: r }, "b", { retryOrphaned: true })).toBe(true);
    expect(needsReanchor({ fileHash: "a", anchorStatus: "orphaned", rects: r }, "a")).toBe(true);
    // 同一文件上补算矩形失败的未定位批注：不恢复
    expect(needsReanchor({ fileHash: "a", anchorStatus: "orphaned", rects: [] }, "a")).toBe(false);
  });

  it("keeps an orphaned annotation without rects orphaned instead of restoring it (#5)", () => {
    // 重新定位后在该页补算矩形失败 → orphaned 且 rects 为空、fileHash 已是当前文件
    const failed = ann(2, "stacked LSTM", "new", { anchorStatus: "orphaned", rects: [] });
    const back = ann(2, "stacked LSTM", "new", { anchorStatus: "orphaned" });
    expect(planReanchor([failed, back], "new", pages)).toEqual([{ id: back.id, kind: "restored" }]);
    expect(planReanchor([failed], "new", pages, { retryOrphaned: true })).toEqual([]);
  });
});

describe("reanchorPaper / ensureAnchored", () => {
  it("re-anchors annotations whose fileHash differs (e.g. restored from a backup)", async () => {
    texts.cur = V2;
    const paper: Paper = { id: "p1", fileHash: "cur", title: "P", authors: [], domainIds: [], pageCount: 3, addedAt: 0 };
    await db.papers.add(paper);
    const moved = ann(2, "stacked LSTM", "old");
    const gone = ann(3, "only exists in the first version", "old");
    const ok = ann(1, "Introduction", "cur");
    await db.annotations.bulkAdd([moved, gone, ok]);

    expect(ensureAnchored(paper, [ok])).toBeNull();
    const res = await ensureAnchored(paper, await db.annotations.toArray());
    expect(res).toEqual({ relocated: 1, orphaned: 1, restored: 0 });
    expect(await db.annotations.get(moved.id)).toMatchObject({ page: 3, fileHash: "cur", anchorStatus: "relocated", rects: [] });
    expect(await db.annotations.get(gone.id)).toMatchObject({ page: 3, fileHash: "old", anchorStatus: "orphaned", rects: moved.rects });
    expect(await db.annotations.get(ok.id)).toEqual(ok);
    // 再次执行无事可做
    expect(await reanchorPaper("p1")).toEqual({ relocated: 0, orphaned: 0, restored: 0 });
  });

  it("does not flip an orphaned annotation with empty rects back to ok (#5)", async () => {
    const paper: Paper = { id: "p1", fileHash: "cur", title: "P", authors: [], domainIds: [], pageCount: 3, addedAt: 0 };
    await db.papers.add(paper);
    const failed = ann(2, "stacked LSTM", "cur", { anchorStatus: "orphaned", rects: [] });
    await db.annotations.add(failed);
    expect(ensureAnchored(paper, [failed])).toBeNull();
    expect(await reanchorPaper("p1", { retryOrphaned: true })).toEqual({ relocated: 0, orphaned: 0, restored: 0 });
    expect(await db.annotations.get(failed.id)).toEqual(failed);
  });

  it("backs off after a failure for the same paper and file (#11)", async () => {
    failHashes.add("bad");
    const paper: Paper = { id: "p1", fileHash: "bad", title: "P", authors: [], domainIds: [], pageCount: 3, addedAt: 0 };
    await db.papers.add(paper);
    const a = ann(2, "stacked LSTM", "old");
    await db.annotations.add(a);
    const anns = [a];

    await expect(ensureAnchored(paper, anns)).rejects.toThrow("提取全文失败");
    expect(extractCalls).toEqual(["bad"]);
    // 退避期内：每次数据变化都不再重新提取
    expect(ensureAnchored(paper, anns)).toBeNull();
    expect(ensureAnchored(paper, anns, Date.now() + backoffDelay(1) - 1000)).toBeNull();
    expect(inReanchorBackoff("p1", "bad")).toBe(true);
    // 别的文件不受影响
    expect(inReanchorBackoff("p1", "other")).toBe(false);
    // 过了退避期再试；再次失败后等待时间加倍
    await expect(ensureAnchored(paper, anns, Date.now() + backoffDelay(1) + 1)).rejects.toThrow();
    expect(extractCalls).toEqual(["bad", "bad"]);
    expect(ensureAnchored(paper, anns, Date.now() + backoffDelay(1) + 1)).toBeNull();
    expect(backoffDelay(2)).toBe(2 * backoffDelay(1));
    expect(backoffDelay(50)).toBe(10 * 60_000);

    // 成功后清除记录
    failHashes.clear();
    texts.bad = V2;
    expect(await reanchorPaper("p1")).toMatchObject({ relocated: 1 });
    expect(inReanchorBackoff("p1", "bad")).toBe(false);
    expect(await db.annotations.get(a.id)).toMatchObject({ page: 3, fileHash: "bad", anchorStatus: "relocated" });
  });
});

describe("replacePaperFile", () => {
  const v1 = pdfBytes("version one");
  const v2 = pdfBytes("version two");

  async function setup() {
    const h1 = await sha256Hex(v1.buffer.slice(0) as ArrayBuffer);
    const h2 = await sha256Hex(v2.buffer.slice(0) as ArrayBuffer);
    texts[h1] = V1;
    texts[h2] = V2;
    await db.papers.add({ id: "p1", fileHash: h1, title: "P", authors: [], domainIds: [], pageCount: 3, addedAt: 0 });
    await db.files.put({ hash: h1, blob: new Blob([v1]), size: v1.length });
    await db.pageTexts.bulkPut(V1.map((text, i) => ({ paperId: "p1", page: i + 1, text, fileHash: h1, engineVersion: NORMALIZE_VERSION })));
    await db.occurrences.put({ termId: "t", paperId: "p1", pages: [1], count: 1, engineVersion: MATCH_VERSION });
    const moved = ann(1, "Long Short-Term Memory", h1);
    const gone = ann(3, "only exists in the first version", h1);
    await db.annotations.bulkAdd([moved, gone]);
    return { h1, h2, moved, gone };
  }

  it("replaces the file, clears caches, re-anchors and schedules indexing", async () => {
    const { h1, h2, moved, gone } = await setup();
    const out = await replacePaperFile("p1", source(v2), { readInfo: readInfo(3) });
    expect(out).toEqual({ status: "replaced", pageCount: 3, reanchorFailed: false, relocated: 1, orphaned: 1, restored: 0 });
    const p = await db.papers.get("p1");
    expect(p).toMatchObject({ fileHash: h2, pageCount: 3 });
    expect(await db.files.get(h1)).toBeUndefined();
    expect((await db.files.get(h2))?.size).toBe(v2.length);
    expect(await db.occurrences.where("paperId").equals("p1").count()).toBe(0);
    // 全文缓存已按新文件重建
    expect((await db.pageTexts.where("paperId").equals("p1").toArray()).every((r) => r.fileHash === h2)).toBe(true);
    expect(await db.annotations.get(moved.id)).toMatchObject({ page: 2, fileHash: h2, anchorStatus: "relocated", rects: [] });
    expect(await db.annotations.get(gone.id)).toMatchObject({ page: 3, fileHash: h1, anchorStatus: "orphaned" });
    expect(scheduleIndex).toHaveBeenCalledWith({ paperIds: ["p1"] });

    // 换回旧文件：未定位的批注恢复，已重新定位的再定位回去
    const back = await replacePaperFile("p1", source(v1), { readInfo: readInfo(3) });
    expect(back).toMatchObject({ status: "replaced", relocated: 1, restored: 1, orphaned: 0 });
    expect(await db.annotations.get(gone.id)).toMatchObject({ fileHash: h1, anchorStatus: "ok", rects: gone.rects });
    expect(await db.annotations.get(moved.id)).toMatchObject({ page: 1, fileHash: h1, anchorStatus: "relocated" });
  });

  it("still reports replaced when re-anchoring fails after the swap (#3)", async () => {
    const { h1, h2, moved, gone } = await setup();
    failHashes.add(h2);
    const out = await replacePaperFile("p1", source(v2), { readInfo: readInfo(3) });
    expect(out).toEqual({ status: "replaced", pageCount: 3, reanchorFailed: true, relocated: 0, orphaned: 0, restored: 0 });
    // 文件确实已经换掉，批注原样保留，等下次打开时重试
    expect((await db.papers.get("p1"))?.fileHash).toBe(h2);
    expect(await db.files.get(h1)).toBeUndefined();
    expect(await db.annotations.get(moved.id)).toEqual(moved);
    expect(await db.annotations.get(gone.id)).toEqual(gone);
    expect(scheduleIndex).toHaveBeenCalledWith({ paperIds: ["p1"] });
    // 再选同一个文件：无需替换（而不是再次"失败"）
    expect(await replacePaperFile("p1", source(v2), { readInfo: readInfo(3) })).toEqual({ status: "unchanged" });
    // 退避期过后打开论文时重试成功
    failHashes.clear();
    const paper = (await db.papers.get("p1"))!;
    const res = await ensureAnchored(paper, await db.annotations.toArray(), Date.now() + backoffDelay(1) + 1);
    expect(res).toEqual({ relocated: 1, orphaned: 1, restored: 0 });
  });

  it("does nothing for the same file", async () => {
    const { h1 } = await setup();
    expect(await replacePaperFile("p1", source(v1), { readInfo: readInfo(3) })).toEqual({ status: "unchanged" });
    expect((await db.papers.get("p1"))?.fileHash).toBe(h1);
    expect(scheduleIndex).not.toHaveBeenCalled();
  });

  it("refuses a file that another paper already uses", async () => {
    const { h1, h2 } = await setup();
    await db.papers.add({ id: "p2", fileHash: h2, title: "Other", authors: [], domainIds: [], pageCount: 3, addedAt: 0 });
    expect(await replacePaperFile("p1", source(v2), { readInfo: readInfo(3) })).toEqual({
      status: "conflict",
      other: { id: "p2", title: "Other" },
    });
    expect((await db.papers.get("p1"))?.fileHash).toBe(h1);
  });

  it("reports a broken PDF and leaves the paper untouched", async () => {
    const { h1 } = await setup();
    const out = await replacePaperFile("p1", source(pdfBytes("not really a pdf")), { readInfo: async () => Promise.reject(new Error("bad")) });
    expect(out).toEqual({ status: "failed", error: "文件已损坏或不是有效的 PDF" });
    expect(await db.files.get(h1)).toBeDefined();
    expect((await db.papers.get("p1"))?.fileHash).toBe(h1);
  });

  it("rejects non-PDF files", async () => {
    await setup();
    const txt = { name: "a.txt", arrayBuffer: async () => new TextEncoder().encode("hello").buffer as ArrayBuffer };
    expect(await replacePaperFile("p1", txt)).toEqual({ status: "failed", error: "不是 PDF 文件" });
  });
});
