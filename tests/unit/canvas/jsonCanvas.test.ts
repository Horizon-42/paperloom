// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canvasFileNames, markdownNames, sanitizeFileName, serializeJsonCanvas, sideToward, toJsonCanvas } from "@/components/canvas/jsonCanvas";
import { buildMarkdownFiles } from "@/services/storage/markdown";
import type { CanvasExportData } from "@/services/canvasService";

const data: CanvasExportData = {
  boards: [
    { id: "b1", name: "方法对比", domainIds: [], createdAt: 1, updatedAt: 1 },
    { id: "b2", name: "其他", domainIds: [], createdAt: 2, updatedAt: 2 },
  ],
  nodes: [
    { id: "n-a", boardId: "b1", ref: { kind: "annotation", id: "a1" }, x: 10.4, y: 20.6, w: 260, h: 150 },
    { id: "n-t", boardId: "b1", ref: { kind: "term", id: "t1" }, x: 400, y: 20, w: 220, h: 110 },
    { id: "n-p", boardId: "b1", ref: { kind: "paper", id: "p1" }, x: 400, y: 300, w: 260, h: 96 },
    { id: "n-n", boardId: "b1", ref: { kind: "note", id: "o1" }, x: 0, y: 300, w: 240, h: 130 },
    { id: "n-x", boardId: "b1", ref: { kind: "annotation", id: "gone" }, x: 0, y: 600, w: 200, h: 60 },
    { id: "n-other", boardId: "b2", ref: { kind: "term", id: "t1" }, x: 0, y: 0, w: 220, h: 110 },
  ],
  annotations: [
    {
      id: "a1",
      paperId: "p1",
      page: 3,
      rects: [],
      quote: { exact: "LSTM networks capture\nlong-range dependencies", prefix: "", suffix: "" },
      fileHash: "h",
      color: "#fde68a",
      note: "门控是关键 $x$",
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  terms: [{ id: "t1", name: "LSTM", aliases: ["Long Short-Term Memory"], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 0, updatedAt: 0 }],
  papers: [{ id: "p1", fileHash: "h", title: "Deep Learning", authors: ["A", "B"], year: 2015, domainIds: [], pageCount: 9, addedAt: 0 }],
  notes: [{ id: "o1", text: "我的**想法**", createdAt: 0, updatedAt: 0 }],
  links: [
    { id: "l1", from: { kind: "annotation", id: "a1" }, to: { kind: "term", id: "t1" }, relation: "partOf", createdAt: 1 },
    { id: "l2", from: { kind: "note", id: "o1" }, to: { kind: "annotation", id: "a1" }, relation: "custom", label: "质疑", createdAt: 2 },
    { id: "l3", from: { kind: "term", id: "t1" }, to: { kind: "paper", id: "p1" }, relation: "compares", createdAt: 3 },
    { id: "l4", from: { kind: "term", id: "t1" }, to: { kind: "annotation", id: "elsewhere" }, relation: "supports", createdAt: 4 },
  ],
};

describe("toJsonCanvas", () => {
  const c = toJsonCanvas("b1", data);

  it("每个画布节点导出为 text 节点，坐标取整，按位置排序", () => {
    expect(c.nodes.map((n) => n.id)).toEqual(["n-t", "n-a", "n-n", "n-p", "n-x"]);
    expect(c.nodes.every((n) => n.type === "text")).toBe(true);
    expect(c.nodes[1]).toMatchObject({ x: 10, y: 21, width: 260, height: 150, color: "#fde68a" });
  });

  it("文本内容：批注带原文引用和出处，术语带别名，论文带作者年份，已删除的有占位", () => {
    const text = (id: string) => c.nodes.find((n) => n.id === id)!.text!;
    expect(text("n-a")).toBe("> LSTM networks capture\n> long-range dependencies\n\n门控是关键 $x$\n\n—— 《Deep Learning》第 3 页");
    expect(text("n-t")).toBe("### LSTM\n别名：Long Short-Term Memory");
    expect(text("n-p")).toBe("### Deep Learning\nA, B · 2015");
    expect(text("n-n")).toBe("我的**想法**");
    expect(text("n-x")).toBe("（已删除的批注）");
  });

  it("边：只导出两端都在本画布的连线；label 用关系名；对比不画箭头；带连接边", () => {
    expect(c.edges).toEqual([
      { id: "l1", fromNode: "n-a", fromSide: "right", toNode: "n-t", toSide: "left", color: "#7c3aed", label: "属于" },
      { id: "l2", fromNode: "n-n", fromSide: "top", toNode: "n-a", toSide: "bottom", color: "#525252", label: "质疑" },
      { id: "l3", fromNode: "n-t", fromSide: "bottom", toNode: "n-p", toSide: "top", color: "#d97706", label: "对比", toEnd: "none" },
    ]);
  });

  it("另一块画布只含自己的节点", () => {
    const other = toJsonCanvas("b2", data);
    expect(other.nodes.map((n) => n.id)).toEqual(["n-other"]);
    expect(other.edges).toEqual([]);
  });

  it("序列化为合法 JSON", () => {
    expect(JSON.parse(serializeJsonCanvas(c))).toEqual(c);
  });

  it("sideToward 按中心连线穿出的边判断", () => {
    const a = { x: 0, y: 0, w: 200, h: 100 };
    expect(sideToward(a, { x: 300, y: 0, w: 10, h: 10 })).toBe("right");
    expect(sideToward(a, { x: -300, y: 40, w: 10, h: 10 })).toBe("left");
    expect(sideToward(a, { x: 95, y: 300, w: 10, h: 10 })).toBe("bottom");
    expect(sideToward(a, { x: 95, y: -300, w: 10, h: 10 })).toBe("top");
  });
});

describe("双链", () => {
  it("论文、术语带指向 data/markdown 的双链，文件名与存储模块的 Markdown 导出一致（含重名）", () => {
    const papers = [
      ...data.papers,
      { id: "p0", fileHash: "h0", title: "Deep Learning", authors: [], domainIds: [], pageCount: 1, addedAt: -1 }, // 更早添加，占用原名
      { id: "p2", fileHash: "h2", title: "A: B | C [x]", authors: [], domainIds: [], pageCount: 1, addedAt: 5 },
    ];
    const names = markdownNames(papers, data.terms);
    expect(names.papers.get("p0")).toBe("Deep Learning");
    expect(names.papers.get("p1")).toBe("Deep Learning (2)");
    const md = buildMarkdownFiles({ tables: { domains: [], papers, annotations: data.annotations, terms: data.terms }, occurrences: [] }).map((f) => f.name);
    for (const n of names.papers.values()) expect(md).toContain(`papers/${n}.md`);
    for (const n of names.terms.values()) expect(md).toContain(`terms/${n}.md`);

    const c = toJsonCanvas("b1", data, names);
    const text = (id: string) => c.nodes.find((n) => n.id === id)!.text!;
    expect(text("n-a")).toContain("—— 《[[papers/Deep Learning (2)|Deep Learning]]》第 3 页");
    expect(text("n-p").split("\n")[0]).toBe("### [[papers/Deep Learning (2)|Deep Learning]]");
    expect(text("n-t").split("\n")[0]).toBe("### [[terms/LSTM|LSTM]]");
    expect(text("n-n")).toBe("我的**想法**");
  });
});

describe("文件名", () => {
  it("sanitizeFileName 与存储模块规则一致：非法字符换空格、去首尾点和空白、保留名，按 UTF-8 字节截断", () => {
    expect(sanitizeFileName("方法/对比: v2?")).toBe("方法 对比 v2");
    expect(sanitizeFileName("  ..隐藏.  ")).toBe("隐藏");
    expect(sanitizeFileName("a\tb\nc")).toBe("a b c");
    // 与界面语言无关
    expect(sanitizeFileName("   ")).toBe("untitled canvas");
    expect(sanitizeFileName("..")).toBe("untitled canvas");
    expect(sanitizeFileName("untitled")).toBe("untitled");
    expect(sanitizeFileName("con")).toBe("con_");
    expect(sanitizeFileName("x".repeat(300))).toHaveLength(180);
    const zh = sanitizeFileName("画".repeat(100));
    expect(new TextEncoder().encode(zh).length).toBeLessThanOrEqual(180);
    expect(zh).toBe("画".repeat(60));
  });

  it("canvasFileNames 同名（不区分大小写）按创建先后加序号，结果稳定；加序号和扩展名后不超过 200 字节", () => {
    const boards = [
      { id: "c", name: "Notes", createdAt: 3 },
      { id: "a", name: "notes", createdAt: 1 },
      { id: "b", name: "Notes", createdAt: 2 },
      { id: "d", name: "方法:对比", createdAt: 4 },
      { id: "e", name: "方法 对比", createdAt: 5 },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `z${i}`, name: "长".repeat(200), createdAt: 10 + i })),
    ];
    const names = canvasFileNames(boards);
    expect(names.get("a")).toBe("notes.canvas");
    expect(names.get("b")).toBe("Notes (2).canvas");
    expect(names.get("c")).toBe("Notes (3).canvas");
    expect(names.get("d")).toBe("方法 对比.canvas");
    expect(names.get("e")).toBe("方法 对比 (2).canvas");
    for (const n of names.values()) expect(new TextEncoder().encode(n).length).toBeLessThanOrEqual(200);
    expect(new Set(names.values()).size).toBe(boards.length);
    expect(canvasFileNames([...boards].reverse())).toEqual(names);
  });
});
