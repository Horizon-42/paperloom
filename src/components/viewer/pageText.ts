// 每页文本内容缓存：getTextContent 与 normalizeItems 每个文档每页只做一次，
// 两个分栏打开同一篇论文时也共享（以 PDFDocumentProxy 为键，文档销毁后随之回收）。
import { normalizeItems } from "@/engine/normalize";
import type { NormalizedText } from "@/engine/types";
import { TEXT_CONTENT_PARAMS, type PDFDocumentProxy, type PDFPageProxy, type TextContent, type TextItem } from "@/lib/pdf";

export interface PageTextData {
  /** 原始文本内容（含 TextMarkedContent），交给文本层渲染 */
  content: TextContent;
  /** 过滤掉 TextMarkedContent 的 TextItem，下标与文本层 textDivs 对齐 */
  items: TextItem[];
  normalized: NormalizedText;
}

const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PageTextData>>>();

export { TEXT_CONTENT_PARAMS };

export function getPageText(doc: PDFDocumentProxy, page: PDFPageProxy): Promise<PageTextData> {
  let pages = cache.get(doc);
  if (!pages) cache.set(doc, (pages = new Map()));
  let p = pages.get(page.pageNumber);
  if (!p) {
    p = page.getTextContent(TEXT_CONTENT_PARAMS).then((content) => {
      const items = content.items.filter((it): it is TextItem => "str" in it);
      return { content, items, normalized: normalizeItems(items) };
    });
    // 失败（如文档已销毁）时不缓存，下次重试
    p.catch(() => pages!.delete(page.pageNumber));
    pages.set(page.pageNumber, p);
  }
  return p;
}
