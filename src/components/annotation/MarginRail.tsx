// 角注栏（文档级 margin 覆盖层，见 docs/decisions.md D4）：
// 卡片目标纵坐标 = 页顶 + 批注第一个矩形的顶部；整篇文档范围内依次下推错开，选中的卡片对齐原文。
// 有笔记的批注显示完整卡片；没有笔记的只在页边显示色条，选中后展开为空卡片。
// 布局用全部批注计算，只渲染渲染范围附近的卡片和色条。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAnnotationStore } from "@/app/stores/annotation";
import { usePaperCanvasPresence } from "@/components/canvas/presence";
import type { JumpRequest } from "@/app/stores/reader";
import type { DocLayerContext, DocPageLayout } from "@/components/viewer/overlays";
import { listAnnotationsByPaper } from "@/db/repo/annotations";
import { t } from "@/i18n";
import { pdfRectToScreen, type ScreenRect } from "@/lib/coords";
import { ensureAnchored } from "@/services/reanchorService";
import type { Annotation } from "@/types/models";
import { strongColor } from "./colors";
import { estimateCardHeight, stackCards } from "./geometry";
import { isDrawable } from "./HighlightLayer";
import { MarginCard } from "./MarginCard";

/** 页边色条所占的宽度（卡片在它右侧） */
const STRIP = 14;
const CARD_GAP = 6;
const RIGHT_PAD = 10;
/** 渲染范围上下再多渲染这么多像素内的卡片 */
const BAND_PAD = 600;
/** 引线连到卡片顶部以下多少像素 */
const LINK_Y = 11;

interface Entry {
  a: Annotation;
  page: DocPageLayout;
  /** 第一个矩形在页内的屏幕位置 */
  rect: ScreenRect;
  target: number;
}

export function MarginRail({ ctx }: { ctx: DocLayerContext }) {
  const { paneId, paperId, fileHash, pages, marginLeft, marginWidth, renderedRange } = ctx;
  const anns = useLiveQuery(() => listAnnotationsByPaper(paperId), [paperId]);

  // 打开论文时先校验 fileHash：有与当前文件不一致的批注就重新锚定
  useEffect(() => {
    if (!anns) return;
    ensureAnchored({ id: paperId, fileHash }, anns)?.catch((e: unknown) => console.error("Failed to re-anchor annotations", e));
  }, [anns, paperId, fileHash]);

  const selectedId = useAnnotationStore((s) =>
    s.selected && s.selected.paneId === paneId && s.selected.paperId === paperId ? s.selected.id : null,
  );
  const editingId = useAnnotationStore((s) => s.editingId);
  const hoverId = useAnnotationStore((s) => (s.hover && s.hover.paneId === paneId ? s.hover.id : null));
  const flashId = useAnnotationStore((s) => (s.flash && s.flash.paneId === paneId ? s.flash.id : null));

  useJumpFocus(ctx);
  // 在画布上或有连线的批注：没有卡片时在色条上画一个小点（点击色条展开卡片，卡片上有画布标记）
  const onCanvas = usePaperCanvasPresence(paperId);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const a of anns ?? []) {
      if (!isDrawable(a, fileHash) || !a.rects.length) continue;
      const page = pages[a.page - 1];
      if (!page) continue;
      const rect = pdfRectToScreen(page.viewport, a.rects[0]);
      out.push({ a, page, rect, target: page.top + rect.top });
    }
    return out;
  }, [anns, pages, fileHash]);

  // ---- 卡片高度：渲染过的用实测值，其余估计 ----
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const measured = useRef(new Map<string, number>());
  const raf = useRef(0);
  const onHeight = useCallback((id: string, h: number) => {
    if (!h || Math.abs((measured.current.get(id) ?? -1) - h) < 0.5) return;
    measured.current.set(id, h);
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setHeights(new Map(measured.current));
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  // 卡片宽度固定、不随缩放变化，所以实测高度在缩放后仍然有效

  const cardEntries = useMemo(
    () => entries.filter((e) => e.a.note.trim() || e.a.id === selectedId || e.a.id === editingId),
    [entries, selectedId, editingId],
  );
  const placed = useMemo(() => {
    const items = cardEntries.map((e) => ({
      id: e.a.id,
      target: e.target,
      height: heights.get(e.a.id) ?? estimateCardHeight(e.a.note, !!e.a.termId),
      order: e.page.left + e.rect.left,
    }));
    return new Map(stackCards(items, { gap: CARD_GAP, anchorId: selectedId, minY: 4 }).map((p) => [p.id, p.y]));
  }, [cardEntries, heights, selectedId]);

  const [first, last] = renderedRange;
  const bandTop = (pages[first - 1]?.top ?? 0) - BAND_PAD;
  const lastPage = pages[last - 1];
  const bandBottom = (lastPage ? lastPage.top + lastPage.height : 0) + BAND_PAD;
  const inBand = (y0: number, y1: number) => y1 >= bandTop && y0 <= bandBottom;

  const cardLeft = marginLeft + STRIP;
  const cardWidth = Math.max(120, marginWidth - STRIP - RIGHT_PAD);
  const store = useAnnotationStore.getState;

  return (
    <div className="pl-margin-rail" data-margin-rail={paneId}>
      {entries.map((e) => {
        if (!inBand(e.target, e.target + e.rect.height)) return null;
        const id = e.a.id;
        const active = id === selectedId || id === hoverId;
        const dot = onCanvas.has(id) && !e.a.note.trim() && id !== selectedId && id !== editingId;
        return (
          <button
            key={`m:${id}`}
            type="button"
            className="pl-marker pointer-events-auto absolute flex justify-center"
            style={{ left: marginLeft, top: e.target - 2, width: STRIP - 2, height: Math.max(8, e.rect.height) + 4 }}
            aria-label={t.reader.card.selectAnnotation}
            title={dot ? t.reader.card.onCanvasTitle(e.a.quote.exact.slice(0, 80)) : e.a.quote.exact.slice(0, 80)}
            data-margin-marker={id}
            onMouseEnter={() => store().setHover(paneId, id)}
            onMouseLeave={() => store().setHover(paneId, null)}
            onClick={() => store().select({ paneId, paperId, id })}
          >
            <span
              className="mt-[2px] block rounded-full"
              style={{ width: active ? 5 : 4, height: Math.max(8, e.rect.height), background: strongColor(e.a.color, active ? 35 : 20) }}
            />
            {dot && <span className="absolute -right-0.5 top-0 h-[7px] w-[7px] rounded-full bg-violet-500 ring-1 ring-white" data-canvas-dot />}
          </button>
        );
      })}
      {cardEntries.map((e) => {
        const id = e.a.id;
        const y = placed.get(id) ?? e.target;
        const h = heights.get(id) ?? estimateCardHeight(e.a.note, !!e.a.termId);
        const selected = id === selectedId;
        const pageInRange = e.a.page >= first && e.a.page <= last;
        if (!selected && id !== editingId && !pageInRange && !inBand(y, y + h)) return null;
        const emphasized = selected || id === hoverId;
        return (
          <Connector
            key={`l:${id}`}
            entry={e}
            cardLeft={cardLeft}
            cardY={y}
            emphasized={emphasized}
          />
        );
      })}
      {cardEntries.map((e) => {
        const id = e.a.id;
        const y = placed.get(id) ?? e.target;
        const h = heights.get(id) ?? estimateCardHeight(e.a.note, !!e.a.termId);
        const selected = id === selectedId;
        const pageInRange = e.a.page >= first && e.a.page <= last;
        if (!selected && id !== editingId && !pageInRange && !inBand(y, y + h)) return null;
        return (
          <MarginCard
            key={id}
            ann={e.a}
            paneId={paneId}
            top={y}
            left={cardLeft}
            width={cardWidth}
            selected={selected}
            editing={id === editingId && selected}
            flashing={id === flashId}
            onHeight={onHeight}
          />
        );
      })}
    </div>
  );
}

/** 从原文连到卡片的细线：页边部分总是画；选中/悬停时再沿第一行底边画一段页内虚线 */
function Connector({ entry, cardLeft, cardY, emphasized }: { entry: Entry; cardLeft: number; cardY: number; emphasized: boolean }) {
  const { page, rect, a } = entry;
  const pageRight = page.left + page.width;
  const y0 = page.top + rect.top + rect.height;
  const y1 = cardY + LINK_Y;
  const x0 = pageRight;
  const x1 = cardLeft;
  const top = Math.min(y0, y1) - 2;
  const height = Math.abs(y1 - y0) + 4;
  const stroke = strongColor(a.color, emphasized ? 40 : 25);
  const inPageX = page.left + rect.left + rect.width;
  return (
    <>
      {emphasized && inPageX < pageRight - 2 && (
        <div
          className="absolute"
          style={{ left: inPageX, top: y0, width: pageRight - inPageX, borderTop: `1px dashed ${stroke}`, opacity: 0.9 }}
          data-connector-inpage={a.id}
        />
      )}
      <svg
        className="absolute overflow-visible"
        style={{ left: x0, top, width: Math.max(1, x1 - x0), height }}
        aria-hidden
        data-connector={a.id}
      >
        <path
          d={`M0 ${y0 - top} C ${(x1 - x0) * 0.6} ${y0 - top}, ${(x1 - x0) * 0.4} ${y1 - top}, ${x1 - x0} ${y1 - top}`}
          fill="none"
          stroke={stroke}
          strokeWidth={emphasized ? 1.25 : 1}
          opacity={emphasized ? 1 : 0.7}
        />
      </svg>
    </>
  );
}

/** 跳转完成（目标页已挂载）后：选中批注、闪烁，并确保卡片横向可见 */
function useJumpFocus(ctx: DocLayerContext) {
  const { paneId, paperId, scrollEl } = ctx;
  useEffect(() => {
    const onJump = (ev: Event) => {
      const d = (ev as CustomEvent<JumpRequest>).detail;
      if (!d || d.paneId !== paneId || d.paperId !== paperId || !d.annotationId) return;
      const id = d.annotationId;
      const st = useAnnotationStore.getState();
      st.select({ paneId, paperId, id });
      st.flashAnnotation(paneId, id);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const card = scrollEl.querySelector<HTMLElement>(`[data-margin-card="${CSS.escape(id)}"]`);
          if (!card) return;
          const sr = scrollEl.getBoundingClientRect();
          const cr = card.getBoundingClientRect();
          const overflow = cr.right + 8 - sr.right;
          if (overflow <= 0) return;
          // 不把原文推出视野：最多滚到高亮起点仍在左侧 40px 以内
          const hl = scrollEl.querySelector<HTMLElement>(`.pl-hl[data-annotation-id="${CSS.escape(id)}"]`);
          const room = hl ? hl.getBoundingClientRect().left - sr.left - 40 : overflow;
          scrollEl.scrollLeft += Math.max(0, Math.min(overflow, room));
        }),
      );
    };
    window.addEventListener("paperlens:jumped", onJump);
    return () => window.removeEventListener("paperlens:jumped", onJump);
  }, [paneId, paperId, scrollEl]);
}
