// 文本层封装：创建 / 缩放更新 / 销毁 pdf.js TextLayer，并处理跨 span、跨行拖选（endOfContent）。
// PageView 只依赖这里导出的接口；以后若改用别的文字定位方式，只需替换本文件。
import { pdfjs, type PageViewport, type TextContent } from "@/lib/pdf";
import type { TextItemLike } from "@/engine/types";
import { applyWordLevelFix, SEG_CLASS, type WordFixStats } from "./wordFix";
import "./viewer.css";

export interface PageTextLayer {
  /** 文本层根元素（.textLayer） */
  readonly el: HTMLElement;
  /** 与 TextItem（过滤掉 TextMarkedContent 后）一一对应的 span；空字符串片段的 span 不在 DOM 中 */
  readonly divs: HTMLElement[];
  /** 渲染完成后 resolve；被 destroy() 取消时 reject（AbortException） */
  render(): Promise<void>;
  /** 缩放变化后调用。渲染尚未完成时会在完成后自动应用 */
  update(viewport: PageViewport): void;
  /**
   * 用字形映射做词级校正（拆出词/空白子 span 并设置 letter-spacing），让原生选区落在字形上。
   * 须在 render() 完成后调用；同一层重复调用无副作用。
   */
  applyGlyphFix(items: readonly TextItemLike[], charBoxes: Float32Array[], viewport: PageViewport): WordFixStats | null;
  destroy(): void;
}

export interface CreateTextLayerOptions {
  /** 文本层挂载的位置（position: absolute; inset: 0 的容器） */
  host: HTMLElement;
  textContent: TextContent;
  viewport: PageViewport;
}

export function createPageTextLayer({ host, textContent, viewport }: CreateTextLayerOptions): PageTextLayer {
  const el = document.createElement("div");
  el.className = "textLayer";
  // TextLayer 按 textContent.lang 测量字宽；若 span 继承页面的 lang="zh-CN"，通用字体会解析成中文字体，
  // 实际宽度与测量值不一致，整行错位（见 docs/decisions.md D1）
  el.lang = textContent.lang ?? "";
  host.append(el);

  const layer = new pdfjs.TextLayer({ textContentSource: textContent, container: el, viewport });
  const ac = new AbortController();
  let rendered = false;
  let destroyed = false;
  let pendingViewport: PageViewport | null = null;
  let fixed = false;

  const render = async () => {
    await layer.render();
    if (destroyed) return;
    rendered = true;
    const end = document.createElement("div");
    end.className = "endOfContent";
    el.append(end);
    bindSelection(el, end, ac.signal);
    if (pendingViewport) {
      layer.update({ viewport: pendingViewport });
      pendingViewport = null;
    }
  };

  return {
    el,
    get divs() {
      return layer.textDivs;
    },
    render,
    update(vp) {
      if (destroyed) return;
      if (rendered) layer.update({ viewport: vp });
      else pendingViewport = vp;
    },
    applyGlyphFix(items, charBoxes, vp) {
      if (destroyed || !rendered || fixed) return null;
      fixed = true;
      return applyWordLevelFix(layer.textDivs, items, charBoxes, vp);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      layer.cancel();
      ac.abort();
      unregisterLayer(el);
      el.replaceChildren();
      el.remove();
    },
  };
}

// ---- 选区处理（移植自 pdf.js web/text_layer_builder.js）----
// 拖选时给文本层加 .selecting，让 endOfContent 铺满整层：鼠标移到文字之间的空白处时，
// 选区仍停留在文本层内，不会跳到页面其他元素或整段全选。

const layers = new Map<HTMLElement, HTMLElement>(); // 文本层 → endOfContent
let globalAC: AbortController | null = null;

function bindSelection(div: HTMLElement, end: HTMLElement, signal: AbortSignal) {
  div.addEventListener("mousedown", () => div.classList.add("selecting"), { signal });
  div.addEventListener(
    "copy",
    (event) => {
      // 复制时做 Unicode 规范化（ﬁ → fi），并去掉 NUL
      const text = pdfjs.normalizeUnicode(document.getSelection()?.toString() ?? "").replace(/\0/g, "");
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
      event.stopPropagation();
    },
    { signal },
  );
  layers.set(div, end);
  enableGlobalSelectionListener();
}

function unregisterLayer(div: HTMLElement) {
  layers.delete(div);
  if (layers.size === 0) {
    globalAC?.abort();
    globalAC = null;
  }
}

function resetLayer(end: HTMLElement, div: HTMLElement) {
  div.append(end);
  end.style.width = "";
  end.style.height = "";
  end.style.userSelect = "";
  div.classList.remove("selecting");
}

function enableGlobalSelectionListener() {
  if (globalAC) return;
  globalAC = new AbortController();
  const { signal } = globalAC;
  let isPointerDown = false;
  let prevRange: Range | null = null;
  // Firefox 与 Chromium ≥ 148 原生处理得好，不需要移动 endOfContent
  let nativeOk: boolean | undefined;

  document.addEventListener("pointerdown", () => (isPointerDown = true), { signal });
  document.addEventListener(
    "pointerup",
    () => {
      isPointerDown = false;
      layers.forEach(resetLayer);
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      isPointerDown = false;
      layers.forEach(resetLayer);
    },
    { signal },
  );
  document.addEventListener(
    "keyup",
    () => {
      if (!isPointerDown) layers.forEach(resetLayer);
    },
    { signal },
  );
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        layers.forEach(resetLayer);
        return;
      }
      const active = new Set<HTMLElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const div of layers.keys()) if (!active.has(div) && range.intersectsNode(div)) active.add(div);
      }
      for (const [div, end] of layers) {
        if (active.has(div)) div.classList.add("selecting");
        else resetLayer(end, div);
      }

      if (nativeOk === undefined) {
        const first = layers.keys().next().value;
        nativeOk = !!first && getComputedStyle(first).getPropertyValue("-moz-user-select") === "none";
        if (!nativeOk) {
          const m = /\bChrome\/(\d+)\b/.exec(navigator.userAgent);
          nativeOk = !!m && parseInt(m[1], 10) >= 148;
        }
      }
      if (nativeOk) return;

      // 旧版 Chromium：把 endOfContent 移到选区端点旁边，防止拖到空白处时选区跳动
      const range = selection.getRangeAt(0);
      const modifyStart =
        !!prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
      if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      // 词级校正拆出的子 span：以所在的片段 span 为准
      if ((anchor as Element | null)?.classList?.contains(SEG_CLASS)) anchor = anchor!.parentNode;
      if (!modifyStart && range.endOffset === 0 && anchor) {
        do {
          while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
          anchor = anchor?.previousSibling ?? null;
        } while (anchor && !anchor.childNodes.length);
      }
      const parentLayer = (anchor as Element | null)?.parentElement?.closest<HTMLElement>(".textLayer");
      const end = parentLayer ? layers.get(parentLayer) : undefined;
      if (end && parentLayer && anchor?.parentElement) {
        end.style.width = parentLayer.style.width;
        end.style.height = parentLayer.style.height;
        end.style.userSelect = "text";
        anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
      }
      prevRange = range.cloneRange();
    },
    { signal },
  );
}
