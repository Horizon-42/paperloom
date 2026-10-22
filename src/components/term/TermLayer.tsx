// 术语自动标注（F3.2）：under-text 覆盖层，给本页匹配到的术语画虚线下划线。
// 下划线在文本层之下、不接收事件，点击和悬停在 pageEl 上用捕获阶段监听、自己做命中测试（F3.3）。
//
// 时机：等字形映射（charBoxes，首次 canvas 渲染完成后才到）就绪后再匹配和绘制，不和首帧抢时间；
// 字形映射迟迟不到（失败）时退回文本层 DOM 定位。
// 缓存：每页的匹配结果按 (NormalizedText, 匹配器版本, 作用范围) 缓存；PDF 矩形按 charBoxes 缓存；
// 缩放只重算屏幕坐标。
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PageLayerContext, PageTextInfo } from "@/components/viewer/overlays";
import type { NormalizedText, TermMatch } from "@/engine/types";
import { useTermUiStore } from "@/app/stores/termUi";
import type { PdfRect } from "@/types/models";
import { hitTest, visibleMatches } from "./logic/display";
import { orderCandidates } from "./logic/occurrences";
import { getTermRuntime, scopeContext, scopeKey, usePaperDomainIds, useTermRuntime, type TermRuntime } from "./runtime";
import { cancelHover, hoverMatch, pageUnmounted } from "./interaction";
import {
  deletePageEntry,
  pageKey,
  rangeRects,
  scrollClientRectIntoView,
  setPageEntry,
  toClientRect,
  toUnderlineSeg,
  type PageTermEntry,
  type UnderlineSeg,
} from "./pages";
import { recordTermPerf } from "./perf";
import "./term.css";

/** 字形映射最多等这么久，之后用文本层 DOM 定位先画出来 */
const GLYPH_WAIT_MS = 1500;
/** 按下到松开移动超过这么多像素视为拖选，不打开弹窗 */
const DRAG_SLOP = 4;

const EMPTY: readonly TermMatch[] = [];

const matchCache = new WeakMap<NormalizedText, { key: string; matches: TermMatch[] }>();

/** 本页全部命中（带缓存） */
function pageMatches(nt: NormalizedText, rt: TermRuntime, domainIds: readonly string[]): TermMatch[] {
  const key = `${rt.version}|${scopeKey(domainIds, rt)}`;
  const c = matchCache.get(nt);
  if (c && c.key === key) return c.matches;
  const matches = rt.matcher.match(nt, scopeContext(domainIds, rt.domainParent));
  matchCache.set(nt, { key, matches });
  return matches;
}

/** 文字是否可以开始定位：charBoxes 已到，或等待超时 */
function useTextReady(text: PageTextInfo | null): boolean {
  const [timedOut, setTimedOut] = useState<PageTextInfo | null>(null);
  useEffect(() => {
    if (!text || text.charBoxes) return;
    const t = setTimeout(() => setTimedOut(text), GLYPH_WAIT_MS);
    return () => clearTimeout(t);
  }, [text]);
  return !!text && (!!text.charBoxes || timedOut === text);
}

interface FlashState {
  seq: number;
  rects: PdfRect[];
}

export function TermUnderlineLayer({ ctx }: { ctx: PageLayerContext }) {
  const rt = useTermRuntime();
  const domainIds = usePaperDomainIds(ctx.paperId);
  const text = ctx.text;
  const ready = useTextReady(text);
  const perf = useRef<{ t0: number; matchMs: number; rectMs: number; kind: string } | null>(null);
  const drawn = useRef(false);

  // ---- 匹配 ----
  const nt = text?.normalized;
  const all = useMemo(() => {
    if (!nt || !ready || !rt.loaded || domainIds === undefined) return null;
    const t0 = performance.now();
    const m = pageMatches(nt, rt, domainIds ?? []);
    perf.current = { t0, matchMs: performance.now() - t0, rectMs: 0, kind: drawn.current ? "update" : "initial" };
    return m;
    // rt 的其余字段（display 等）变化不需要重新匹配
  }, [nt, ready, rt.loaded, rt.version, rt.domainVersion, domainIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => (all ? visibleMatches(all, rt.display) : EMPTY), [all, rt.display]);

  // ---- PDF 矩形（与缩放无关）与屏幕段 ----
  const pdfRects = useMemo(() => {
    const t0 = performance.now();
    const out = shown.map((m) => rangeRects(ctx, m.start, m.end));
    if (perf.current) perf.current.rectMs += performance.now() - t0;
    return out;
  }, [shown, text]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewport = ctx.viewport;
  const segs = useMemo(() => {
    if (!perf.current && shown.length) perf.current = { t0: performance.now(), matchMs: 0, rectMs: 0, kind: "zoom" };
    return pdfRects.map((rs) => rs.map((r) => toUnderlineSeg(viewport, r)));
  }, [pdfRects, viewport]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const p = perf.current;
    if (!p) return;
    perf.current = null;
    if (!all) return;
    drawn.current = true;
    recordTermPerf({
      paperId: ctx.paperId,
      page: ctx.pageNumber,
      kind: p.kind,
      matches: all.length,
      shown: shown.length,
      segments: segs.reduce((n, s) => n + s.length, 0),
      matchMs: p.matchMs,
      rectMs: p.rectMs,
      totalMs: performance.now() - p.t0,
      glyphs: !!text?.charBoxes,
      terms: rt.matcher.terms.length,
    });
  }, [segs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 登记到页面表（弹窗定位、导航用）----
  const key = pageKey(ctx.paneId, ctx.paperId, ctx.pageNumber);
  const entryRef = useRef<PageTermEntry | null>(null);
  useLayoutEffect(() => {
    const e: PageTermEntry = { ctx, matches: all };
    entryRef.current = e;
    setPageEntry(key, e);
  }, [key, ctx, all]);
  useEffect(() => {
    const { paneId, paperId, pageNumber } = ctx;
    return () => {
      if (entryRef.current) deletePageEntry(key, entryRef.current);
      pageUnmounted(paneId, paperId, pageNumber);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 点击与悬停 ----
  const live = useRef({ ctx, shown, segs, domainIds });
  live.current = { ctx, shown, segs, domainIds };
  useEffect(() => {
    const el = ctx.pageEl;
    let down: { x: number; y: number } | null = null;
    let hovering = false;

    const hit = (clientX: number, clientY: number) => {
      const { ctx, shown, segs, domainIds } = live.current;
      if (!segs.length) return null;
      const o = ctx.pageEl.getBoundingClientRect();
      const h = hitTest(segs, clientX - o.left, clientY - o.top, 1);
      if (!h) return null;
      const m = shown[h.index];
      const rt = getTermRuntime();
      const termIds = orderCandidates(m.termIds, rt.termById, domainIds ?? [], rt.domainParent);
      return {
        termIds,
        anchor: { paneId: ctx.paneId, paperId: ctx.paperId, page: ctx.pageNumber, start: m.start, end: m.end, seg: h.seg },
      };
    };
    const setHover = (on: boolean) => {
      if (on === hovering) return;
      hovering = on;
      if (on) el.dataset.termHover = "";
      else delete el.dataset.termHover;
    };

    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      cancelHover();
    };
    const onClick = (e: MouseEvent) => {
      const start = down;
      down = null;
      if (e.button !== 0 || e.shiftKey || e.defaultPrevented) return;
      // 拖选结束时的 click 不算
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      const h = hit(e.clientX, e.clientY);
      if (!h) return;
      // 批注模块在冒泡阶段监听 click，看到 defaultPrevented 就不处理
      e.preventDefault();
      useTermUiStore.getState().openPopover({ mode: "edit", termIds: h.termIds, activeTermId: h.termIds[0], anchor: h.anchor });
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons || e.pointerType === "touch") {
        setHover(false);
        hoverMatch(null);
        return;
      }
      const h = hit(e.clientX, e.clientY);
      setHover(!!h);
      hoverMatch(h);
    };
    const onLeave = () => {
      setHover(false);
      hoverMatch(null);
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("click", onClick, true);
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      setHover(false);
    };
  }, [ctx.pageEl]);

  // ---- 弹窗锚点高亮 ----
  const active = useTermUiStore((s) => {
    const a = s.popover?.anchor;
    return a && a.paneId === ctx.paneId && a.paperId === ctx.paperId && a.page === ctx.pageNumber ? `${a.start}:${a.end}` : null;
  });

  // ---- 跳转定位：目标页就绪后闪烁并滚动到可见 ----
  const flash = useTermUiStore((s) => s.flash);
  const [flashState, setFlashState] = useState<FlashState | null>(null);
  // 定位滚动不借 effect 的清理函数取消（clearFlash 会让 effect 重跑）；执行时若已有更新的定位请求就放弃，
  // 否则较早的滚动可能在之后的跨页跳转后才执行（页面空闲时 rAF 会推迟），把阅读器滚回去
  const scrollRaf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);
  useEffect(() => {
    if (!flash || flash.paneId !== ctx.paneId || flash.paperId !== ctx.paperId || flash.page !== ctx.pageNumber) return;
    if (!all) return; // 等文字和匹配就绪
    const st = useTermUiStore.getState();
    const range = flash.range ?? all.find((m) => m.termIds.includes(flash.termId));
    if (!range) {
      st.clearFlash(flash.seq);
      return;
    }
    const rects = rangeRects(ctx, range.start, range.end);
    if (flash.movePopover) {
      st.moveAnchor({ paneId: ctx.paneId, paperId: ctx.paperId, page: ctx.pageNumber, start: range.start, end: range.end, seg: 0 });
    }
    st.clearFlash(flash.seq);
    setFlashState({ seq: flash.seq, rects });
    if (!rects.length) return;
    // 等阅读器自己的跳转滚动（同一轮提交里的父组件 effect）完成后再滚
    const first = rects[0];
    const seq = flash.seq;
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = requestAnimationFrame(() => {
        if (useTermUiStore.getState().lastFlashSeq !== seq) return;
        // 用滚动时的 ctx（这两帧里可能缩放过）
        const { pageEl, scrollEl, viewport } = live.current.ctx;
        if (pageEl.isConnected) scrollClientRectIntoView(scrollEl, toClientRect(pageEl, toUnderlineSeg(viewport, first)));
      });
    });
  }, [flash, all]); // eslint-disable-line react-hooks/exhaustive-deps

  const style = { "--pl-ul": `${Math.max(1, Math.round(viewport.scale * 0.9 * 2) / 2)}px` } as CSSProperties;
  return (
    <div className="pl-term-layer" style={style} data-term-layer={ctx.pageNumber}>
      <Underlines shown={shown} segs={segs} active={active} />
      {flashState && (
        <div key={flashState.seq} data-term-flash={flashState.seq} onAnimationEnd={() => setFlashState(null)}>
          {flashState.rects.map((r, i) => {
            const s = toUnderlineSeg(viewport, r);
            return <div key={i} className="pl-term-flash" style={{ left: s.left - 1, top: s.top - 1, width: s.width + 2, height: s.height + 2 }} />;
          })}
        </div>
      )}
    </div>
  );
}

const Underlines = memo(function Underlines({
  shown,
  segs,
  active,
}: {
  shown: readonly TermMatch[];
  segs: UnderlineSeg[][];
  active: string | null;
}) {
  return (
    <>
      {shown.map((m, i) => {
        const isActive = active === `${m.start}:${m.end}` || undefined;
        return (segs[i] ?? []).map((s, j) => (
          <div
            key={`${m.start}:${j}`}
            className="pl-term-ul"
            data-term-ul=""
            data-term-ids={m.termIds.join(" ")}
            data-start={m.start}
            data-end={m.end}
            data-seg={j}
            data-edge={s.edge}
            data-multi={m.termIds.length > 1 || undefined}
            data-active={isActive}
            style={{ left: s.left, top: s.top, width: s.width, height: s.height }}
          />
        ));
      })}
    </>
  );
});
