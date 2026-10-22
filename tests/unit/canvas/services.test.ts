// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import {
  MIN_NODE_SIZE,
  addNodeToBoard,
  addNodesToBoard,
  entityDeleteImpact,
  boardsContaining,
  cleanBoardName,
  createBoard,
  createNoteOnBoard,
  deleteBoard,
  findNodeForRef,
  loadCanvasExportData,
  moveBoardNodes,
  orphanNotesOfBoard,
  planBoardDeletion,
  removeNodesFromBoard,
  renameBoard,
  resizeBoardNode,
  restoreBoardNodes,
  setBoardDomains,
} from "@/services/canvasService";
import { addLink, createLink, deleteLinks, listLinksFor, restoreLinks, searchEntities, updateLink } from "@/services/linkService";
import { createNote, deleteNote, entityCascade, restoreNote, setNoteText } from "@/services/noteService";
import { deleteTerm } from "@/services/termService";
import { loadCanvasPresence } from "@/components/canvas/presence";
import { describeDeleteImpact } from "@/components/canvas/DeleteImpact";
import { deleteAnnotation } from "@/services/annotationService";
import { produceCanvasFiles } from "@/components/canvas/exportCanvas";
import { useAppStore } from "@/app/stores/app";
import { useCanvasStore } from "@/app/stores/canvas";
import type { Annotation, BoardNode, EntityRef, Link } from "@/types/models";

const A = (id: string): EntityRef => ({ kind: "annotation", id });
const N = (id: string): EntityRef => ({ kind: "note", id });

async function seedAnnotation(id = "a1"): Promise<Annotation> {
  await db.papers.put({ id: "p1", fileHash: "h", title: "Paper", authors: [], domainIds: [], pageCount: 1, addedAt: 0 });
  const a: Annotation = {
    id,
    paperId: "p1",
    page: 1,
    rects: [[1, 2, 3, 4]],
    quote: { exact: `quote ${id}`, prefix: "", suffix: "" },
    fileHash: "h",
    color: "#fde68a",
    note: "",
    createdAt: 0,
    updatedAt: 0,
  };
  await db.annotations.put(a);
  return a;
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("画布", () => {
  it("新建、重命名（清理空白，不能为空）、关联领域", async () => {
    expect(cleanBoardName("  方法\n对比  ")).toBe("方法 对比");
    const b = await createBoard("  ", ["d1", "d1"], 100);
    expect(b).toMatchObject({ name: "未命名画布", domainIds: ["d1"], createdAt: 100, updatedAt: 100 });
    await renameBoard(b.id, " 方法对比 ");
    await expect(renameBoard(b.id, "   ")).rejects.toThrow("不能为空");
    await setBoardDomains(b.id, ["d2", "d2", "d3"]);
    const after = (await db.boards.get(b.id))!;
    expect(after).toMatchObject({ name: "方法对比", domainIds: ["d2", "d3"] });
    expect("viewport" in after).toBe(false); // 视口不写数据库
  });

  it("放入节点：同一实体在同一画布上只出现一次；实体不存在或画布不存在时报错", async () => {
    await seedAnnotation();
    const b = await createBoard("B", [], 1);
    const r1 = await addNodeToBoard(b.id, A("a1"), { x: 10, y: 20 });
    expect(r1.existed).toBe(false);
    expect(r1.node).toMatchObject({ boardId: b.id, ref: A("a1"), x: 10, y: 20, w: 260, h: 150 });
    const r2 = await addNodeToBoard(b.id, A("a1"), { x: 500, y: 500 });
    expect(r2).toEqual({ node: r1.node, existed: true });
    expect(await db.boardNodes.count()).toBe(1);
    // 另一块画布可以再放
    const b2 = await createBoard("B2");
    expect((await addNodeToBoard(b2.id, A("a1"), { x: 0, y: 0 })).existed).toBe(false);
    await expect(addNodeToBoard(b.id, A("missing"), { x: 0, y: 0 })).rejects.toThrow("已被删除");
    await expect(addNodeToBoard("nope", A("a1"), { x: 0, y: 0 })).rejects.toThrow("画布不存在");
    expect((await db.boards.get(b.id))!.updatedAt).toBeGreaterThan(1);
    expect(findNodeForRef(await db.boardNodes.toArray(), b2.id, A("a1"))!.boardId).toBe(b2.id);
  });

  it("移动、缩放（不小于最小尺寸）、移出与撤销", async () => {
    await seedAnnotation();
    const b = await createBoard("B");
    const { node } = await addNodeToBoard(b.id, A("a1"), { x: 0, y: 0 });
    await moveBoardNodes(b.id, [{ id: node.id, x: 40, y: 50 }]);
    await resizeBoardNode(b.id, node.id, { x: 30, y: 40, w: 10, h: 300 });
    expect(await db.boardNodes.get(node.id)).toMatchObject({ x: 30, y: 40, w: MIN_NODE_SIZE.w, h: 300 });

    const removed = await removeNodesFromBoard([node.id, "not-there"]);
    expect(removed.map((n) => n.id)).toEqual([node.id]);
    expect(await db.boardNodes.count()).toBe(0);
    expect(await db.annotations.get("a1")).toBeTruthy();
    await restoreBoardNodes(removed);
    expect(await db.boardNodes.get(node.id)).toMatchObject({ x: 30, y: 40 });
    // 撤销前又放了进去：不重复恢复
    await removeNodesFromBoard([node.id]);
    await addNodeToBoard(b.id, A("a1"), { x: 0, y: 0 });
    await restoreBoardNodes(removed);
    expect(await db.boardNodes.count()).toBe(1);
  });

  it("boardsContaining 按最近修改排序", async () => {
    await seedAnnotation();
    const b1 = await createBoard("1", [], 1);
    const b2 = await createBoard("2", [], 2);
    await addNodeToBoard(b2.id, A("a1"), { x: 0, y: 0 });
    await addNodeToBoard(b1.id, A("a1"), { x: 0, y: 0 });
    await db.boards.update(b1.id, { updatedAt: 20 });
    await db.boards.update(b2.id, { updatedAt: 10 });
    expect((await boardsContaining(A("a1"))).map((b) => b.name)).toEqual(["1", "2"]);
    expect(await boardsContaining(A("zzz"))).toEqual([]);
  });

  it("orphanNotesOfBoard：只在本画布上、没有连线的笔记", () => {
    const node = (id: string, boardId: string, noteId: string): BoardNode => ({ id, boardId, ref: N(noteId), x: 0, y: 0, w: 1, h: 1 });
    const links: Link[] = [{ id: "l", from: N("linked"), to: A("a"), relation: "supports", createdAt: 0 }];
    const nodes = [node("1", "b", "solo"), node("2", "b", "shared"), node("3", "other", "shared"), node("4", "b", "linked"), node("5", "other", "elsewhere")];
    expect(orphanNotesOfBoard("b", nodes, links)).toEqual(["solo"]);
  });

  it("删除画布：只删节点；孤立笔记按选择保留或删除；连线和其他画布不受影响", async () => {
    await seedAnnotation();
    const make = async () => {
      const b = await createBoard("B");
      const solo = await createNoteOnBoard(b.id, { x: 0, y: 0 }, "solo");
      const linked = await createNoteOnBoard(b.id, { x: 0, y: 0 }, "linked");
      await addNodeToBoard(b.id, A("a1"), { x: 0, y: 0 });
      await createLink({ from: N(linked.note.id), to: A("a1"), relation: "supports" });
      return { b, solo: solo.note.id, linked: linked.note.id };
    };
    const other = await createBoard("Other");
    await addNodeToBoard(other.id, A("a1"), { x: 0, y: 0 });

    const x = await make();
    expect(await planBoardDeletion(x.b.id)).toMatchObject({ nodeCount: 3, orphanNoteIds: [x.solo] });
    expect(await deleteBoard(x.b.id, { deleteOrphanNotes: false })).toEqual({ removedNodes: 3, deletedNotes: 0 });
    expect(await db.notes.get(x.solo)).toBeTruthy();
    expect(await db.boards.get(x.b.id)).toBeUndefined();

    const y = await make();
    expect(await deleteBoard(y.b.id, { deleteOrphanNotes: true })).toEqual({ removedNodes: 3, deletedNotes: 1 });
    expect(await db.notes.get(y.solo)).toBeUndefined();
    expect(await db.notes.get(y.linked)).toBeTruthy();
    expect(await db.notes.get(x.solo)).toBeTruthy(); // 已不在任何画布上的旧笔记不受影响
    expect(await db.links.count()).toBe(2);
    expect(await db.boardNodes.where("boardId").equals(other.id).count()).toBe(1);
    expect(await planBoardDeletion("nope")).toBeNull();
    expect(await deleteBoard("nope", { deleteOrphanNotes: true })).toEqual({ removedNodes: 0, deletedNotes: 0 });
  });

  it("删除批注时，它在画布上的节点和连线由批注服务级联删除", async () => {
    await seedAnnotation();
    const b = await createBoard("B");
    const { note } = await createNoteOnBoard(b.id, { x: 0, y: 0 });
    await addNodeToBoard(b.id, A("a1"), { x: 0, y: 0 });
    await createLink({ from: N(note.id), to: A("a1"), relation: "extends" });
    await deleteAnnotation("a1");
    expect(await db.boardNodes.count()).toBe(1);
    expect(await db.links.count()).toBe(0);
  });
});

describe("自由笔记", () => {
  it("新建、修改（相同内容不写）；searchEntities 能搜到自由笔记", async () => {
    const n = await createNote("Gating **matters**", 5);
    await setNoteText(n.id, "Gating **matters**");
    expect((await db.notes.get(n.id))!.updatedAt).toBe(5);
    await setNoteText(n.id, "Gating matters a lot");
    expect((await db.notes.get(n.id))!.updatedAt).toBeGreaterThan(5);
    await createNote("其他");
    const found = await searchEntities("GATING lot");
    expect(found.map((x) => x.ref)).toEqual([N(n.id)]);
    expect(found[0].title).toBe("Gating matters a lot");
    expect(await searchEntities("gating", { exclude: [N(n.id)] })).toEqual([]);
  });

  it("entityCascade：找出指向实体的连线和节点（按 kind 区分）", () => {
    const links: Link[] = [
      { id: "l1", from: N("x"), to: A("a"), relation: "supports", createdAt: 0 },
      { id: "l2", from: A("a"), to: N("x"), relation: "supports", createdAt: 0 },
      { id: "l3", from: A("x"), to: A("a"), relation: "supports", createdAt: 0 },
    ];
    const nodes: BoardNode[] = [
      { id: "n1", boardId: "b", ref: N("x"), x: 0, y: 0, w: 1, h: 1 },
      { id: "n2", boardId: "b", ref: A("x"), x: 0, y: 0, w: 1, h: 1 },
    ];
    expect(entityCascade(N("x"), links, nodes)).toEqual({ linkIds: ["l1", "l2"], nodeIds: ["n1"] });
  });

  it("删除笔记级联删除连线和所有画布上的节点；撤销恢复（另一端已删除的连线不恢复）", async () => {
    await seedAnnotation("a1");
    await seedAnnotation("a2");
    const b1 = await createBoard("1");
    const b2 = await createBoard("2");
    const { note } = await createNoteOnBoard(b1.id, { x: 0, y: 0 }, "x");
    await addNodeToBoard(b2.id, N(note.id), { x: 0, y: 0 });
    await addNodeToBoard(b1.id, A("a1"), { x: 0, y: 0 });
    await createLink({ from: N(note.id), to: A("a1"), relation: "supports" });
    await createLink({ from: A("a2"), to: N(note.id), relation: "contradicts" });
    await createLink({ from: A("a1"), to: A("a2"), relation: "compares" });

    const snap = (await deleteNote(note.id))!;
    expect(snap.links).toHaveLength(2);
    expect(snap.boardNodes).toHaveLength(2);
    expect(await db.notes.count()).toBe(0);
    expect((await db.links.toArray()).map((l) => l.relation)).toEqual(["compares"]);
    expect((await db.boardNodes.toArray()).map((n) => n.ref.kind)).toEqual(["annotation"]);
    expect(await deleteNote(note.id)).toBeNull();

    await deleteAnnotation("a2");
    await restoreNote(snap);
    expect(await db.notes.get(note.id)).toBeTruthy();
    expect((await listLinksFor(N(note.id))).map((l) => l.relation)).toEqual(["supports"]);
    expect(await db.boardNodes.count()).toBe(3);
  });
});

describe("连线", () => {
  it("addLink：完全相同的连线已存在时返回已有的一条（existed）", async () => {
    const a = await addLink({ from: A("a"), to: A("b"), relation: "supports", label: " x " });
    expect(a.existed).toBe(false);
    const b = await addLink({ from: A("a"), to: A("b"), relation: "supports", label: "x" });
    expect(b).toEqual({ link: a.link, existed: true });
    expect((await addLink({ from: A("b"), to: A("a"), relation: "supports", label: "x" })).existed).toBe(false); // 反方向不算重复
    await expect(addLink({ from: A("a"), to: A("a"), relation: "supports" })).rejects.toThrow("自身");
  });

  it("updateLink：改关系和文字，文字为空时去掉 label；调换方向；改完与另一条相同时合并", async () => {
    const l = await createLink({ from: A("a"), to: A("b"), relation: "custom", label: "启发" });
    expect(await updateLink(l.id, { relation: "extends", label: "  " })).toEqual({ id: l.id, merged: false });
    const got = (await db.links.get(l.id))!;
    expect(got.relation).toBe("extends");
    expect("label" in got).toBe(false);
    await updateLink(l.id, { relation: "bogus" as never, label: "x" });
    expect(await db.links.get(l.id)).toMatchObject({ relation: "custom", label: "x" });

    await updateLink(l.id, { relation: "supports", reverse: true });
    expect(await db.links.get(l.id)).toMatchObject({ from: A("b"), to: A("a"), relation: "supports" });
    expect(await listLinksFor(A("a"))).toHaveLength(1); // 反向后 to.id 索引也更新了

    const other = await createLink({ from: A("a"), to: A("b"), relation: "supports" });
    expect(await updateLink(l.id, { relation: "supports", reverse: true })).toEqual({ id: other.id, merged: true });
    expect((await db.links.toArray()).map((x) => x.id)).toEqual([other.id]);
    expect(await updateLink("nope", { relation: "supports" })).toBeNull();
  });

  it("deleteLinks 返回快照；restoreLinks 按原 id 写回，另一端已删除或已有相同连线时跳过", async () => {
    await seedAnnotation("a1");
    await seedAnnotation("a2");
    const note = await createNote("n");
    const l1 = await createLink({ from: A("a1"), to: A("a2"), relation: "supports" });
    const l2 = await createLink({ from: N(note.id), to: A("a1"), relation: "extends" });
    const l3 = await createLink({ from: A("a2"), to: A("a1"), relation: "compares" });
    const snap = await deleteLinks([l1.id, l2.id, l3.id, "nope"]);
    expect(snap.map((l) => l.id)).toEqual([l1.id, l2.id, l3.id]);
    expect(await db.links.count()).toBe(0);

    await deleteNote(note.id); // l2 的一端没了
    const again = await createLink({ from: A("a2"), to: A("a1"), relation: "compares" }); // 与 l3 相同
    expect(await restoreLinks(snap)).toBe(1);
    expect((await db.links.toArray()).map((l) => l.id).sort()).toEqual([l1.id, again.id].sort());
    expect(await db.links.get(l1.id)).toEqual(l1);
  });
});

describe("删除影响与级联", () => {
  it("entityDeleteImpact 统计连线数和所在画布数；describeDeleteImpact 生成说明", async () => {
    await seedAnnotation("a1");
    await db.terms.put({ id: "t1", name: "T", aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 0, updatedAt: 0 });
    const T = { kind: "term" as const, id: "t1" };
    expect(await entityDeleteImpact(T)).toEqual({ links: 0, boards: 0 });
    const b1 = await createBoard("1");
    const b2 = await createBoard("2");
    await addNodeToBoard(b1.id, T, { x: 0, y: 0 });
    await addNodeToBoard(b2.id, T, { x: 0, y: 0 });
    await createLink({ from: T, to: A("a1"), relation: "supports" });
    await createLink({ from: A("a1"), to: T, relation: "extends" });
    await createLink({ from: A("t1"), to: A("a1"), relation: "extends" }); // 同 id 不同 kind，不算
    expect(await entityDeleteImpact(T)).toEqual({ links: 2, boards: 2 });
    expect(describeDeleteImpact({ links: 2, boards: 2 })).toBe("将同时删除 2 条连线和 2 块画布上的节点（连线在所有画布和「相关笔记」中都会消失）。");
    expect(describeDeleteImpact({ links: 0, boards: 1 })).toBe("将同时删除 1 块画布上的节点。");
    expect(describeDeleteImpact({ links: 0, boards: 0 })).toBe("没有连线，也不在任何画布上。");
  });

  it("deleteTerm 级联删除它在各画布上的节点和连线，别的节点不受影响", async () => {
    await seedAnnotation("a1");
    await db.terms.put({ id: "t1", name: "T", aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 0, updatedAt: 0 });
    const T = { kind: "term" as const, id: "t1" };
    const b = await createBoard("B");
    await addNodeToBoard(b.id, T, { x: 0, y: 0 });
    await addNodeToBoard(b.id, A("a1"), { x: 300, y: 0 });
    await createLink({ from: A("a1"), to: T, relation: "partOf" });
    await deleteTerm("t1");
    expect((await db.boardNodes.toArray()).map((n) => n.ref)).toEqual([A("a1")]);
    expect(await db.links.count()).toBe(0);
    expect(await db.annotations.get("a1")).toBeTruthy();
  });

  it("addNodesToBoard 批量放入，跳过已在画布上的和不存在的", async () => {
    await seedAnnotation("a1");
    await seedAnnotation("a2");
    const b = await createBoard("B");
    await addNodeToBoard(b.id, A("a1"), { x: 0, y: 0 });
    const added = await addNodesToBoard(b.id, [
      { ref: A("a1"), x: 1, y: 1 },
      { ref: A("a2"), x: 10, y: 20 },
      { ref: A("a2"), x: 30, y: 40 },
      { ref: A("gone"), x: 0, y: 0 },
    ]);
    expect(added.map((n) => [n.ref.id, n.x, n.y])).toEqual([["a2", 10, 20]]);
    expect(await db.boardNodes.count()).toBe(2);
  });

  it("loadCanvasPresence：论文里在画布上或有连线的批注", async () => {
    await seedAnnotation("a1");
    await seedAnnotation("a2");
    await seedAnnotation("a3");
    const b = await createBoard("B");
    await addNodeToBoard(b.id, A("a1"), { x: 0, y: 0 });
    await createLink({ from: { kind: "term", id: "t" }, to: A("a2"), relation: "supports" });
    expect([...(await loadCanvasPresence("p1"))].sort()).toEqual(["a1", "a2"]);
    expect([...(await loadCanvasPresence("nope"))]).toEqual([]);
  });
});

describe("导出", () => {
  it("loadCanvasExportData 读取画布、节点、实体和连线；produceCanvasFiles 每块画布一个文件，同名去重", async () => {
    await seedAnnotation();
    const b1 = await createBoard("同名", [], 1);
    await createBoard("同名", [], 2);
    const { note } = await createNoteOnBoard(b1.id, { x: 0, y: 0 }, "n");
    await addNodeToBoard(b1.id, A("a1"), { x: 300, y: 0 });
    await createLink({ from: N(note.id), to: A("a1"), relation: "supports" });
    const data = await loadCanvasExportData([b1.id]);
    expect(data.boards.map((b) => b.id)).toEqual([b1.id]);
    expect(data.nodes).toHaveLength(2);
    expect(data.annotations.map((a) => a.id)).toEqual(["a1"]);
    expect(data.papers.map((p) => p.id)).toEqual(["p1"]);
    expect(data.notes.map((n) => n.id)).toEqual([note.id]);
    expect(data.links).toHaveLength(1);

    const files = await produceCanvasFiles();
    expect(files.map((f) => f.name).sort()).toEqual(["同名 (2).canvas", "同名.canvas"]);
    const first = JSON.parse(files.find((f) => f.name === "同名.canvas")!.content);
    expect(first.nodes).toHaveLength(2);
    expect(first.edges).toEqual([expect.objectContaining({ label: "支持" })]);
    expect(JSON.parse(files.find((f) => f.name === "同名 (2).canvas")!.content)).toEqual({ nodes: [], edges: [] });
  });
});

describe("画布界面状态", () => {
  it("focusEntity 切到画布视图、打开对应画布并带序号；clearFocus 只清除同一请求", () => {
    useAppStore.getState().setView("reader");
    const st = useCanvasStore.getState();
    st.focusEntity("b1", A("a1"), { place: true });
    const f = useCanvasStore.getState().focus!;
    expect(useAppStore.getState().view).toBe("canvas");
    expect(useCanvasStore.getState().activeBoardId).toBe("b1");
    expect(f).toMatchObject({ boardId: "b1", ref: A("a1"), place: true });
    st.clearFocus(f.seq + 1);
    expect(useCanvasStore.getState().focus).not.toBeNull();
    st.clearFocus(f.seq);
    expect(useCanvasStore.getState().focus).toBeNull();
  });
});
