import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/schema";
import { t } from "@/i18n";
import { acquirePdf } from "@/lib/pdfDocs";
import type { PDFDocumentProxy, PDFPageProxy } from "@/lib/pdf";
import { useReaderStore, type JumpRequest, type PaneId } from "@/app/stores/reader";
import { useViewerStore, type TabView } from "@/app/stores/viewer";
import {
  CSS_UNITS,
  PAD_X,
  PAD_Y,
  PAGE_GAP,
  MARGIN_WIDTH,
  anchorAt,
  clampZoom,
  computeLayout,
  currentPageIndex,
  renderRange,
  resolveScale,
  rowLeft,
  scaleToZoom,
  scrollForAnchor,
  stepZoom,
  zoomToScale,
  type DocAnchor,
  type Layout,
  type PageDims,
  type ZoomMode,
} from "./layout";
import { docOverlays, type DocLayerContext } from "./overlays";
import { OverlayBoundary, PageView } from "./PageView";
import { ViewerToolbar } from "./ViewerToolbar";

interface Loaded {
  doc: PDFDocumentProxy;
  pages: PDFPageProxy[];
  dims: PageDims[];
}

const pagesCache = new WeakMap<PDFDocumentProxy, Promise<PDFPageProxy[]>>();

/** 打开时一次取齐所有页（pdf.js 内部也会缓存 PDFPageProxy），用于占位尺寸 */
function getAllPages(doc: PDFDocumentProxy): Promise<PDFPageProxy[]> {
  let p = pagesCache.get(doc);
  if (!p) {
    p = Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    pagesCache.set(doc, p);
  }
  return p;
}

const SAVE_DELAY = 200;

interface PendingAnchor {
  anchor: DocAnchor;
  vx: number;
  vy: number;
}

/**
 * 一个分栏中当前标签的阅读视图。按论文当前的 fileHash 加载文档：
 * PDF 文件被替换后 fileHash 变化，内部视图整体重建，得到新文档。
 */
export function PdfViewer({ paneId, paperId }: { paneId: PaneId; paperId: string }) {
  // undefined：查询中；null：论文不存在
  const fileHash = useLiveQuery(async () => (await db.papers.get(paperId))?.fileHash ?? null, [paperId]);
  useEffect(() => useViewerStore.getState().touchDoc(paperId), [paperId]);
  return (
    <DocumentViewer
      key={fileHash ?? "pending"}
      paneId={paneId}
      paperId={paperId}
      fileHash={fileHash ?? null}
      missing={fileHash === null}
    />
  );
}

function DocumentViewer({
  paneId,
  paperId,
  fileHash,
  missing,
}: {
  paneId: PaneId;
  paperId: string;
  fileHash: string | null;
  missing: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---- 加载文档 ----
  useEffect(() => {
    if (!fileHash) return;
    const lease = acquirePdf({ paperId, fileHash });
    let cancelled = false;
    lease.promise
      .then(async (doc) => {
        const t0 = performance.now();
        const pages = await getAllPages(doc);
        if (cancelled) return;
        const dims = pages.map((p) => {
          const vp = p.getViewport({ scale: 1 });
          return { width: vp.width, height: vp.height };
        });
        if (import.meta.env.DEV) console.debug(`[viewer] ${pages.length} page sizes ${(performance.now() - t0).toFixed(0)} ms`);
        setLoaded({ doc, pages, dims });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("Failed to open PDF", err);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      lease.release();
    };
  }, [paperId, fileHash]);

  // ---- 缩放状态（从 store 恢复）----
  const [initialView] = useState(() => useViewerStore.getState().getTabView(paneId, paperId));
  const [zoomMode, setZoomMode] = useState<ZoomMode>(initialView?.zoomMode ?? "auto");
  const [customScale, setCustomScale] = useState(initialView?.scale ?? CSS_UNITS);
  const [containerWidth, setContainerWidth] = useState(0);

  const dims = loaded?.dims;
  const scale = useMemo(
    () => (dims && containerWidth ? resolveScale(zoomMode, customScale, containerWidth, dims) : 0),
    [dims, containerWidth, zoomMode, customScale],
  );
  const layout = useMemo(() => (dims && scale ? computeLayout(dims, scale) : null), [dims, scale]);
  const viewports = useMemo(
    () => (loaded && scale ? loaded.pages.map((p) => p.getViewport({ scale })) : []),
    [loaded, scale],
  );

  const layoutRef = useRef<Layout | null>(null);
  const viewportsRef = useRef(viewports);
  viewportsRef.current = viewports;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const zoomModeRef = useRef(zoomMode);
  zoomModeRef.current = zoomMode;
  const pendingAnchor = useRef<PendingAnchor | null>(null);
  const restored = useRef(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [range, setRange] = useState<[number, number] | null>(null);

  // ---- 视图状态保存 ----
  const viewRef = useRef<TabView | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (viewRef.current) useViewerStore.getState().saveTabView(paneId, paperId, viewRef.current);
  }, [paneId, paperId]);
  useEffect(() => flushSave, [flushSave]);

  /** 从当前滚动位置同步：当前页、保存用的视图状态 */
  const syncFromScroll = useCallback(() => {
    const el = scrollRef.current;
    const L = layoutRef.current;
    if (!el || !L || !el.clientWidth) return;
    const idx = currentPageIndex(L, el.scrollTop, el.clientHeight, el.scrollHeight);
    setCurrentPage(idx + 1);
    const top = anchorAt(L, { top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth }, 0, 0);
    viewRef.current = {
      zoomMode: zoomModeRef.current,
      scale: L.scale,
      page: top.index + 1,
      pageFrac: top.fracY,
    };
    if (!saveTimer.current) saveTimer.current = setTimeout(flushSave, SAVE_DELAY);
  }, [flushSave]);

  const scrollRaf = useRef(0);
  const onScroll = useCallback(() => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      syncFromScroll();
    });
  }, [syncFromScroll]);
  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);

  /** 记下视口内 (vx, vy) 处的文档位置，缩放后让它保持在原处；缺省为视口中心 */
  const captureAnchor = useCallback((vx?: number, vy?: number) => {
    const el = scrollRef.current;
    const L = layoutRef.current;
    if (!el || !L) return;
    const x = vx ?? el.clientWidth / 2;
    const y = vy ?? el.clientHeight / 2;
    pendingAnchor.current = {
      anchor: anchorAt(L, { top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth }, x, y),
      vx: x,
      vy: y,
    };
  }, []);

  // ---- 容器宽度（适合宽度用）----
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    setContainerWidth(el.clientWidth);
    let hidden = el.clientWidth === 0;
    const ro = new ResizeObserver(() => {
      // 阅读器被隐藏（切到术语表等视图，display: none）时不重算；重新显示时恢复滚动位置
      if (el.clientWidth === 0) {
        hidden = true;
        return;
      }
      if (hidden) {
        hidden = false;
        const L = layoutRef.current;
        const v = viewRef.current;
        if (L && v) {
          const i = Math.min(v.page, L.tops.length) - 1;
          el.scrollTop = Math.max(0, L.tops[i] + v.pageFrac * L.heights[i]);
        }
      }
      if (zoomModeRef.current !== "custom") captureAnchor();
      setContainerWidth(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [captureAnchor]);

  // ---- 布局变化后恢复滚动位置 ----
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!layout || !el) return;
    const prev = layoutRef.current;
    layoutRef.current = layout;
    if (!restored.current) {
      restored.current = true;
      if (initialView) {
        const i = Math.min(initialView.page, layout.tops.length) - 1;
        el.scrollTop = Math.max(0, layout.tops[i] + initialView.pageFrac * layout.heights[i]);
      }
    } else if (prev && prev.scale !== layout.scale && pendingAnchor.current) {
      const { anchor, vx, vy } = pendingAnchor.current;
      const s = scrollForAnchor(layout, anchor, el.clientWidth, vx, vy);
      el.scrollTop = s.top;
      el.scrollLeft = s.left;
    }
    pendingAnchor.current = null;
    syncFromScroll();
  }, [layout, initialView, syncFromScroll]);

  // 缩放模式变了但 scale 没变（如已经是适合宽度的尺寸）时，布局效果不会触发，这里补记一次视图状态
  useEffect(() => {
    syncFromScroll();
  }, [zoomMode, customScale, syncFromScroll]);

  // ---- 懒加载：IntersectionObserver 跟踪可见页，渲染其前后各 2 页 ----
  const pageCount = loaded?.pages.length ?? 0;
  const hasLayout = !!layout;
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !pageCount || !hasLayout) return;
    const visible = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.pageRow);
          if (e.isIntersecting) visible.add(i);
          else visible.delete(i);
        }
        // 被隐藏时所有页都"不可见"，保留已渲染的页面
        if (!root.clientWidth) return;
        const r = renderRange(visible, pageCount);
        setRange((prev) => (prev && r && prev[0] === r[0] && prev[1] === r[1] ? prev : r));
      },
      { root },
    );
    root.querySelectorAll<HTMLElement>("[data-page-row]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pageCount, hasLayout]);

  // ---- 缩放操作 ----
  const zoomTo = useCallback(
    (zoom: number, at?: { clientX: number; clientY: number }) => {
      const el = scrollRef.current;
      if (!el || !scaleRef.current) return;
      const next = zoomToScale(clampZoom(zoom));
      if (Math.abs(next - scaleRef.current) < 1e-6 && zoomModeRef.current === "custom") return;
      if (at) {
        const r = el.getBoundingClientRect();
        captureAnchor(at.clientX - r.left, at.clientY - r.top);
      } else captureAnchor();
      setZoomMode("custom");
      setCustomScale(next);
    },
    [captureAnchor],
  );
  const zoomStep = useCallback((dir: 1 | -1) => zoomTo(stepZoom(scaleToZoom(scaleRef.current), dir)), [zoomTo]);
  const fitWidth = useCallback(() => {
    captureAnchor();
    setZoomMode("page-width");
  }, [captureAnchor]);

  // Ctrl/⌘ + 滚轮：鼠标滚轮按档位缩放，触控板捏合连续缩放；以指针位置为锚点
  useEffect(() => {
    const el = scrollRef.current!;
    let raf = 0;
    let delta = 0;
    let at = { clientX: 0, clientY: 0 };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      delta += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      at = { clientX: e.clientX, clientY: e.clientY };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const d = delta;
        delta = 0;
        const zoom = scaleToZoom(scaleRef.current);
        if (!zoom || !d) return;
        if (Math.abs(d) >= 50) zoomTo(stepZoom(zoom, d < 0 ? 1 : -1), at);
        else zoomTo(zoom * Math.exp(-d / 100), at);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(raf);
    };
  }, [zoomTo]);

  // Ctrl/⌘ + = / - / 0：只作用于聚焦的分栏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (useReaderStore.getState().focusedPane !== paneId) return;
      const target = e.target as HTMLElement | null;
      if (target && target !== document.body && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        if (!scrollRef.current?.parentElement?.contains(target)) return;
      }
      if (e.key === "=" || e.key === "+") zoomStep(1);
      else if (e.key === "-" || e.key === "_") zoomStep(-1);
      else if (e.key === "0") zoomTo(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneId, zoomStep, zoomTo]);

  // ---- 跳转 ----
  const scrollToPage = useCallback(
    (page: number, pdfPoint?: [number, number]) => {
      const el = scrollRef.current;
      const L = layoutRef.current;
      if (!el || !L || !L.tops.length) return;
      const i = Math.min(Math.max(1, Math.round(page)), L.tops.length) - 1;
      let top = L.tops[i] - PAGE_GAP;
      const vp = viewportsRef.current[i];
      if (pdfPoint && vp) {
        // 用完整坐标换算：旋转页上 PDF 的 y 可能对应屏幕的 x
        const [x, y] = vp.convertToViewportPoint(pdfPoint[0], pdfPoint[1]);
        top = L.tops[i] + y - el.clientHeight * 0.3;
        const left = rowLeft(L, i, el.clientWidth) + x;
        if (left < el.scrollLeft || left > el.scrollLeft + el.clientWidth - 40) {
          el.scrollLeft = Math.max(0, left - el.clientWidth * 0.3);
        }
      }
      el.scrollTop = Math.max(0, top);
      syncFromScroll();
    },
    [syncFromScroll],
  );

  const jumpRequest = useReaderStore((s) => s.jumpRequest);
  const [pendingJump, setPendingJump] = useState<JumpRequest | null>(null);
  useEffect(() => {
    if (!layout || !jumpRequest) return;
    if (jumpRequest.paneId !== paneId || jumpRequest.paperId !== paperId) return;
    if (!useViewerStore.getState().consumeJump(jumpRequest.seq)) return;
    scrollToPage(jumpRequest.page, jumpRequest.pdfPoint);
    setPendingJump(jumpRequest);
  }, [layout, jumpRequest, paneId, paperId, scrollToPage]);

  // 目标页进入渲染范围（覆盖层已挂载）后再通知批注等模块
  useEffect(() => {
    if (!pendingJump || !range || !pageCount) return;
    const i = Math.min(Math.max(1, pendingJump.page), pageCount) - 1;
    if (i < range[0] || i > range[1]) return;
    window.dispatchEvent(new CustomEvent("paperlens:jumped", { detail: pendingJump }));
    setPendingJump(null);
  }, [pendingJump, range, pageCount]);

  // ---- 文档级覆盖层（跨页的角注栏等）----
  // 只在缩放/布局/容器宽度/渲染范围变化时更新，滚动本身不改变 ctx
  const docCtx = useMemo<DocLayerContext | null>(() => {
    const scrollEl = scrollRef.current;
    if (!layout || !loaded || !range || !scrollEl || !fileHash || viewports.length !== layout.tops.length) return null;
    const pages = layout.tops.map((top, i) => ({
      pageNumber: i + 1,
      top,
      left: rowLeft(layout, i, containerWidth),
      width: layout.widths[i],
      height: layout.heights[i],
      viewport: viewports[i],
    }));
    // 页面宽度不一时各行居中，取最靠右的页边栏起点作为整列的位置
    const marginLeft = Math.max(...pages.map((p) => p.left + p.width));
    return {
      paneId,
      paperId,
      fileHash,
      pages,
      marginLeft,
      marginWidth: MARGIN_WIDTH,
      renderedRange: [range[0] + 1, range[1] + 1],
      scrollEl,
    };
  }, [layout, loaded, range, viewports, containerWidth, paneId, paperId, fileHash]);

  const status = missing ? t.reader.viewer.paperMissing : error ? t.reader.viewer.cannotOpen(error) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-viewer-pane={paneId} data-viewer-paper={paperId}>
      <ViewerToolbar
        paneId={paneId}
        paperId={paperId}
        currentPage={currentPage}
        pageCount={pageCount}
        zoom={scale ? scaleToZoom(scale) : 0}
        zoomMode={zoomMode}
        onPage={scrollToPage}
        onZoomIn={() => zoomStep(1)}
        onZoomOut={() => zoomStep(-1)}
        onFitWidth={fitWidth}
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-auto bg-neutral-200/70 outline-none"
        style={{ scrollbarGutter: "stable", overflowAnchor: "none" }}
        tabIndex={-1}
        data-viewer-scroll
      >
        {status ? (
          <div className="flex h-full items-center justify-center text-sm text-red-500">{status}</div>
        ) : !loaded || !layout || !fileHash ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">{t.reader.viewer.opening}</div>
        ) : (
          <div
            className="relative box-border"
            style={{
              width: layout.contentWidth,
              minWidth: "100%",
              padding: `${PAD_Y}px ${PAD_X}px`,
            }}
          >
            {loaded.pages.map((page, i) => (
              <PageView
                key={i}
                doc={loaded.doc}
                page={page}
                paneId={paneId}
                paperId={paperId}
                fileHash={fileHash}
                viewport={viewports[i]}
                width={layout.widths[i]}
                height={layout.heights[i]}
                active={!!range && i >= range[0] && i <= range[1]}
                isLast={i === loaded.pages.length - 1}
              />
            ))}
            {docCtx && docOverlays.length > 0 && (
              // 坐标系与 DocPageLayout 相同（内容区左上角为原点），横向覆盖到页边栏列右缘，便于画连到原文的引线
              <div
                className="pointer-events-none absolute top-0 left-0 z-[4]"
                style={{ width: docCtx.marginLeft + docCtx.marginWidth, height: layout.contentHeight }}
                data-doc-overlay
              >
                {docOverlays.map(({ key, Component: C }) => (
                  <OverlayBoundary key={key} name={key}>
                    <C ctx={docCtx} />
                  </OverlayBoundary>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
