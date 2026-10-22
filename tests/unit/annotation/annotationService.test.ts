// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import {
  createAnnotation,
  deleteAnnotation,
  fillAnnotationRects,
  markAnnotationOrphaned,
  restoreAnnotation,
  setAnnotationColor,
  setAnnotationNote,
} from "@/services/annotationService";
import type { Paper, SelectionAnchor, Term } from "@/types/models";

const paper: Paper = { id: "p1", fileHash: "h1", title: "P", authors: [], domainIds: [], pageCount: 3, addedAt: 0 };
const anchor: SelectionAnchor = {
  paperId: "p1",
  page: 2,
  rects: [[72, 700, 200, 712]],
  quote: { exact: "Long Short-Term Memory", prefix: "before ", suffix: " after" },
  fileHash: "h1",
};
const term = (id: string, sourceAnnotationId?: string): Term => ({
  id,
  name: id,
  aliases: [],
  matchMode: "auto",
  scope: { kind: "global" },
  note: "",
  ...(sourceAnnotationId ? { sourceAnnotationId } : {}),
  createdAt: 0,
  updatedAt: 0,
});

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await db.papers.add(paper);
});

describe("createAnnotation", () => {
  it("stores the anchor, color and note", async () => {
    const a = await createAnnotation(anchor, { color: "#bbf7d0", note: "hi", now: 5 });
    const got = await db.annotations.get(a.id);
    expect(got).toMatchObject({
      paperId: "p1",
      page: 2,
      rects: [[72, 700, 200, 712]],
      quote: anchor.quote,
      fileHash: "h1",
      anchorStatus: "ok",
      color: "#bbf7d0",
      note: "hi",
      createdAt: 5,
      updatedAt: 5,
    });
  });

  it("updates note and color", async () => {
    const a = await createAnnotation(anchor, { color: "#bbf7d0", now: 1 });
    await setAnnotationNote(a.id, "**note**");
    await setAnnotationColor(a.id, "#fde68a");
    const got = await db.annotations.get(a.id);
    expect(got?.note).toBe("**note**");
    expect(got?.color).toBe("#fde68a");
    expect(got!.updatedAt).toBeGreaterThan(1);
  });
});

describe("deleteAnnotation", () => {
  it("cascades to links, board nodes and term sources, and can be undone", async () => {
    const a = await createAnnotation(anchor, { color: "#fde68a" });
    const keep = await createAnnotation(anchor, { color: "#fde68a" });
    await db.links.bulkAdd([
      { id: "l1", from: { kind: "annotation", id: a.id }, to: { kind: "term", id: "t1" }, relation: "supports", createdAt: 0 },
      { id: "l2", from: { kind: "note", id: "n1" }, to: { kind: "annotation", id: a.id }, relation: "extends", createdAt: 0 },
      // 同 id 但类型不同：不能删
      { id: "l3", from: { kind: "term", id: a.id }, to: { kind: "paper", id: "p1" }, relation: "partOf", createdAt: 0 },
      { id: "l4", from: { kind: "annotation", id: keep.id }, to: { kind: "term", id: "t1" }, relation: "supports", createdAt: 0 },
    ]);
    await db.boardNodes.bulkAdd([
      { id: "b1", boardId: "B", ref: { kind: "annotation", id: a.id }, x: 0, y: 0, w: 1, h: 1 },
      { id: "b2", boardId: "B", ref: { kind: "term", id: a.id }, x: 0, y: 0, w: 1, h: 1 },
    ]);
    await db.terms.bulkAdd([term("t1", a.id), term("t2", keep.id), term("t3")]);
    await db.notes.add({ id: "n1", text: "", createdAt: 0, updatedAt: 0 });
    await db.boards.add({ id: "B", name: "画布", domainIds: [], createdAt: 0, updatedAt: 0 });

    const snap = await deleteAnnotation(a.id);
    expect(snap?.annotation.id).toBe(a.id);
    expect(await db.annotations.get(a.id)).toBeUndefined();
    expect((await db.links.toArray()).map((l) => l.id).sort()).toEqual(["l3", "l4"]);
    expect((await db.boardNodes.toArray()).map((b) => b.id)).toEqual(["b2"]);
    expect((await db.terms.get("t1"))?.sourceAnnotationId).toBeUndefined();
    expect((await db.terms.get("t2"))?.sourceAnnotationId).toBe(keep.id);
    expect(snap?.termIds).toEqual(["t1"]);

    await restoreAnnotation(snap!);
    expect(await db.annotations.get(a.id)).toEqual(snap!.annotation);
    expect((await db.links.toArray()).map((l) => l.id).sort()).toEqual(["l1", "l2", "l3", "l4"]);
    expect((await db.boardNodes.toArray()).map((b) => b.id).sort()).toEqual(["b1", "b2"]);
    expect((await db.terms.get("t1"))?.sourceAnnotationId).toBe(a.id);
  });

  it("does not resurrect references to things deleted in the meantime (#7)", async () => {
    await db.terms.add(term("t1"));
    await db.notes.add({ id: "n1", text: "", createdAt: 0, updatedAt: 0 });
    await db.boards.bulkAdd([
      { id: "B1", name: "留下", domainIds: [], createdAt: 0, updatedAt: 0 },
      { id: "B2", name: "删掉", domainIds: [], createdAt: 0, updatedAt: 0 },
    ]);
    // 术语"首次定义处"批注
    const a = await createAnnotation(anchor, { color: "#fde68a" });
    await db.annotations.update(a.id, { termId: "t1" });
    await db.terms.update("t1", { sourceAnnotationId: a.id });
    const other = await createAnnotation(anchor, { color: "#fde68a" });
    await db.links.bulkAdd([
      { id: "toTerm", from: { kind: "annotation", id: a.id }, to: { kind: "term", id: "t1" }, relation: "supports", createdAt: 0 },
      { id: "toNote", from: { kind: "annotation", id: a.id }, to: { kind: "note", id: "n1" }, relation: "supports", createdAt: 0 },
      { id: "toAnn", from: { kind: "annotation", id: other.id }, to: { kind: "annotation", id: a.id }, relation: "extends", createdAt: 0 },
      { id: "toPaper", from: { kind: "annotation", id: a.id }, to: { kind: "paper", id: "p1" }, relation: "partOf", createdAt: 0 },
    ]);
    await db.boardNodes.bulkAdd([
      { id: "nb1", boardId: "B1", ref: { kind: "annotation", id: a.id }, x: 0, y: 0, w: 1, h: 1 },
      { id: "nb2", boardId: "B2", ref: { kind: "annotation", id: a.id }, x: 0, y: 0, w: 1, h: 1 },
    ]);

    const snap = (await deleteAnnotation(a.id))!;
    // 撤销窗口内：删掉术语、另一条批注和一块画布
    await db.terms.delete("t1");
    await db.annotations.delete(other.id);
    await db.boards.delete("B2");
    await restoreAnnotation(snap);

    const restored = await db.annotations.get(a.id);
    expect(restored).toBeDefined();
    expect(restored!.termId).toBeUndefined();
    expect((await db.links.toArray()).map((l) => l.id).sort()).toEqual(["toNote", "toPaper"]);
    expect((await db.boardNodes.toArray()).map((n) => n.id)).toEqual(["nb1"]);
    expect(await db.terms.count()).toBe(0);
  });

  it("returns null for a missing annotation", async () => {
    expect(await deleteAnnotation("nope")).toBeNull();
  });

  it("does not restore when the paper is gone", async () => {
    const a = await createAnnotation(anchor, { color: "#fde68a" });
    const snap = await deleteAnnotation(a.id);
    await db.papers.delete("p1");
    await restoreAnnotation(snap!);
    expect(await db.annotations.count()).toBe(0);
  });
});

describe("relocated rects", () => {
  it("fills rects only when empty and the file matches", async () => {
    const a = await createAnnotation({ ...anchor, rects: [] }, { color: "#fde68a" });
    await fillAnnotationRects(a.id, "other", [[1, 2, 3, 4]]);
    expect((await db.annotations.get(a.id))?.rects).toEqual([]);
    await fillAnnotationRects(a.id, "h1", [[1, 2, 3, 4]]);
    expect((await db.annotations.get(a.id))?.rects).toEqual([[1, 2, 3, 4]]);
    await fillAnnotationRects(a.id, "h1", [[9, 9, 9, 9]]);
    expect((await db.annotations.get(a.id))?.rects).toEqual([[1, 2, 3, 4]]);
  });

  it("marks orphaned only while rects are still empty", async () => {
    const a = await createAnnotation({ ...anchor, rects: [] }, { color: "#fde68a" });
    const b = await createAnnotation(anchor, { color: "#fde68a" });
    await markAnnotationOrphaned(a.id, "h1");
    await markAnnotationOrphaned(b.id, "h1");
    expect((await db.annotations.get(a.id))?.anchorStatus).toBe("orphaned");
    expect((await db.annotations.get(b.id))?.anchorStatus).toBe("ok");
  });
});
