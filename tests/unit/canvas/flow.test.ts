// @vitest-environment node
import { describe, expect, it } from "vitest";
import { reconcileEdges, reconcileNodes, type EntityView } from "@/components/canvas/flow";
import { linksToEdges } from "@/components/canvas/model";
import type { BoardNode, Link, Note } from "@/types/models";

const note = (id: string, text: string): Note => ({ id, text, createdAt: 0, updatedAt: 0 });
const bn = (id: string, noteId: string, x = 0, y = 0): BoardNode => ({ id, boardId: "b", ref: { kind: "note", id: noteId }, x, y, w: 200, h: 100 });
const views = (...ns: Note[]) => new Map<string, EntityView>(ns.map((n) => [`note:${n.id}`, { kind: "note", note: n }]));

describe("reconcileNodes", () => {
  it("新节点：位置、大小、预先声明的四个手柄；实体缺失时为占位类型", () => {
    const [a, b] = reconcileNodes([], [bn("1", "n1", 10, 20), bn("2", "gone")], views(note("n1", "x")));
    expect(a).toMatchObject({ id: "1", type: "note", position: { x: 10, y: 20 }, width: 200, height: 100, measured: { width: 200, height: 100 }, selected: false });
    expect(a.handles!.map((h) => h.id)).toEqual(["t", "r", "b", "l"]);
    expect(b.type).toBe("missing");
    expect(b.data.view).toBeNull();
  });

  it("未变化的节点复用同一对象；内容变化只换 data，位置变化只换位置", () => {
    const v1 = views(note("n1", "x"), note("n2", "y"));
    const first = reconcileNodes([], [bn("1", "n1"), bn("2", "n2")], v1);
    const same = reconcileNodes(first, [bn("1", "n1"), bn("2", "n2")], views(note("n1", "x"), note("n2", "y")));
    expect(same[0]).toBe(first[0]);
    expect(same[1]).toBe(first[1]);

    const changed = reconcileNodes(first, [bn("1", "n1", 5, 5), bn("2", "n2")], views(note("n1", "x"), note("n2", "改了")));
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0].data).toBe(first[0].data);
    expect(changed[0].position).toEqual({ x: 5, y: 5 });
    expect(changed[1].data).not.toBe(first[1].data);
    expect(changed[1].data.sig).toContain("改了");
  });

  it("选中状态沿用；拖动中的节点保留本地位置；pending 几何优先于数据库", () => {
    const v = views(note("n1", "x"), note("n2", "y"));
    const first = reconcileNodes([], [bn("1", "n1"), bn("2", "n2")], v);
    const local = [{ ...first[0], selected: true, dragging: true, position: { x: 300, y: 300 } }, first[1]];
    const next = reconcileNodes(local, [bn("1", "n1"), bn("2", "n2")], v, new Map([["2", { x: 50, y: 60 }]]));
    expect(next[0].selected).toBe(true);
    expect(next[0].position).toEqual({ x: 300, y: 300 });
    expect(next[1].position).toEqual({ x: 50, y: 60 });
  });

  it("数据库里删掉的节点从列表中消失", () => {
    const v = views(note("n1", "x"), note("n2", "y"));
    const first = reconcileNodes([], [bn("1", "n1"), bn("2", "n2")], v);
    expect(reconcileNodes(first, [bn("2", "n2")], v).map((n) => n.id)).toEqual(["2"]);
  });
});

describe("reconcileEdges", () => {
  const nodes = [bn("1", "n1"), bn("2", "n2")];
  const l = (over: Partial<Link> = {}): Link => ({ id: "l1", from: { kind: "note", id: "n1" }, to: { kind: "note", id: "n2" }, relation: "supports", createdAt: 0, ...over });

  it("关系类型决定箭头；未变化的边复用对象，修改关系后换新对象并保留选中", () => {
    const [e] = reconcileEdges([], linksToEdges([l()], nodes));
    expect(e).toMatchObject({ id: "l1", type: "relation", source: "1", target: "2", sourceHandle: null, targetHandle: null });
    expect(e.markerEnd).toMatchObject({ color: "#16a34a" });
    const [same] = reconcileEdges([e], linksToEdges([l()], nodes));
    expect(same).toBe(e);
    const [changed] = reconcileEdges([{ ...e, selected: true }], linksToEdges([l({ relation: "compares" })], nodes));
    expect(changed.data!.link.relation).toBe("compares");
    expect(changed.markerEnd).toBeUndefined();
    expect(changed.selected).toBe(true);
  });
});
