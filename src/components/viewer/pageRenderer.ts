// 单页的命令式渲染：canvas + 文本层 + 字形映射的创建、缩放重绘、取消与释放。
// PageView 只在"是否在渲染范围内"和"viewport"变化时调用 update()。
//
// 字形映射：该页还没有缓存时，canvas 渲染顺带捕获 operator list（operationsFilter），
// 渲染成功后建图并缓存；被取消的渲染不用（下次渲染再捕获）。字形映射与文本层都就绪后做词级校正，
// 再把带 charBoxes 的文本信息交给 PageView（在此之前 charBoxes 为 null）。
import { pdfjs, type PDFDocumentProxy, type PDFPageProxy, type PageViewport } from "@/lib/pdf";
import { captureOperatorList, type OperatorListLike, type PageGlyphMap } from "@/lib/glyphMap";
import { onPdfDestroyed } from "@/lib/pdfDocs";
import { t } from "@/i18n";
import type { RenderTask } from "pdfjs-dist";
import type { PageTextInfo } from "./overlays";
import { getPageText, type PageTextData } from "./pageText";
import { buildGlyphs, getCachedGlyphs } from "./pageGlyphs";
import { createPageTextLayer, type PageTextLayer } from "./textLayer";
import { recordPageRender } from "./perf";

/** 单个 canvas 的像素上限（约 4096²），超过时降低输出分辨率，避免浏览器拒绝分配 */
const MAX_CANVAS_PIXELS = 16_777_216;
/** 缩放时先用 CSS 拉伸旧 canvas，停止缩放这么久之后再按新尺寸重绘 */
const RERENDER_DELAY = 150;
/** 离开渲染范围的页先保留 pdf.js 的解析结果（操作列表、解码后的图片），超过这么多页时清理最久未用的 */
const RELEASED_PAGE_CACHE = 10;

// ---- 页面资源回收 ----
// pdf.js 不会自动释放页面资源，扫描版论文每页一张大图，滚完整篇会一直占着内存。
// 页面可能同时显示在两个分栏（共享 PDFPageProxy），只有所有分栏都不再显示时才进入待清理队列。
const displayed = new Map<PDFPageProxy, number>();
const released = new Map<PDFPageProxy, PDFDocumentProxy>(); // 插入顺序即 LRU 顺序

function pageShown(page: PDFPageProxy) {
  displayed.set(page, (displayed.get(page) ?? 0) + 1);
  released.delete(page);
}

function pageHidden(page: PDFPageProxy, doc: PDFDocumentProxy) {
  const n = (displayed.get(page) ?? 1) - 1;
  if (n > 0) {
    displayed.set(page, n);
    return;
  }
  displayed.delete(page);
  released.set(page, doc);
  while (released.size > RELEASED_PAGE_CACHE) {
    const oldest = released.keys().next().value!;
    released.delete(oldest);
    oldest.cleanup();
  }
}

// 文档销毁后不再持有它的页面
onPdfDestroyed((doc) => {
  for (const [page, d] of released) if (d === doc) released.delete(page);
});

/** 测试用：当前待清理队列与显示中的页数 */
export function pageCacheStats() {
  return { displayed: displayed.size, released: released.size };
}

export interface PageRendererOptions {
  doc: PDFDocumentProxy;
  page: PDFPageProxy;
  paperId: string;
  canvasHost: HTMLElement;
  textHost: HTMLElement;
  onText: (text: PageTextInfo | null) => void;
  onError: (message: string | null) => void;
}

export class PageRenderer {
  private opts: PageRendererOptions;
  private viewport: PageViewport | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private task: RenderTask | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private canvasGen = 0;
  private text: PageTextLayer | null = null;
  /** 文本层正在生成（等 getTextContent 或首次渲染）：期间的 viewport 变化只记最新值，生成时直接用 */
  private textPending = false;
  private textData: PageTextData | null = null;
  private textReady = false;
  private glyphs: PageGlyphMap | null = null;
  private fixed = false;
  /** 每次进入渲染范围 +1，用来丢弃上一轮的异步结果 */
  private activation = 0;
  private destroyed = false;
  // 首次渲染计时（-1 未完成）
  private t0 = 0;
  private canvasMs = -1;
  private textMs = -1;
  private glyphMs = -1;
  private fixMs = 0;
  private recorded = false;

  constructor(opts: PageRendererOptions) {
    this.opts = opts;
  }

  update(active: boolean, viewport: PageViewport) {
    if (this.destroyed) return;
    if (!active) {
      this.release();
      return;
    }
    const scaleChanged = this.viewport?.scale !== viewport.scale;
    const first = !this.viewport;
    this.viewport = viewport;
    if (first) this.activate();

    if (scaleChanged) {
      this.cancelCanvas();
      if (this.canvas) this.timer = setTimeout(() => this.renderCanvas("rerender"), RERENDER_DELAY);
      else this.renderCanvas("initial");
    }
    if (!this.text) {
      if (!this.textPending) this.renderText();
    } else if (scaleChanged) this.text.update(viewport);
  }

  private activate() {
    const { doc, page } = this.opts;
    this.activation++;
    pageShown(page);
    this.t0 = performance.now();
    this.canvasMs = this.textMs = this.glyphMs = -1;
    this.fixMs = 0;
    this.recorded = false;
    this.glyphs = getCachedGlyphs(doc, page.pageNumber) ?? null;
    if (this.glyphs) this.glyphMs = 0;
  }

  /** 离开渲染范围：取消任务，释放 canvas 位图和文本层 */
  release() {
    if (!this.viewport && !this.canvas && !this.text) return;
    this.cancelCanvas();
    if (this.canvas) {
      this.canvas.width = this.canvas.height = 0;
      this.canvas.remove();
      this.canvas = null;
    }
    const hadText = !!this.text;
    this.text?.destroy();
    this.text = null;
    this.textPending = false;
    this.textData = null;
    this.textReady = false;
    this.fixed = false;
    this.glyphs = null;
    if (hadText && !this.destroyed) this.opts.onText(null);
    if (this.viewport) pageHidden(this.opts.page, this.opts.doc);
    this.viewport = null;
    this.activation++;
  }

  destroy() {
    this.destroyed = true;
    this.release();
  }

  private cancelCanvas() {
    this.canvasGen++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.task) {
      this.task.cancel();
      this.task = null;
    }
  }

  private renderCanvas(kind: "initial" | "rerender") {
    this.timer = null;
    const vp = this.viewport;
    if (!vp || this.destroyed) return;
    const { doc, page } = this.opts;
    const gen = ++this.canvasGen;
    const act = this.activation;
    const started = performance.now();

    const cssW = Math.floor(vp.width);
    const cssH = Math.floor(vp.height);
    let ratio = window.devicePixelRatio || 1;
    if (cssW * cssH * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (cssW * cssH));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(vp.width * ratio));
    canvas.height = Math.max(1, Math.floor(vp.height * ratio));
    const sx = canvas.width / vp.width;
    const sy = canvas.height / vp.height;

    // 还没有字形映射时顺带捕获 operator list
    const capture = getCachedGlyphs(doc, page.pageNumber) ? null : captureOperatorList();
    const task = page.render({
      canvas,
      viewport: vp,
      transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : undefined,
      operationsFilter: capture?.operationsFilter as never,
    });
    this.task = task;
    task.promise.then(
      () => {
        const opList = capture?.get();
        // 渲染成功即 operator list 完整，即使本页已被替换/释放也可以建图缓存
        if (opList) this.onOperatorList(opList, act);
        if (gen !== this.canvasGen || this.destroyed) {
          canvas.width = canvas.height = 0;
          return;
        }
        this.task = null;
        const old = this.canvas;
        this.canvas = canvas;
        this.opts.canvasHost.replaceChildren(canvas);
        if (old) old.width = old.height = 0;
        this.opts.onError(null);
        const ms = performance.now() - started;
        if (kind === "initial") {
          this.canvasMs = performance.now() - this.t0;
          this.maybeRecord();
        } else {
          recordPageRender({
            paperId: this.opts.paperId,
            page: page.pageNumber,
            scale: vp.scale,
            kind,
            canvasMs: ms,
            textMs: 0,
            glyphMs: 0,
            fixMs: 0,
            totalMs: ms,
          });
        }
      },
      (err: unknown) => {
        canvas.width = canvas.height = 0;
        if (err instanceof pdfjs.RenderingCancelledException || gen !== this.canvasGen) return;
        console.error(`Page ${page.pageNumber} failed to render`, err);
        if (!this.destroyed) this.opts.onError(t.reader.viewer.pageRenderFailed);
      },
    );
  }

  private onOperatorList(opList: OperatorListLike, act: number) {
    const { doc, page } = this.opts;
    buildGlyphs(doc, page, opList).then(
      (glyphs) => {
        if (act !== this.activation || this.destroyed || this.glyphs) return;
        this.glyphs = glyphs;
        this.glyphMs = performance.now() - this.t0;
        this.emitText();
      },
      (err: unknown) => console.warn(`Page ${page.pageNumber}: glyph mapping failed, falling back to text-layer positioning`, err),
    );
  }

  private renderText() {
    const act = this.activation;
    const { doc, page, textHost } = this.opts;
    this.textPending = true;
    getPageText(doc, page)
      .then(async (data) => {
        if (act !== this.activation || !this.viewport || this.destroyed) return;
        // 保险：同一页任何时候只有一个文本层（含上一轮异常残留的节点）
        this.text?.destroy();
        textHost.replaceChildren();
        // 用最新的 viewport 创建；渲染期间再有变化由 PageTextLayer 记下，渲染完成后应用
        const layer = createPageTextLayer({ host: textHost, textContent: data.content, viewport: this.viewport });
        this.text = layer;
        this.textData = data;
        this.textPending = false;
        await layer.render();
        if (act !== this.activation || this.destroyed || this.text !== layer) return;
        this.textReady = true;
        this.textMs = performance.now() - this.t0;
        this.emitText();
      })
      .catch((err: unknown) => {
        if (act !== this.activation || this.destroyed) return;
        this.textPending = false;
        if (err instanceof pdfjs.AbortException) return;
        console.error(`Page ${page.pageNumber}: text layer failed`, err);
      });
  }

  /** 文本层就绪后通知 PageView；字形映射也就绪时先做词级校正，再带上 charBoxes */
  private emitText() {
    const { text, textData, glyphs, viewport } = this;
    if (!this.textReady || !text || !textData || !viewport) return;
    if (glyphs && !this.fixed) {
      this.fixed = true;
      const stats = text.applyGlyphFix(textData.items, glyphs.charBoxes, viewport);
      this.fixMs = stats?.ms ?? 0;
    }
    this.opts.onText({
      items: textData.items,
      divs: text.divs,
      layerEl: text.el,
      normalized: textData.normalized,
      charBoxes: glyphs?.charBoxes ?? null,
      scanned: glyphs?.scanned ?? false,
    });
    this.maybeRecord();
  }

  private maybeRecord() {
    if (this.recorded || this.canvasMs < 0 || this.textMs < 0 || this.glyphMs < 0 || !this.fixed) return;
    this.recorded = true;
    const done = performance.now() - this.t0;
    recordPageRender({
      paperId: this.opts.paperId,
      page: this.opts.page.pageNumber,
      scale: this.viewport?.scale ?? 0,
      kind: "initial",
      canvasMs: this.canvasMs,
      textMs: this.textMs,
      glyphMs: this.glyphs?.ms ?? 0,
      fixMs: this.fixMs,
      totalMs: done,
    });
  }
}
