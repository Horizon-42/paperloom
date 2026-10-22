// 每页字形映射缓存：首次渲染成功后由捕获的 operator list 建图，按 (doc, 页码) 缓存，缩放不重算。
// 以 PDFDocumentProxy 为 WeakMap 键，文档销毁后随之回收；两个分栏打开同一篇论文时共享。
import { buildPageGlyphMap, type OperatorListLike, type PageGlyphMap } from "@/lib/glyphMap";
import type { PDFDocumentProxy, PDFPageProxy } from "@/lib/pdf";
import { getPageText, TEXT_CONTENT_PARAMS } from "./pageText";

const cache = new WeakMap<PDFDocumentProxy, Map<number, PageGlyphMap>>();
const pending = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageGlyphMap>>>();

export function getCachedGlyphs(doc: PDFDocumentProxy, pageNumber: number): PageGlyphMap | undefined {
  return cache.get(doc)?.get(pageNumber);
}

/** 用一次成功渲染得到的完整 operator list 建图；同一页并发调用只建一次 */
export function buildGlyphs(doc: PDFDocumentProxy, page: PDFPageProxy, opList: OperatorListLike): Promise<PageGlyphMap> {
  const done = getCachedGlyphs(doc, page.pageNumber);
  if (done) return Promise.resolve(done);
  let inflight = pending.get(doc);
  if (!inflight) pending.set(doc, (inflight = new Map()));
  let p = inflight.get(page.pageNumber);
  if (!p) {
    const map = inflight;
    p = getPageText(doc, page)
      .then(({ content, items }) => {
        const glyphs = buildPageGlyphMap(opList, page.commonObjs, items, {
          styles: content.styles,
          view: page.view,
          // 与 getTextContent 的 disableNormalization 相反
          normalize: !TEXT_CONTENT_PARAMS.disableNormalization,
        });
        let pages = cache.get(doc);
        if (!pages) cache.set(doc, (pages = new Map()));
        pages.set(page.pageNumber, glyphs);
        return glyphs;
      })
      .finally(() => map.delete(page.pageNumber));
    inflight.set(page.pageNumber, p);
  }
  return p;
}
