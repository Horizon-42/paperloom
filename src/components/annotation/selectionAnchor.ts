// 选区 → 锚点：找到选区起点所在页的 ctx，换算规范化区间（鼠标拖选时用按下/抬起的指针位置校正端点）、PDF 矩形和原文引用。
import type { PageLayerContext } from "@/components/viewer/overlays";
import { makeQuote } from "@/engine/anchor";
import {
  domRangeToTextRange,
  refineRangeByPointer,
  textRangeFromPointer,
  textRangeToPdfRects,
  type TextRange,
} from "@/lib/textGeometry";
import type { SelectionAnchor } from "@/types/models";
import { ctxForNode, pageKey, pagesOf } from "./pageRegistry";

export interface PendingSelection {
  key: string;
  paneId: PageLayerContext["paneId"];
  anchor: SelectionAnchor;
}

export interface ClientPoint {
  clientX: number;
  clientY: number;
}

/** 记录下来的一次鼠标按下或抬起 */
export interface PointerSample extends ClientPoint {
  button: number;
  /** MouseEvent.detail：连击次数（2 = 双击选词，3 = 三击选行） */
  detail: number;
  shiftKey: boolean;
  pointerType: string;
}

export interface DragGesture {
  down: ClientPoint;
  up: ClientPoint;
}

/** 按下到抬起至少移动这么多像素才算拖选 */
export const DRAG_MIN_PX = 3;

/**
 * 判断一次按下/抬起是否是鼠标拖选：只有这种情况用指针位置校正端点。
 * 双击/三击选词选行、Shift 扩展选区、触摸/触控笔、几乎没移动的点击都返回 null。
 */
export function dragGesture(down: PointerSample | null, up: PointerSample | null): DragGesture | null {
  if (!down || !up) return null;
  if (down.pointerType !== "mouse" || down.button !== 0 || down.detail !== 1) return null;
  if (down.shiftKey || up.shiftKey) return null;
  if (Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) < DRAG_MIN_PX) return null;
  return { down: { clientX: down.clientX, clientY: down.clientY }, up: { clientX: up.clientX, clientY: up.clientY } };
}

/** 当前选区 → 起点所在页的锚点；不在文本层上或为空时返回 null */
export function anchorFromSelection(sel: Selection | null, gesture: DragGesture | null = null): PendingSelection | null {
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    // Chromium 从个别像素开始拖选时会得到空选区：拖选手势成立时直接按字形命中取区间
    return gesture ? anchorFromPointer(gesture) : null;
  }
  const range = sel.getRangeAt(0);
  let ctx = ctxForNode(range.startContainer);
  if (!ctx) {
    // 起点不在页面上（如从页间空白开始拖）：取选区覆盖的第一页
    const start = range.startContainer;
    const el = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
    const viewer = el?.closest<HTMLElement>("[data-viewer-pane][data-viewer-paper]");
    if (!viewer) return null;
    ctx = pagesOf(viewer.dataset.viewerPane!, viewer.dataset.viewerPaper!).find(
      (c) => c.text && range.intersectsNode(c.text.layerEl),
    );
  }
  if (!ctx?.text) return null;
  let tr = domRangeToTextRange(ctx, range);
  if (!tr) return null;
  if (gesture) {
    // 浏览器按文本层（替代字体）判定端点，紧贴字母拖选时偶尔差一个字母；用字形命中校正
    const refined = refineRangeByPointer(ctx, tr, gesture.down, gesture.up);
    if (refined.end > refined.start) tr = refined;
  }
  return toPending(ctx, tr);
}

function anchorFromPointer(g: DragGesture): PendingSelection | null {
  const el = document.elementFromPoint(g.down.clientX, g.down.clientY);
  const ctx = el ? ctxForNode(el) : undefined;
  if (!ctx?.text) return null;
  const tr = textRangeFromPointer(ctx, g.down, g.up);
  return tr ? toPending(ctx, tr) : null;
}

function toPending(ctx: PageLayerContext, tr: TextRange): PendingSelection | null {
  if (!ctx.text) return null;
  const rects = textRangeToPdfRects(ctx, tr.start, tr.end);
  if (!rects.length) return null;
  return {
    key: pageKey(ctx.paneId, ctx.paperId, ctx.pageNumber),
    paneId: ctx.paneId,
    anchor: {
      paperId: ctx.paperId,
      page: ctx.pageNumber,
      rects,
      quote: makeQuote(ctx.text.normalized.text, tr.start, tr.end),
      fileHash: ctx.fileHash,
    },
  };
}
