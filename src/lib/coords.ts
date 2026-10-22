import type { PageViewport } from "pdfjs-dist";
import type { PdfRect } from "@/types/models";

/** 相对页面左上角的 CSS 像素矩形 */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** PDF 坐标矩形 → 当前 viewport 下相对页面左上角的屏幕矩形 */
export function pdfRectToScreen(viewport: PageViewport, rect: PdfRect): ScreenRect {
  const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** 浏览器 client 矩形（如 Range.getClientRects() 的结果）→ PDF 坐标矩形 */
export function clientRectToPdf(viewport: PageViewport, pageEl: HTMLElement, r: DOMRectReadOnly): PdfRect {
  const origin = pageEl.getBoundingClientRect();
  const [ax, ay] = viewport.convertToPdfPoint(r.left - origin.left, r.top - origin.top);
  const [bx, by] = viewport.convertToPdfPoint(r.right - origin.left, r.bottom - origin.top);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

/** client 矩形 → 相对页面左上角的屏幕矩形（覆盖层直接绘制用） */
export function clientRectToScreen(pageEl: HTMLElement, r: DOMRectReadOnly): ScreenRect {
  const origin = pageEl.getBoundingClientRect();
  return { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
}
