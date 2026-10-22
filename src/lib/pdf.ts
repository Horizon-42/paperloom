import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
export type { TextContent, TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

/**
 * getTextContent 的参数，阅读器与后台全文提取必须一致，否则规范化文本的偏移对不上。
 * 与 pdf.js 自带查看器一致：保留标记内容（选区顺序更合理），关闭 Unicode 规范化，
 * 让连字等原字符保留在文本层里（ﬁ 的展开由 engine/normalize 处理，复制时再规范化）。
 */
export const TEXT_CONTENT_PARAMS = { includeMarkedContent: true, disableNormalization: true } as const;

// pdf.js 的附属资源由 vite.config.ts 中的 pdfjsAssets 插件复制到 public/pdfjs/。
// 缺 wasm 时 JBIG2/JPX 图像（常见于扫描版论文）解不出来，整页空白；缺 cmaps 时部分中文 PDF 无法显示文字。
// 必须是绝对地址：这些资源由 pdf.js 的 Worker 下载，相对地址会按 Worker 脚本所在的 assets/ 解析
// （在线版用 --base=./ 构建，BASE_URL 是 "./"）。
const assetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;

// 所有文档共用一个 pdf.js Worker：传入的 worker 不会随 loadingTask.destroy() 关闭，省去每次约 280 ms 的启动
let sharedWorker: pdfjs.PDFWorker | null = null;

/** 从二进制打开 PDF。注意 pdf.js 会转移（detach）传入的 buffer，调用方不要再复用它 */
export function loadPdf(data: ArrayBuffer | Uint8Array) {
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new pdfjs.PDFWorker();
  return pdfjs.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    worker: sharedWorker,
    wasmUrl: `${assetBase}wasm/`,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    iccUrl: `${assetBase}iccs/`,
  }).promise;
}
