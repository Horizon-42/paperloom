import { Component, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "@/lib/pdf";
import type { PaneId } from "@/app/stores/reader";
import { docOverlays, pageOverlays, type PageLayerContext, type PageOverlayEntry, type PageTextInfo } from "./overlays";
import {
  domRangeToTextRange,
  itemRangeToTextRange,
  refineRangeByPointer,
  textOffsetAtPoint,
  textRangeFromPointer,
  textRangeToPdfRects,
} from "@/lib/textGeometry";
import { MARGIN_WIDTH, PAGE_GAP } from "./layout";
import { PageRenderer, pageCacheStats } from "./pageRenderer";
import "./viewer.css";

export { MARGIN_WIDTH };

// 开发模式下暴露注册表和定位函数，供 e2e 注册测试用覆盖层、验证字形定位
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__paperlensViewer = {
    pageOverlays,
    docOverlays,
    MARGIN_WIDTH,
    textGeometry: { textRangeToPdfRects, domRangeToTextRange, itemRangeToTextRange, textOffsetAtPoint, refineRangeByPointer, textRangeFromPointer },
    pageCacheStats,
  };
}

export interface PageViewProps {
  doc: PDFDocumentProxy;
  page: PDFPageProxy;
  paneId: PaneId;
  paperId: string;
  fileHash: string;
  /** 当前缩放下的 viewport（CSS 像素） */
  viewport: PageViewport;
  /** 布局给出的页面像素尺寸（向下取整） */
  width: number;
  height: number;
  /** 是否在渲染范围内；范围外只保留占位块 */
  active: boolean;
  isLast: boolean;
}

/**
 * 一页 = 页面（canvas → under-text 覆盖层 → 文本层 → over-text 覆盖层）+ 右侧页边栏（margin 覆盖层）。
 * 覆盖层只在页面处于渲染范围内时挂载；ctx.text 在文本层渲染完成后才有值，离开范围时随文本层一起释放。
 */
export const PageView = memo(function PageView(props: PageViewProps) {
  const { doc, page, paneId, paperId, fileHash, viewport, width, height, active, isLast } = props;
  const pageNumber = page.pageNumber;
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const textHostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PageRenderer | null>(null);
  const [text, setText] = useState<PageTextInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const r = new PageRenderer({
      doc,
      page,
      paperId,
      canvasHost: canvasHostRef.current!,
      textHost: textHostRef.current!,
      onText: setText,
      onError: setError,
    });
    rendererRef.current = r;
    return () => {
      r.destroy();
      rendererRef.current = null;
      setText(null);
    };
  }, [doc, page, paperId]);

  useEffect(() => {
    rendererRef.current?.update(active, viewport);
  }, [doc, page, paperId, active, viewport]);

  const ctx = useMemo<PageLayerContext | null>(
    () => {
      const scrollEl = pageEl?.closest<HTMLElement>("[data-viewer-scroll]");
      return pageEl && scrollEl ? { paneId, paperId, fileHash, pageNumber, viewport, pageEl, scrollEl, text } : null;
    },
    [paneId, paperId, fileHash, pageNumber, viewport, pageEl, text],
  );

  const scale = viewport.scale;
  const userUnit = viewport.userUnit || 1;
  const pageStyle = {
    width,
    height,
    "--scale-factor": scale,
    "--user-unit": userUnit,
    "--total-scale-factor": scale * userUnit,
  } as CSSProperties;

  const showOverlays = active && ctx;
  // 页角提示：无文字层（无法选字）优先于扫描件（标注精度取决于 OCR）
  const noText = !!text && !text.items.some((it) => it.str.trim());
  const badge = !active || !text ? null : noText ? "no-text" : text.scanned ? "scanned" : null;
  return (
    <div
      className="mx-auto flex"
      style={{ width: width + MARGIN_WIDTH, height, marginBottom: isLast ? 0 : PAGE_GAP }}
      data-page-row={pageNumber - 1}
    >
      <div ref={setPageEl} className="pl-page" style={pageStyle} data-page-number={pageNumber}>
        <div ref={canvasHostRef} className="pl-canvas-host" />
        <div className="pl-layer pl-layer-under">{showOverlays && renderSlot("under-text", ctx)}</div>
        <div ref={textHostRef} className="pl-text-host" />
        <div className="pl-layer pl-layer-over">{showOverlays && renderSlot("over-text", ctx)}</div>
        {badge && (
          <div
            className="absolute top-1.5 right-1.5 z-[4] cursor-default rounded bg-neutral-800/45 px-1.5 py-0.5 text-[10px] leading-4 text-white select-none hover:bg-neutral-800/75"
            title={badge === "no-text" ? "此页无文字层，无法选字" : "扫描件：标注精度取决于 OCR"}
            data-page-badge={badge}
          >
            {badge === "no-text" ? "无文字层" : "扫描件"}
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-red-500">{error}</div>
        )}
      </div>
      <div className="pl-margin" style={{ width: MARGIN_WIDTH, height }} data-page-margin={pageNumber}>
        {showOverlays && renderSlot("margin", ctx)}
      </div>
    </div>
  );
});

function renderSlot(slot: PageOverlayEntry["slot"], ctx: PageLayerContext) {
  return pageOverlays
    .filter((e) => e.slot === slot)
    .map(({ key, Component: C }) => (
      <OverlayBoundary key={key} name={key}>
        <C ctx={ctx} />
      </OverlayBoundary>
    ));
}

/** 单个覆盖层出错时不影响页面和其他覆盖层 */
export class OverlayBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`覆盖层 ${this.props.name} 出错`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
