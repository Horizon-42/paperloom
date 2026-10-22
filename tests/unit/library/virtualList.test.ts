import { describe, expect, it } from "vitest";
import { buildRowLayout } from "@/components/library/VirtualList";
import { fitTags } from "@/components/library/TagChips";
import { PAPER_ROW_HEIGHT, paperRowHeight } from "@/components/library/PaperRow";

describe("row layout", () => {
  it("fixed heights", () => {
    const L = buildRowLayout([1, 2, 3], 10);
    expect(L.total).toBe(30);
    expect([L.top(2), L.height(1)]).toEqual([20, 10]);
    expect([L.indexAt(-5), L.indexAt(0), L.indexAt(9.9), L.indexAt(10), L.indexAt(29), L.indexAt(500)]).toEqual([0, 0, 0, 1, 2, 2]);
    expect(buildRowLayout([], 10).indexAt(5)).toBe(0);
  });

  it("per-item heights: prefix sums and binary search", () => {
    const items = [10, 30, 10, 50, 20];
    const L = buildRowLayout(items, (h) => h);
    expect(L.total).toBe(120);
    expect(items.map((_, i) => L.top(i))).toEqual([0, 10, 40, 50, 100]);
    expect(items.map((_, i) => L.height(i))).toEqual(items);
    expect([0, 9, 10, 39, 40, 49, 50, 99, 100, 119, 1000, -1].map((y) => L.indexAt(y))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 0]);
    // 与逐行累加的结果一致
    const many = Array.from({ length: 1000 }, (_, i) => (i % 3 ? 72 : 92));
    const M = buildRowLayout(many, (h) => h);
    let y = 0;
    for (let i = 0; i < many.length; i += 37) {
      y = many.slice(0, i).reduce((a, b) => a + b, 0);
      expect(M.top(i)).toBe(y);
      expect(M.indexAt(y + 1)).toBe(i);
    }
  });

  it("paper rows with tags are taller", () => {
    expect(paperRowHeight({})).toBe(PAPER_ROW_HEIGHT);
    expect(paperRowHeight({ tags: [] })).toBe(PAPER_ROW_HEIGHT);
    expect(paperRowHeight({ tags: ["a"] })).toBeGreaterThan(PAPER_ROW_HEIGHT);
  });
});

describe("tag line fitting", () => {
  const badge = () => 20; // "+N" 角标宽度
  it("shows everything that fits, otherwise collapses the rest into +N", () => {
    expect(fitTags([30, 30], 64, badge)).toEqual({ shown: 2 }); // 30 + 4 + 30
    expect(fitTags([30, 30, 30], 90, badge)).toEqual({ shown: 2 }); // 30 + 4 + 30 + 4 + 角标 20 = 88
    expect(fitTags([30, 30, 30], 70, badge)).toEqual({ shown: 1 });
  });
  it("truncates the first tag when even one doesn't fit", () => {
    expect(fitTags([100], 50, badge)).toEqual({ shown: 1, firstMax: 50 });
    expect(fitTags([100, 30], 60, badge)).toEqual({ shown: 1, firstMax: 36 });
  });
  it("shows all before the width is known", () => {
    expect(fitTags([30, 30, 30], 0, badge)).toEqual({ shown: 3 });
    expect(fitTags([], 100, badge)).toEqual({ shown: 0 });
  });
});
