// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PARALLEL_GAP,
  borderPoint,
  buildInbox,
  decodeRef,
  edgeGeometry,
  encodeRef,
  externalLinks,
  gridLayout,
  linksToEdges,
  placedRefKeys,
  plainExcerpt,
  relationText,
  resolveDomainFilter,
} from "@/components/canvas/model";
import type { Annotation, BoardNode, Domain, EntityRef, Link, Note } from "@/types/models";

const ann = (id: string, over: Partial<Annotation> = {}): Annotation => ({
  id,
  paperId: "p1",
  page: 1,
  rects: [],
  quote: { exact: `quote ${id}`, prefix: "", suffix: "" },
  fileHash: "h",
  color: "#fde68a",
  note: "",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});
const note = (id: string, updatedAt = 0): Note => ({ id, text: `note ${id}`, createdAt: 0, updatedAt });
const bn = (id: string, ref: EntityRef, boardId = "b1"): BoardNode => ({ id, boardId, ref, x: 0, y: 0, w: 100, h: 50 });
const link = (id: string, from: EntityRef, to: EntityRef, createdAt = 0, over: Partial<Link> = {}): Link => ({
  id,
  from,
  to,
  relation: "supports",
  createdAt,
  ...over,
});
const A = (id: string): EntityRef => ({ kind: "annotation", id });
const N = (id: string): EntityRef => ({ kind: "note", id });

describe("拖入数据", () => {
  it("encodeRef / decodeRef 往返，非法内容返回 null", () => {
    expect(decodeRef(encodeRef({ kind: "term", id: "t1" }))).toEqual({ kind: "term", id: "t1" });
    expect(decodeRef("")).toBeNull();
    expect(decodeRef("not json")).toBeNull();
    expect(decodeRef(JSON.stringify({ kind: "board", id: "x" }))).toBeNull();
    expect(decodeRef(JSON.stringify({ kind: "note", id: "" }))).toBeNull();
    expect(decodeRef(JSON.stringify({ kind: "note", id: 3 }))).toBeNull();
  });
});

describe("收件箱", () => {
  const papers = new Map([
    ["p1", { title: "Paper 1", domainIds: ["d1"] }],
    ["p2", { title: "Paper 2", domainIds: ["d2"] }],
  ]);
  const annotations = [
    ann("a1", { updatedAt: 3 }),
    ann("a2", { paperId: "p2", color: "#BBF7D0", updatedAt: 5 }),
    ann("a3", { updatedAt: 1 }),
    ann("gone", { paperId: "deleted-paper", updatedAt: 9 }),
  ];
  const notes = [note("n1", 4), note("n2", 2)];
  const placed = placedRefKeys([bn("x", A("a3")), bn("y", N("n2"))]);

  const ids = (r: { items: { ref: EntityRef }[] }) => r.items.map((i) => i.ref.id);

  it("不在任何画布上的批注和自由笔记，最近修改的在前；论文已删除的批注丢弃", () => {
    const r = buildInbox({ annotations, notes, placed, papers });
    expect(ids(r)).toEqual(["a2", "n1", "a1"]);
    expect(r.hiddenNotes).toBe(0);
    const first = r.items[0];
    expect("annotation" in first && first.paperTitle).toBe("Paper 2");
  });

  it("按论文、领域、颜色（不区分大小写）筛选批注；论文/颜色筛选隐藏自由笔记并计数，领域筛选不影响笔记", () => {
    const run = (q: Parameters<typeof buildInbox>[1]) => buildInbox({ annotations, notes, placed, papers }, q);
    expect(run({ paperId: "p1" })).toEqual({ items: [expect.objectContaining({ ref: A("a1") })], hiddenNotes: 1 });
    expect(ids(run({ domainIds: new Set(["d2"]) }))).toEqual(["a2", "n1"]);
    expect(ids(run({ color: "#bbf7d0" }))).toEqual(["a2"]);
    expect(run({ color: "#bbf7d0", paperId: "p1" })).toEqual({ items: [], hiddenNotes: 1 });
  });

  it("“不在本画布上”：只排除本画布上的实体，其他画布上的照样列出", () => {
    const onThisBoard = placedRefKeys([bn("y", N("n2"))]);
    expect(ids(buildInbox({ annotations, notes, placed: onThisBoard, papers }))).toEqual(["a2", "n1", "a1", "a3"]);
  });

  it("领域筛选展开子孙；'board' 用画布关联的领域，未关联时不限", () => {
    const domains: Domain[] = [
      { id: "d1", name: "A", parentId: null, color: "", order: 0 },
      { id: "d1a", name: "A1", parentId: "d1", color: "", order: 0 },
      { id: "d2", name: "B", parentId: null, color: "", order: 1 },
    ];
    expect(resolveDomainFilter("d1", [], domains)).toEqual(new Set(["d1", "d1a"]));
    expect(resolveDomainFilter("board", ["d2"], domains)).toEqual(new Set(["d2"]));
    expect(resolveDomainFilter("board", [], domains)).toBeNull();
    expect(resolveDomainFilter(null, ["d2"], domains)).toBeNull();
  });
});

describe("连线 → 边", () => {
  const nodes = [bn("n-a", A("a")), bn("n-b", A("b")), bn("n-c", N("c"))];

  it("只保留两端都在画布上的连线，按 kind 区分同 id 的实体，跳过自环和重复", () => {
    const links = [
      link("l1", A("a"), A("b"), 1),
      link("l2", A("a"), A("zzz"), 2), // 另一端不在画布上
      link("l3", { kind: "term", id: "a" }, A("b"), 3), // 同 id 不同 kind
      link("l4", N("c"), A("a"), 4),
      link("l1", A("a"), A("b"), 1), // 重复
      link("l5", A("a"), A("a"), 5),
    ];
    const edges = linksToEdges(links, nodes);
    expect(edges.map((e) => [e.id, e.source, e.target])).toEqual([
      ["l1", "n-a", "n-b"],
      ["l4", "n-c", "n-a"],
    ]);
    expect(edges.every((e) => e.offset === 0)).toBe(true);
  });

  it("同一对节点之间的多条连线（含反向）错开，且物理上不重叠", () => {
    const edges = linksToEdges(
      [link("l1", A("a"), A("b"), 1), link("l2", A("b"), A("a"), 2, { relation: "contradicts" }), link("l3", A("a"), A("b"), 3, { relation: "extends" })],
      nodes,
    );
    expect(edges.map((e) => e.offset)).toEqual([-PARALLEL_GAP, -0, PARALLEL_GAP]);
    // 以"小 id → 大 id"方向统一后的偏移互不相同
    const canonical = edges.map((e) => (e.source < e.target ? e.offset : -e.offset));
    expect(new Set(canonical).size).toBe(3);
  });
});

describe("另一端不在画布上的连线", () => {
  it("按画布节点分组，记下另一端；两端都在或都不在的不算", () => {
    const nodes = [bn("n-a", A("a")), bn("n-b", A("b"))];
    const m = externalLinks(
      [link("l1", A("a"), A("b"), 1), link("l2", A("a"), N("x"), 2), link("l3", { kind: "term", id: "t" }, A("a"), 3), link("l4", A("p"), A("q"), 4), link("l2", A("a"), N("x"), 2)],
      nodes,
    );
    expect([...m.keys()]).toEqual(["n-a"]);
    expect(m.get("n-a")!.map((x) => [x.link.id, x.other])).toEqual([
      ["l2", N("x")],
      ["l3", { kind: "term", id: "t" }],
    ]);
  });

  it("gridLayout 按列排布", () => {
    expect(gridLayout({ x: 10, y: 20 }, 5, { w: 100, h: 50 }, 2, 10)).toEqual([
      { x: 10, y: 20 },
      { x: 120, y: 20 },
      { x: 10, y: 80 },
      { x: 120, y: 80 },
      { x: 10, y: 140 },
    ]);
  });
});

describe("关系文字", () => {
  it("关系名；自定义用文字；非自定义带备注时附在后面", () => {
    expect(relationText({ relation: "supports" })).toBe("支持");
    expect(relationText({ relation: "partOf", label: " 章节 " })).toBe("属于 · 章节");
    expect(relationText({ relation: "custom", label: "启发" })).toBe("启发");
    expect(relationText({ relation: "custom" })).toBe("自定义");
  });
});

describe("浮动边几何", () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };
  it("borderPoint：中心朝目标方向与边框的交点", () => {
    expect(borderPoint(box, 500, 25)).toEqual([100, 25]);
    expect(borderPoint(box, 50, -500)).toEqual([50, 0]);
    expect(borderPoint(box, 50, 25)).toEqual([50, 25]);
    expect(borderPoint(box, 150, 75)).toEqual([100, 50]); // 正好朝角
    expect(borderPoint(box, 150, 125)).toEqual([75, 50]); // 更陡：先碰到下边
  });

  it("edgeGeometry：无偏移为直线，标签在中点；有偏移为二次曲线，标签偏出 offset", () => {
    const g = edgeGeometry(box, { x: 300, y: 0, w: 100, h: 50 });
    expect(g.path).toBe("M 100,25 L 300,25");
    expect([g.labelX, g.labelY]).toEqual([200, 25]);
    const c = edgeGeometry(box, { x: 300, y: 0, w: 100, h: 50 }, 30);
    expect(c.path.startsWith("M ")).toBe(true);
    expect(c.path).toContain(" Q ");
    expect(c.labelX).toBeCloseTo(200);
    // 向右的边，左侧法线朝上；端点也随控制点移动，所以曲线中点偏出不少于 offset
    expect(c.labelY).toBeLessThan(25 - 30);
    const d = edgeGeometry(box, { x: 300, y: 0, w: 100, h: 50 }, -30);
    expect(d.labelY).toBeGreaterThan(25 + 30);
  });
});

describe("纯文本摘要", () => {
  it("去掉 Markdown 标记并截断", () => {
    expect(plainExcerpt("## 标题\n**粗体** 和 [链接](http://x) `代码`", 100)).toBe("标题 粗体 和 链接 代码");
    expect(plainExcerpt("a".repeat(20), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
