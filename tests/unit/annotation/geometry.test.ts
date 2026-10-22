import { describe, expect, it } from "vitest";
import { estimateCardHeight, hitTest, stackCards, type StackItem } from "@/components/annotation/geometry";

describe("hitTest", () => {
  const cands = [
    { id: "wide", rects: [[100, 100, 400, 112]] as [number, number, number, number][], createdAt: 1 },
    { id: "word", rects: [[150, 100, 190, 112]] as [number, number, number, number][], createdAt: 2 },
    { id: "two-lines", rects: [[100, 80, 300, 92], [72, 66, 200, 78]] as [number, number, number, number][], createdAt: 3 },
  ];

  it("returns the annotation whose rect contains the point", () => {
    expect(hitTest(cands, 120, 105)).toBe("wide");
    expect(hitTest(cands, 80, 70)).toBe("two-lines"); // 第二行
    expect(hitTest(cands, 50, 50)).toBeNull();
  });

  it("prefers the smallest rect when highlights overlap", () => {
    expect(hitTest(cands, 160, 105)).toBe("word");
  });

  it("accepts points within the tolerance", () => {
    expect(hitTest(cands, 99, 105)).toBeNull();
    expect(hitTest(cands, 99, 105, 1.5)).toBe("wide");
  });

  it("handles unnormalized rects and breaks ties by recency", () => {
    const c = [
      { id: "old", rects: [[10, 20, 0, 0]] as [number, number, number, number][], createdAt: 1 },
      { id: "new", rects: [[0, 0, 10, 20]] as [number, number, number, number][], createdAt: 5 },
    ];
    expect(hitTest(c, 5, 5)).toBe("new");
  });
});

const item = (id: string, target: number, height = 40, order = 0): StackItem => ({ id, target, height, order });
const ys = (r: { id: string; y: number }[]) => Object.fromEntries(r.map((p) => [p.id, p.y]));

describe("stackCards", () => {
  it("keeps cards at their targets when they do not overlap", () => {
    expect(ys(stackCards([item("a", 0), item("b", 100), item("c", 300)], { gap: 6 }))).toEqual({ a: 0, b: 100, c: 300 });
  });

  it("pushes overlapping cards down in order", () => {
    const r = stackCards([item("c", 20), item("a", 0), item("b", 10)], { gap: 6 });
    expect(r.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(ys(r)).toEqual({ a: 0, b: 46, c: 92 });
  });

  it("cascades the push across the whole document", () => {
    // 前一页底部的卡片很高，把下一页顶部的卡片也推下去
    const r = ys(stackCards([item("p1", 1000, 300), item("p2", 1100, 40), item("p2b", 1500, 40)], { gap: 6 }));
    expect(r).toEqual({ p1: 1000, p2: 1306, p2b: 1500 });
  });

  it("orders cards with the same target by `order`", () => {
    const r = stackCards([item("right", 50, 40, 300), item("left", 50, 40, 100)], { gap: 4 });
    expect(r.map((p) => p.id)).toEqual(["left", "right"]);
    expect(ys(r)).toEqual({ left: 50, right: 94 });
  });

  it("respects minY", () => {
    expect(ys(stackCards([item("a", -10), item("b", 0)], { gap: 6, minY: 4 }))).toEqual({ a: 4, b: 50 });
  });

  it("aligns the anchor card with its target and moves earlier cards up", () => {
    const items = [item("a", 100), item("b", 110), item("c", 120), item("d", 400)];
    const r = ys(stackCards(items, { gap: 6, anchorId: "c" }));
    expect(r.c).toBe(120);
    expect(r.b).toBe(120 - 6 - 40);
    expect(r.a).toBe(r.b - 6 - 40);
    expect(r.d).toBe(400);
  });

  it("pushes the anchor down only when there is no room above", () => {
    const items = [item("a", 0), item("b", 5), item("c", 10)];
    const r = ys(stackCards(items, { gap: 6, anchorId: "c", minY: 0 }));
    expect(r).toEqual({ a: 0, b: 46, c: 92 });
  });

  it("does not move anything when the anchor already sits at its target", () => {
    const items = [item("a", 0), item("b", 200)];
    expect(ys(stackCards(items, { gap: 6, anchorId: "a" }))).toEqual({ a: 0, b: 200 });
  });

  it("lays out 300 cards quickly", () => {
    const many = Array.from({ length: 300 }, (_, i) => item(`n${i}`, (i * 37) % 5000, 30 + (i % 5) * 10, i));
    const t0 = performance.now();
    for (let k = 0; k < 50; k++) stackCards(many, { gap: 6, anchorId: "n150" });
    expect((performance.now() - t0) / 50).toBeLessThan(5);
    const r = stackCards(many, { gap: 6 });
    const byId = new Map(many.map((m) => [m.id, m]));
    for (let i = 1; i < r.length; i++) {
      expect(r[i].y).toBeGreaterThanOrEqual(r[i - 1].y + byId.get(r[i - 1].id)!.height + 6 - 1e-9);
      expect(r[i].y).toBeGreaterThanOrEqual(byId.get(r[i].id)!.target);
    }
  });
});

describe("estimateCardHeight", () => {
  it("grows with the note length and is bounded", () => {
    const empty = estimateCardHeight("", false);
    const short = estimateCardHeight("short note", false);
    const long = estimateCardHeight("word ".repeat(200), false);
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThan(400);
    expect(empty).toBeGreaterThan(0);
  });
});
