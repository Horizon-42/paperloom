// @vitest-environment node
// jsdom 的 Blob 经 fake-indexeddb 结构化克隆后会变成普通对象，这里用 node 环境
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import type { Annotation, Domain, Paper, Term } from "@/types/models";
import {
  addPaperToDomain,
  deletePaper,
  importPdf,
  importPdfs,
  removePaperFromDomains,
  updatePaperMetadata,
  type ImportSource,
  type PdfInfo,
  type PdfInfoReader,
} from "@/services/paperService";
import { createDomain, deleteDomain, getDomainDeleteImpact, moveDomain } from "@/services/domainService";

/** 最小的"PDF"：带 %PDF- 头即可通过检查；内容不同则哈希不同 */
function fakePdf(name: string, body = name): ImportSource {
  const bytes = new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF`);
  return { name, arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer };
}

const fakeReader =
  (info: Partial<PdfInfo> = {}): PdfInfoReader =>
  async () => ({ pageCount: 3, ...info });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("importPdf", () => {
  it("adds a paper and its file", async () => {
    const out = await importPdf(fakePdf("Zhang2021_some_paper.pdf"), {
      readInfo: fakeReader({ title: "Some Paper", author: "A One; B Two", creationDate: "D:2023" }),
      now: () => 42,
    });
    expect(out.status).toBe("added");
    if (out.status !== "added") return;
    const p = await db.papers.get(out.paper.id);
    expect(p).toMatchObject({ title: "Some Paper", authors: ["A One", "B Two"], year: 2021, pageCount: 3, addedAt: 42, domainIds: [] });
    const f = await db.files.get(p!.fileHash);
    expect(f?.blob).toBeInstanceOf(Blob);
    expect(f?.size).toBeGreaterThan(0);
    expect(p!.fileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("deduplicates by file hash", async () => {
    const first = await importPdf(fakePdf("a.pdf", "same"), { readInfo: fakeReader() });
    const second = await importPdf(fakePdf("b-renamed.pdf", "same"), { readInfo: fakeReader() });
    expect(first.status).toBe("added");
    expect(second.status).toBe("duplicate");
    if (first.status === "added" && second.status === "duplicate") expect(second.paper.id).toBe(first.paper.id);
    expect(await db.papers.count()).toBe(1);
    expect(await db.files.count()).toBe(1);
  });

  it("falls back to the file name when the metadata title is meaningless", async () => {
    const out = await importPdf(fakePdf("Deep_Trajectory_Model.pdf"), {
      readInfo: fakeReader({ title: "Microsoft Word - draft_v3.docx" }),
    });
    expect(out.status === "added" && out.paper.title).toBe("Deep Trajectory Model");
    const out2 = await importPdf(fakePdf("12345.pdf"), { readInfo: fakeReader({ title: "  " }) });
    expect(out2.status === "added" && out2.paper.title).toBe("12345");
  });

  it("files the paper into the selected domain if it exists", async () => {
    const dom = await createDomain({ name: "ATM" });
    const a = await importPdf(fakePdf("a.pdf"), { readInfo: fakeReader(), domainId: dom.id });
    const b = await importPdf(fakePdf("b.pdf"), { readInfo: fakeReader(), domainId: "missing" });
    expect(a.status === "added" && a.paper.domainIds).toEqual([dom.id]);
    expect(b.status === "added" && b.paper.domainIds).toEqual([]);
  });

  it("reports failures without throwing", async () => {
    const notPdf: ImportSource = { name: "notes.txt", arrayBuffer: async () => new TextEncoder().encode("hello").buffer as ArrayBuffer };
    const unreadable: ImportSource = { name: "gone.pdf", arrayBuffer: () => Promise.reject(new Error("io")) };
    const broken = await importPdf(fakePdf("broken.pdf"), {
      readInfo: async () => {
        throw Object.assign(new Error("bad xref"), { name: "InvalidPDFException" });
      },
    });
    expect(await importPdf(notPdf)).toMatchObject({ status: "failed", error: "不是 PDF 文件" });
    expect(await importPdf(unreadable)).toMatchObject({ status: "failed", error: "无法读取文件" });
    expect(broken).toMatchObject({ status: "failed", error: "文件已损坏或不是有效的 PDF" });
    expect(await db.papers.count()).toBe(0);
    expect(await db.files.count()).toBe(0);
  });

  it("imports many files, one failure does not stop the rest", async () => {
    const progress: number[] = [];
    const summary = await importPdfs(
      [fakePdf("a.pdf"), fakePdf("bad.pdf"), fakePdf("b.pdf"), fakePdf("a-copy.pdf", "a.pdf")],
      {
        readInfo: async (data) => {
          if (new TextDecoder().decode(data).includes("bad")) throw new Error("boom");
          return { pageCount: 1 };
        },
        onProgress: (done) => progress.push(done),
      },
    );
    expect(summary.added.map((o) => o.fileName)).toEqual(["a.pdf", "b.pdf"]);
    expect(summary.duplicates.map((o) => o.fileName)).toEqual(["a-copy.pdf"]);
    expect(summary.failed).toEqual([{ status: "failed", fileName: "bad.pdf", error: "boom" }]);
    expect(progress).toEqual([1, 2, 3, 4]);
  });
});

describe("paper editing", () => {
  it("updates metadata and domains", async () => {
    const out = await importPdf(fakePdf("x2020.pdf"), { readInfo: fakeReader() });
    if (out.status !== "added") throw new Error();
    const id = out.paper.id;
    await updatePaperMetadata(id, { title: "  New  title ", authors: ["A", " ", "A", "B"], year: null, domainIds: ["d1", "d1"] });
    const p = (await db.papers.get(id))!;
    expect(p.title).toBe("New title");
    expect(p.authors).toEqual(["A", "B"]);
    expect("year" in p).toBe(false);
    expect(p.domainIds).toEqual(["d1"]);
    await updatePaperMetadata(id, { title: "   ", year: 1999 });
    expect((await db.papers.get(id))!).toMatchObject({ title: "New title", year: 1999 });
  });

  it("adds to and removes from domains", async () => {
    const d1 = await createDomain({ name: "A" });
    const d2 = await createDomain({ name: "B" });
    const out = await importPdf(fakePdf("x.pdf"), { readInfo: fakeReader(), domainId: d1.id });
    if (out.status !== "added") throw new Error();
    expect(await addPaperToDomain(out.paper.id, d2.id)).toBe(true);
    expect(await addPaperToDomain(out.paper.id, d2.id)).toBe(false);
    expect(await addPaperToDomain(out.paper.id, "missing")).toBe(false);
    expect((await db.papers.get(out.paper.id))!.domainIds).toEqual([d1.id, d2.id]);
    await removePaperFromDomains(out.paper.id, [d1.id]);
    expect((await db.papers.get(out.paper.id))!.domainIds).toEqual([d2.id]);
  });
});

function annotation(id: string, paperId: string): Annotation {
  return {
    id,
    paperId,
    page: 1,
    rects: [[0, 0, 1, 1]],
    quote: { exact: "x", prefix: "", suffix: "" },
    fileHash: "h",
    color: "yellow",
    note: "",
    createdAt: 1,
    updatedAt: 1,
  };
}

function term(id: string, extra: Partial<Term> = {}): Term {
  return { id, name: id, aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 1, updatedAt: 1, ...extra };
}

describe("deletePaper cascade", () => {
  it("removes everything that hangs off the paper and nothing else", async () => {
    const a = await importPdf(fakePdf("a.pdf"), { readInfo: fakeReader() });
    const b = await importPdf(fakePdf("b.pdf"), { readInfo: fakeReader() });
    if (a.status !== "added" || b.status !== "added") throw new Error();
    const pa = a.paper.id;
    const pb = b.paper.id;

    await db.annotations.bulkAdd([annotation("a1", pa), annotation("a2", pa), annotation("b1", pb)]);
    await db.occurrences.bulkAdd([
      { termId: "t1", paperId: pa, pages: [1], count: 1, engineVersion: 1 },
      { termId: "t1", paperId: pb, pages: [1], count: 1, engineVersion: 1 },
    ]);
    await db.pageTexts.bulkAdd([
      { paperId: pa, page: 1, text: "x", fileHash: "ha", engineVersion: 1 },
      { paperId: pb, page: 1, text: "y", fileHash: "hb", engineVersion: 1 },
    ]);
    await db.links.bulkAdd([
      { id: "l1", from: { kind: "annotation", id: "a1" }, to: { kind: "term", id: "t1" }, relation: "supports", createdAt: 1 },
      { id: "l2", from: { kind: "note", id: "n1" }, to: { kind: "paper", id: pa }, relation: "partOf", createdAt: 1 },
      { id: "l3", from: { kind: "annotation", id: "b1" }, to: { kind: "annotation", id: "a2" }, relation: "extends", createdAt: 1 },
      { id: "keep", from: { kind: "annotation", id: "b1" }, to: { kind: "paper", id: pb }, relation: "partOf", createdAt: 1 },
      // 同 id 但不同类型的实体不受影响
      { id: "keep2", from: { kind: "term", id: "a1" }, to: { kind: "note", id: pa }, relation: "custom", createdAt: 1 },
    ]);
    await db.boardNodes.bulkAdd([
      { id: "n-a1", boardId: "bd", ref: { kind: "annotation", id: "a1" }, x: 0, y: 0, w: 1, h: 1 },
      { id: "n-pa", boardId: "bd", ref: { kind: "paper", id: pa }, x: 0, y: 0, w: 1, h: 1 },
      { id: "n-b1", boardId: "bd", ref: { kind: "annotation", id: "b1" }, x: 0, y: 0, w: 1, h: 1 },
    ]);
    await db.terms.bulkAdd([term("t1", { sourceAnnotationId: "a1" }), term("t2", { sourceAnnotationId: "b1" }), term("t3")]);

    await deletePaper(pa);

    expect(await db.papers.get(pa)).toBeUndefined();
    expect(await db.files.get(a.paper.fileHash)).toBeUndefined();
    expect(await db.files.get(b.paper.fileHash)).toBeDefined();
    expect((await db.annotations.toArray()).map((x) => x.id)).toEqual(["b1"]);
    expect((await db.occurrences.toArray()).map((x) => x.paperId)).toEqual([pb]);
    expect((await db.pageTexts.toArray()).map((x) => x.paperId)).toEqual([pb]);
    expect((await db.links.toArray()).map((x) => x.id).sort()).toEqual(["keep", "keep2"]);
    expect((await db.boardNodes.toArray()).map((x) => x.id)).toEqual(["n-b1"]);
    const terms = await db.terms.toArray();
    expect(terms.find((t) => t.id === "t1")).not.toHaveProperty("sourceAnnotationId");
    expect(terms.find((t) => t.id === "t2")!.sourceAnnotationId).toBe("b1");
    expect(terms).toHaveLength(3);
  });

  it("re-importing after delete works and missing ids are ignored", async () => {
    const a = await importPdf(fakePdf("a.pdf"), { readInfo: fakeReader() });
    if (a.status !== "added") throw new Error();
    await deletePaper(a.paper.id);
    expect(await db.files.count()).toBe(0);
    await deletePaper("missing");
    expect((await importPdf(fakePdf("a.pdf"), { readInfo: fakeReader() })).status).toBe("added");
  });

  it("restores a missing blob when a duplicate is imported", async () => {
    const a = await importPdf(fakePdf("a.pdf"), { readInfo: fakeReader() });
    if (a.status !== "added") throw new Error();
    await db.files.clear();
    expect((await importPdf(fakePdf("a.pdf"), { readInfo: fakeReader() })).status).toBe("duplicate");
    expect(await db.files.get(a.paper.fileHash)).toBeDefined();
  });
});

describe("domains", () => {
  it("creates root and child domains with increasing order", async () => {
    const a = await createDomain({ name: " ATM " });
    const b = await createDomain({});
    const c = await createDomain({ name: "轨迹预测", parentId: a.id });
    const d = await createDomain({ name: "x", parentId: "missing" });
    expect([a.order, b.order, d.order]).toEqual([0, 1, 2]);
    expect(a.name).toBe("ATM");
    expect(b.name).toBe("新领域");
    expect(c).toMatchObject({ parentId: a.id, order: 0 });
    expect(d.parentId).toBeNull();
    expect(a.color).not.toBe(b.color);
  });

  it("moves domains and refuses cycles", async () => {
    const a = await createDomain({ name: "A" });
    const b = await createDomain({ name: "B", parentId: a.id });
    expect(await moveDomain(a.id, { targetId: b.id, position: "inside" })).toBe(false);
    expect((await db.domains.get(a.id))!.parentId).toBeNull();
    const c = await createDomain({ name: "C" });
    expect(await moveDomain(c.id, { targetId: b.id, position: "before" })).toBe(true);
    const domains = await db.domains.toArray();
    const byId = new Map(domains.map((x) => [x.id, x] as const));
    expect(byId.get(c.id)).toMatchObject({ parentId: a.id, order: 0 });
    expect(byId.get(b.id)).toMatchObject({ parentId: a.id, order: 1 });
  });

  it("deletes a domain subtree and cleans references", async () => {
    const root = await createDomain({ name: "ATM" });
    const child = await createDomain({ name: "轨迹预测", parentId: root.id });
    const grandchild = await createDomain({ name: "LSTM", parentId: child.id });
    const other = await createDomain({ name: "ML" });

    const mk = async (name: string, domainIds: string[]) => {
      const o = await importPdf(fakePdf(name), { readInfo: fakeReader() });
      if (o.status !== "added") throw new Error();
      await updatePaperMetadata(o.paper.id, { domainIds });
      return o.paper.id;
    };
    const p1 = await mk("p1.pdf", [grandchild.id, other.id]);
    const p2 = await mk("p2.pdf", [root.id]);
    const p3 = await mk("p3.pdf", [other.id]);

    await db.terms.bulkAdd([
      term("onlyDeleted", { scope: { kind: "domains", domainIds: [child.id] } }),
      term("mixed", { scope: { kind: "domains", domainIds: [grandchild.id, other.id] } }),
      term("untouched", { scope: { kind: "domains", domainIds: [other.id] } }),
      term("global"),
    ]);
    await db.boards.add({ id: "bd", name: "b", domainIds: [root.id, other.id], createdAt: 1, updatedAt: 1 });

    const impact = await getDomainDeleteImpact(child.id);
    expect(impact).toMatchObject({ descendantCount: 1, paperCount: 1, termCount: 2 });
    expect((await getDomainDeleteImpact(root.id))!).toMatchObject({ descendantCount: 2, paperCount: 2, termCount: 2 });

    const deleted = await deleteDomain(root.id);
    expect(deleted.sort()).toEqual([root.id, child.id, grandchild.id].sort());
    expect((await db.domains.toArray()).map((x) => x.id)).toEqual([other.id]);

    const papers = new Map((await db.papers.toArray()).map((p): [string, Paper] => [p.id, p]));
    expect(papers.size).toBe(3);
    expect(papers.get(p1)!.domainIds).toEqual([other.id]);
    expect(papers.get(p2)!.domainIds).toEqual([]);
    expect(papers.get(p3)!.domainIds).toEqual([other.id]);

    const terms = new Map((await db.terms.toArray()).map((t): [string, Term] => [t.id, t]));
    expect(terms.get("onlyDeleted")!.scope).toEqual({ kind: "domains", domainIds: [] }); // 不改成全局
    expect(terms.get("mixed")!.scope).toEqual({ kind: "domains", domainIds: [other.id] });
    expect(terms.get("untouched")!.scope).toEqual({ kind: "domains", domainIds: [other.id] });
    expect(terms.get("global")!.scope).toEqual({ kind: "global" });
    expect((await db.boards.get("bd"))!.domainIds).toEqual([other.id]);

    expect(await deleteDomain("missing")).toEqual([]);
  });

  it("returns null impact for a missing domain", async () => {
    expect(await getDomainDeleteImpact("nope")).toBeNull();
    const d: Domain | undefined = await db.domains.get("nope");
    expect(d).toBeUndefined();
  });
});
