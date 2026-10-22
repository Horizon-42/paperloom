// 已挂载页面的术语状态登记表 + 定位工具。
// 覆盖层挂载时登记自己的 ctx 和本页命中，弹窗用它计算锚点位置、判断导航目标页是否已渲染。
import type { PageLayerContext } from "@/components/viewer/overlays";
import type { TermMatch } from "@/engine/types";
import { pdfRectToScreen, type ScreenRect } from "@/lib/coords";
import type { PageViewport } from "@/lib/pdf";
import { textRangeToPdfRects } from "@/lib/textGeometry";
import type { PdfRect } from "@/types/models";
import type { PaneId } from "@/app/stores/reader";

export interface PageTermEntry {
  ctx: PageLayerContext;
  /** 本页全部命中（不受显示设置影响）；文字尚未就绪时为 null */
  matches: readonly TermMatch[] | null;
}

const pages = new Map<string, PageTermEntry>();
const listeners = new Set<() => void>();

export const pageKey = (paneId: PaneId, paperId: string, page: number) => `${paneId}|${paperId}|${page}`;

export function setPageEntry(key: string, entry: PageTermEntry) {
  pages.set(key, entry);
  for (const l of listeners) l();
}

export function deletePageEntry(key: string, entry: PageTermEntry) {
  if (pages.get(key) !== entry) return;
  pages.delete(key);
  for (const l of listeners) l();
}

export function getPageEntry(paneId: PaneId, paperId: string, page: number): PageTermEntry | undefined {
  return pages.get(pageKey(paneId, paperId, page));
}

export function onPagesChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---- 定位 ----

const rectCache = new WeakMap<Float32Array[], Map<string, PdfRect[]>>();

/**
 * 规范化区间 → PDF 矩形。有字形映射时按 charBoxes 缓存（缩放、重新进入渲染范围都不重算）；
 * 退回文本层 DOM 定位时不缓存。
 */
export function rangeRects(ctx: PageLayerContext, start: number, end: number): PdfRect[] {
  const boxes = ctx.text?.charBoxes;
  if (!boxes) return textRangeToPdfRects(ctx, start, end);
  let m = rectCache.get(boxes);
  if (!m) rectCache.set(boxes, (m = new Map()));
  const k = `${start}:${end}`;
  let r = m.get(k);
  if (!r) m.set(k, (r = textRangeToPdfRects(ctx, start, end)));
  return r;
}

export type UnderlineEdge = "bottom" | "top" | "left" | "right";

export interface UnderlineSeg extends ScreenRect {
  /** 下划线画在屏幕矩形的哪条边上（旋转页上 PDF 的"下边"可能在屏幕左右） */
  edge: UnderlineEdge;
}

/** PDF 矩形 → 屏幕段：下划线画在 PDF 下边（y1）对应的屏幕边上 */
export function toUnderlineSeg(viewport: PageViewport, r: PdfRect): UnderlineSeg {
  const s = pdfRectToScreen(viewport, r);
  const [bx, by] = viewport.convertToViewportPoint((r[0] + r[2]) / 2, r[1]);
  const d = {
    bottom: Math.abs(by - (s.top + s.height)),
    top: Math.abs(by - s.top),
    left: Math.abs(bx - s.left),
    right: Math.abs(bx - (s.left + s.width)),
  };
  let edge: UnderlineEdge = "bottom";
  for (const k of ["top", "left", "right"] as const) if (d[k] < d[edge]) edge = k;
  return { ...s, edge };
}

/** 页面内的屏幕矩形 → 视口（client）坐标 */
export function toClientRect(pageEl: HTMLElement, s: ScreenRect): DOMRect {
  const o = pageEl.getBoundingClientRect();
  return new DOMRect(o.left + s.left, o.top + s.top, s.width, s.height);
}

/** 把 client 矩形滚动到滚动容器的可见区域内；已完整可见时不动。目标放在视口高度约 35% 处 */
export function scrollClientRectIntoView(scrollEl: HTMLElement, r: DOMRect, margin = 48) {
  const box = scrollEl.getBoundingClientRect();
  const visibleV = r.top >= box.top + margin && r.bottom <= box.bottom - margin;
  const visibleH = r.left >= box.left + 8 && r.right <= box.right - 8;
  if (!visibleV) scrollEl.scrollTop += r.top - (box.top + box.height * 0.35);
  if (!visibleH) scrollEl.scrollLeft += r.left - (box.left + box.width * 0.3);
}
