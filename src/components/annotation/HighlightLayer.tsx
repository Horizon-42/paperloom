// 高亮层（under-text 页面覆盖层）：画本页批注的矩形，处理点击命中；
// 重新锚定后矩形为空的批注在这里用本页的字形映射补算矩形并写回。
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAnnotationStore } from "@/app/stores/annotation";
import type { PageLayerContext } from "@/components/viewer/overlays";
import { listAnnotationsByPage } from "@/db/repo/annotations";
import { findQuote } from "@/engine/anchor";
import { pdfRectToScreen } from "@/lib/coords";
import { textRangeToPdfRects } from "@/lib/textGeometry";
import { fillAnnotationRects, markAnnotationOrphaned } from "@/services/annotationService";
import type { Annotation } from "@/types/models";
import { strongColor } from "./colors";
import { hitTest } from "./geometry";
import "./annotation.css";

/** 字形映射迟迟不到（如该页映射失败）时，最多等这么久再用文本层兜底补算矩形 */
const GLYPH_WAIT_MS = 1500;

/** 能在当前文件上画出来的批注 */
export function isDrawable(a: Annotation, fileHash: string): boolean {
  return a.anchorStatus !== "orphaned" && a.fileHash === fileHash;
}

export function HighlightLayer({ ctx }: { ctx: PageLayerContext }) {
  const { paneId, paperId, pageNumber, fileHash, viewport } = ctx;
  const anns = useLiveQuery(() => listAnnotationsByPage(paperId, pageNumber), [paperId, pageNumber]);
  const visible = useMemo(() => (anns ?? []).filter((a) => isDrawable(a, fileHash)), [anns, fileHash]);

  const selectedId = useAnnotationStore((s) =>
    s.selected && s.selected.paneId === paneId && s.selected.paperId === paperId ? s.selected.id : null,
  );
  const hoverId = useAnnotationStore((s) => (s.hover && s.hover.paneId === paneId ? s.hover.id : null));
  const flash = useAnnotationStore((s) => (s.flash && s.flash.paneId === paneId ? s.flash : null));

  useRelocatedRects(ctx, visible);
  usePageClick(ctx, visible);

  return (
    <div className="pl-hl-layer" data-annotation-layer={pageNumber}>
      {visible.map((a) => {
        const strong = strongColor(a.color);
        const sel = a.id === selectedId;
        const hover = a.id === hoverId;
        const flashing = flash?.id === a.id;
        return a.rects.map((r, i) => {
          const s = pdfRectToScreen(viewport, r);
          return (
            <div
              key={`${a.id}:${i}:${flashing ? flash.seq : 0}`}
              className="pl-hl"
              data-annotation-id={a.id}
              data-selected={sel || undefined}
              data-hover={hover || undefined}
              data-flash={flashing || undefined}
              style={
                {
                  left: s.left,
                  top: s.top,
                  width: s.width,
                  height: s.height,
                  background: a.color,
                  "--hl-strong": strong,
                } as CSSProperties
              }
            />
          );
        });
      })}
    </div>
  );
}

/** 按下到抬起移动超过这么多像素算拖动（拖选），不算点击 */
const CLICK_SLOP = 4;

/**
 * 页面点击：高亮在文本层之下收不到事件，在 pageEl 上自己做命中判断。
 * 以 click（冒泡阶段）的 defaultPrevented 判断术语模块是否已处理（它在捕获阶段 preventDefault）。
 * pdf.js 文本层在 mousedown 时会挪动 endOfContent 元素，点在文字之间的空白处时浏览器常常不派发 click，
 * 所以由 pointerup 驱动：等同一手势的 click（若有）派发完再判断。
 */
function usePageClick(ctx: PageLayerContext, visible: Annotation[]) {
  const annsRef = useRef(visible);
  annsRef.current = visible;
  const { pageEl, viewport, paneId, paperId } = ctx;
  useEffect(() => {
    let down: { x: number; y: number } | null = null;
    let click: MouseEvent | null = null;
    let timer = 0;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      click = null;
    };
    const onClick = (e: MouseEvent) => {
      click = e;
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || e.button !== 0 || e.shiftKey) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP) return;
      const { clientX, clientY } = e;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const c = click;
        click = null;
        if (c?.defaultPrevented) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return;
        const r = pageEl.getBoundingClientRect();
        const [x, y] = viewport.convertToPdfPoint(clientX - r.left, clientY - r.top);
        // 容差约 1.5 CSS 像素
        const id = hitTest(annsRef.current, x, y, 1.5 / viewport.scale);
        const store = useAnnotationStore.getState();
        if (id) store.select({ paneId, paperId, id });
        else if (store.selected?.paneId === paneId) store.select(null);
      }, 0);
    };
    pageEl.addEventListener("pointerdown", onDown);
    pageEl.addEventListener("click", onClick);
    pageEl.addEventListener("pointerup", onUp);
    return () => {
      window.clearTimeout(timer);
      pageEl.removeEventListener("pointerdown", onDown);
      pageEl.removeEventListener("click", onClick);
      pageEl.removeEventListener("pointerup", onUp);
    };
  }, [pageEl, viewport, paneId, paperId]);
}

/** 重新锚定过的批注（rects 为空）：在本页文本中定位引用，用字形映射算出矩形写回 */
function useRelocatedRects(ctx: PageLayerContext, visible: Annotation[]) {
  const done = useRef(new Set<string>());
  const pending = visible.filter((a) => a.rects.length === 0 && !done.current.has(`${a.id}:${ctx.fileHash}`));
  const key = pending.map((a) => a.id).join(",");
  const text = ctx.text;
  useEffect(() => {
    if (!key || !text) return;
    const run = () => {
      const pageText = [{ page: ctx.pageNumber, text: text.normalized.text }];
      for (const a of pending) {
        const tag = `${a.id}:${ctx.fileHash}`;
        if (done.current.has(tag)) continue;
        done.current.add(tag);
        const m = findQuote(pageText, a.quote, { page: ctx.pageNumber });
        const rects = m ? textRangeToPdfRects(ctx, m.start, m.end) : [];
        if (rects.length) void fillAnnotationRects(a.id, ctx.fileHash, rects);
        else void markAnnotationOrphaned(a.id, ctx.fileHash);
      }
    };
    if (text.charBoxes) {
      run();
      return;
    }
    const t = setTimeout(run, GLYPH_WAIT_MS);
    return () => clearTimeout(t);
    // pending 由 key 概括
  }, [key, text, ctx]);
}
