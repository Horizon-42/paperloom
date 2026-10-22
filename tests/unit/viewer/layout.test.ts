import { describe, expect, it } from "vitest";
import {
  AUTO_MAX_ZOOM,
  CSS_UNITS,
  MARGIN_WIDTH,
  PAD_X,
  PAD_Y,
  PAGE_GAP,
  anchorAt,
  computeLayout,
  currentPageIndex,
  fitWidthScale,
  pageIndexAt,
  renderRange,
  resolveScale,
  scrollForAnchor,
  stepZoom,
  zoomToScale,
} from "@/components/viewer/layout";

const letter = { width: 612, height: 792 };
const dims = Array.from({ length: 10 }, () => letter);

describe("computeLayout", () => {
  it("按页累加高度和间距，尺寸向下取整", () => {
    const L = computeLayout(dims, CSS_UNITS);
    expect(L.widths[0]).toBe(816);
    expect(L.heights[0]).toBe(1056);
    expect(L.tops[0]).toBe(PAD_Y);
    expect(L.tops[1]).toBe(PAD_Y + 1056 + PAGE_GAP);
    expect(L.contentHeight).toBe(PAD_Y * 2 + 10 * 1056 + 9 * PAGE_GAP);
    expect(L.contentWidth).toBe(816 + MARGIN_WIDTH + 2 * PAD_X);
  });

  it("混合页面尺寸取最宽一行", () => {
    const L = computeLayout([letter, { width: 792, height: 612 }], 1);
    expect(L.contentWidth).toBe(792 + MARGIN_WIDTH + 2 * PAD_X);
  });
});

describe("pageIndexAt / currentPageIndex", () => {
  const L = computeLayout(dims, 1);
  it("落在页内和间隙", () => {
    expect(pageIndexAt(L, 0)).toBe(0);
    expect(pageIndexAt(L, L.tops[3] + 10)).toBe(3);
    // 第 3 页底部之后的间隙算第 4 页
    expect(pageIndexAt(L, L.tops[3] + L.heights[3] + 1)).toBe(4);
    expect(pageIndexAt(L, 1e9)).toBe(9);
  });
  it("视口中线所在页；滚到底算最后一页", () => {
    expect(currentPageIndex(L, L.tops[2], 600, L.contentHeight)).toBe(2);
    expect(currentPageIndex(L, L.contentHeight - 600, 600, L.contentHeight)).toBe(9);
  });
});

describe("renderRange", () => {
  it("可见页前后各 2 页并截断到边界", () => {
    expect(renderRange([0], 10)).toEqual([0, 2]);
    expect(renderRange([4, 5], 10)).toEqual([2, 7]);
    expect(renderRange([9], 10)).toEqual([7, 9]);
    expect(renderRange([], 10)).toBeNull();
  });
});

describe("缩放", () => {
  it("档位步进", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(1.05, -1)).toBe(1);
    expect(stepZoom(5, 1)).toBe(5);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });
  it("适合宽度让页面加页边栏放进容器", () => {
    const s = fitWidthScale(1200, dims);
    expect(612 * s + MARGIN_WIDTH + 2 * PAD_X).toBeCloseTo(1200, 5);
  });
  it("容器太窄时只让页面适合宽度", () => {
    // 分屏时约 580px：带页边栏只有 35%，改为页面本身适合宽度
    const s = fitWidthScale(580, dims);
    expect(612 * s + 2 * PAD_X).toBeCloseTo(580, 5);
    // 介于两者之间时停在 75%
    const mid = fitWidthScale(612 * CSS_UNITS * 0.75 + MARGIN_WIDTH + 2 * PAD_X - 40, dims);
    expect(mid / CSS_UNITS).toBeCloseTo(0.75, 5);
  });
  it("auto 模式不超过 AUTO_MAX_ZOOM", () => {
    expect(resolveScale("auto", 0, 5000, dims)).toBeCloseTo(zoomToScale(AUTO_MAX_ZOOM));
    expect(resolveScale("page-width", 0, 5000, dims)).toBeGreaterThan(zoomToScale(AUTO_MAX_ZOOM));
    expect(resolveScale("custom", zoomToScale(2), 5000, dims)).toBeCloseTo(zoomToScale(2));
  });
});

describe("缩放锚点", () => {
  it("缩放前后视口中心对应同一文档位置", () => {
    const a = computeLayout(dims, 1);
    const b = computeLayout(dims, 2);
    const viewport = { width: 900, height: 700 };
    const scroll = { top: a.tops[4] + 300, left: 0, width: viewport.width };
    const anchor = anchorAt(a, scroll, viewport.width / 2, viewport.height / 2);
    const next = scrollForAnchor(b, anchor, viewport.width, viewport.width / 2, viewport.height / 2);
    const back = anchorAt(b, { top: next.top, left: next.left, width: viewport.width }, viewport.width / 2, viewport.height / 2);
    expect(back.index).toBe(anchor.index);
    expect(back.fracY).toBeCloseTo(anchor.fracY, 3);
    expect(back.dx).toBeCloseTo(anchor.dx, 3);
  });
});
