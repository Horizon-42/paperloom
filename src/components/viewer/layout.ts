// 阅读器的纯计算：页面布局、缩放档位、滚动锚点。不依赖 DOM 和 pdf.js，便于单元测试。

/** 页面右侧页边栏宽度（角注卡片） */
export const MARGIN_WIDTH = 260;
/** 页与页之间的竖直间距 */
export const PAGE_GAP = 12;
/** 内容区上下左右留白 */
export const PAD_Y = 16;
export const PAD_X = 16;
/** 可视区域前后各预渲染几页 */
export const RENDER_BUFFER = 2;

/** 100% 缩放 = 实际尺寸：1pt = 96/72 CSS px（与 pdf.js 的 PDF_TO_CSS_UNITS 一致） */
export const CSS_UNITS = 96 / 72;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
/** 新开标签默认"自动"：适合宽度，但不超过这个缩放 */
export const AUTO_MAX_ZOOM = 1.25;
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/**
 * auto：适合宽度但不超过 AUTO_MAX_ZOOM（新开标签的默认值）
 * page-width：适合宽度
 * custom：固定缩放
 */
export type ZoomMode = "auto" | "page-width" | "custom";

/** 某页在 scale = 1 时的 viewport 尺寸（已含 userUnit 和页面旋转），单位 pt */
export interface PageDims {
  width: number;
  height: number;
}

export interface Layout {
  scale: number;
  /** 页面的 CSS 像素尺寸（向下取整，与 pdf.js 文本层的 round(down, …) 一致） */
  widths: number[];
  heights: number[];
  /** 每页（行）顶部相对内容区顶部的偏移 */
  tops: number[];
  /** 最宽一行（页面 + 页边栏）加左右留白 */
  contentWidth: number;
  contentHeight: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export const zoomToScale = (zoom: number) => zoom * CSS_UNITS;
export const scaleToZoom = (scale: number) => scale / CSS_UNITS;

export function computeLayout(dims: PageDims[], scale: number): Layout {
  const widths: number[] = [];
  const heights: number[] = [];
  const tops: number[] = [];
  let y = PAD_Y;
  let maxW = 0;
  for (const d of dims) {
    const w = Math.floor(d.width * scale);
    const h = Math.floor(d.height * scale);
    widths.push(w);
    heights.push(h);
    tops.push(y);
    y += h + PAGE_GAP;
    maxW = Math.max(maxW, w);
  }
  const contentHeight = dims.length ? y - PAGE_GAP + PAD_Y : 0;
  return { scale, widths, heights, tops, contentWidth: maxW + MARGIN_WIDTH + 2 * PAD_X, contentHeight };
}

/** 文档纵坐标 y 落在哪一页（0 起）。落在间隙里时算下一页 */
export function pageIndexAt(layout: Layout, y: number): number {
  const { tops, heights } = layout;
  const n = tops.length;
  if (!n) return 0;
  let lo = 0;
  let hi = n - 1;
  // 第一个底边在 y 之下的页
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] + heights[mid] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 当前页：视口中线所在的页；滚到底时算最后一页 */
export function currentPageIndex(layout: Layout, scrollTop: number, clientHeight: number, scrollHeight: number): number {
  const n = layout.tops.length;
  if (!n) return 0;
  if (scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2) return n - 1;
  return pageIndexAt(layout, scrollTop + clientHeight / 2);
}

/** 由可见页集合算出需要渲染的页范围 [lo, hi]（含），空集合返回 null */
export function renderRange(visible: Iterable<number>, count: number, buffer = RENDER_BUFFER): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const i of visible) {
    if (i < min) min = i;
    if (i > max) max = i;
  }
  if (min === Infinity || count <= 0) return null;
  return [Math.max(0, min - buffer), Math.min(count - 1, max + buffer)];
}

/** 下一个/上一个缩放档位 */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > zoom * 1.001) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < zoom * 0.999) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

/** 适合宽度时页面不小于这个缩放；再窄就只让页面本身适合宽度，页边栏需横向滚动查看（如分屏时） */
export const FIT_MIN_ZOOM_WITH_MARGIN = 0.75;

/**
 * 适合宽度（返回 viewport scale）：优先让最宽的页面加页边栏刚好放进容器；
 * 这样页面会小于 FIT_MIN_ZOOM_WITH_MARGIN 时，改为页面本身适合宽度（但不超过该缩放）。
 */
export function fitWidthScale(containerWidth: number, dims: PageDims[]): number {
  const maxW = dims.reduce((m, d) => Math.max(m, d.width), 0) * CSS_UNITS;
  if (!maxW) return CSS_UNITS;
  const inner = Math.max(containerWidth - 2 * PAD_X, 50);
  const withMargin = (inner - MARGIN_WIDTH) / maxW;
  const zoom =
    withMargin >= FIT_MIN_ZOOM_WITH_MARGIN ? withMargin : Math.min(inner / maxW, FIT_MIN_ZOOM_WITH_MARGIN);
  return zoomToScale(clampZoom(zoom));
}

/** 按缩放模式求实际 scale */
export function resolveScale(mode: ZoomMode, customScale: number, containerWidth: number, dims: PageDims[]): number {
  if (mode === "custom") return zoomToScale(clampZoom(scaleToZoom(customScale)));
  const fit = fitWidthScale(containerWidth, dims);
  return mode === "auto" ? Math.min(fit, zoomToScale(AUTO_MAX_ZOOM)) : fit;
}

/** 文档中的一点，用页序号 + 页内比例表示，跨缩放不变 */
export interface DocAnchor {
  index: number; // 页序号（0 起）
  fracY: number; // 页内纵向比例，可略小于 0 或大于 1（落在间隙里）
  /** 距页面左边的 CSS 像素，按页面宽度比例缩放；落在页边栏里时保持像素距离 */
  dx: number;
  inPage: boolean;
}

/** 行在内容区中水平居中：返回第 index 行左边的 x */
export function rowLeft(layout: Layout, index: number, viewportWidth: number): number {
  const effective = Math.max(viewportWidth, layout.contentWidth);
  const rowW = layout.widths[index] + MARGIN_WIDTH;
  return (effective - rowW) / 2;
}

/** 取视口内 (vx, vy) 处对应的文档锚点 */
export function anchorAt(
  layout: Layout,
  scroll: { top: number; left: number; width: number },
  vx: number,
  vy: number,
): DocAnchor {
  const y = scroll.top + vy;
  const index = pageIndexAt(layout, y);
  const h = layout.heights[index] || 1;
  const x = scroll.left + vx - rowLeft(layout, index, scroll.width);
  const w = layout.widths[index] || 1;
  const inPage = x <= w;
  return { index, fracY: (y - layout.tops[index]) / h, dx: inPage ? x / w : x - w, inPage };
}

/** 让锚点重新落在视口内 (vx, vy) 处所需的 scrollTop/scrollLeft */
export function scrollForAnchor(
  layout: Layout,
  anchor: DocAnchor,
  viewportWidth: number,
  vx: number,
  vy: number,
): { top: number; left: number } {
  const i = Math.min(anchor.index, layout.tops.length - 1);
  if (i < 0) return { top: 0, left: 0 };
  const top = layout.tops[i] + anchor.fracY * layout.heights[i] - vy;
  const w = layout.widths[i];
  const x = rowLeft(layout, i, viewportWidth) + (anchor.inPage ? anchor.dx * w : w + anchor.dx);
  return { top: Math.max(0, top), left: Math.max(0, x - vx) };
}
