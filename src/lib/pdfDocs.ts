// PDFDocumentProxy 缓存：同一篇论文在多个标签/分栏中共享一个文档对象。
// 以 paperId + fileHash 为键：论文换了 PDF 文件后得到新文档，不会拿到旧的。
// 引用计数归零后才销毁；销毁会推迟一小段时间，避免 StrictMode 的卸载-重挂载或
// 标签在分栏、前后台之间移动时白白销毁再重新解析。
import { db } from "@/db/schema";
import type { PDFDocumentProxy } from "@/lib/pdf";

export interface PdfKey {
  paperId: string;
  fileHash: string;
}

export type PdfLoader = (key: PdfKey) => Promise<PDFDocumentProxy>;

export interface PdfLease {
  promise: Promise<PDFDocumentProxy>;
  /** 可重复调用，只生效一次 */
  release: () => void;
}

export interface PdfDocCacheStats {
  /** 累计调用 loader 的次数 */
  loads: number;
  /** 累计销毁的次数 */
  destroys: number;
  entries: { paperId: string; fileHash: string; refs: number }[];
}

interface Entry extends PdfKey {
  refs: number;
  promise: Promise<PDFDocumentProxy>;
  timer: ReturnType<typeof setTimeout> | null;
}

const keyOf = (k: PdfKey) => `${k.paperId}\u0000${k.fileHash}`;

export function createPdfDocCache(loader: PdfLoader, destroyDelay = 0) {
  const entries = new Map<string, Entry>();
  const destroyListeners = new Set<(doc: PDFDocumentProxy) => void>();
  let loads = 0;
  let destroys = 0;

  function acquire(key: PdfKey): PdfLease {
    const k = keyOf(key);
    let entry = entries.get(k);
    if (!entry) {
      loads++;
      const promise = loader(key);
      promise.catch(() => {}); // 错误由使用方处理，这里只防止未处理的 rejection
      entry = { ...key, refs: 0, promise, timer: null };
      entries.set(k, entry);
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.refs++;
    const e = entry;
    let released = false;
    return {
      promise: e.promise,
      release: () => {
        if (released) return;
        released = true;
        e.refs--;
        if (e.refs > 0) return;
        e.timer = setTimeout(() => {
          e.timer = null;
          if (e.refs > 0 || entries.get(k) !== e) return;
          entries.delete(k);
          destroys++;
          e.promise.then(
            (doc) => {
              for (const fn of destroyListeners) fn(doc);
              // pdf.js 6 去掉了 PDFDocumentProxy.destroy()，改由 loadingTask 销毁（同时结束其 Worker）
              return doc.loadingTask.destroy();
            },
            () => {},
          );
        }, destroyDelay);
      },
    };
  }

  /** 文档销毁前通知（用于清理按文档持有的页面缓存）；返回取消订阅函数 */
  function onDestroy(fn: (doc: PDFDocumentProxy) => void) {
    destroyListeners.add(fn);
    return () => void destroyListeners.delete(fn);
  }

  function stats(): PdfDocCacheStats {
    return {
      loads,
      destroys,
      entries: [...entries.values()].map(({ paperId, fileHash, refs }) => ({ paperId, fileHash, refs })),
    };
  }

  return { acquire, onDestroy, stats };
}

/**
 * db.files 里没有某个 PDF 时的后备来源（例如从 data/ 恢复后 PDF 还没取回）。
 * 由存储模块注册：从本地服务取回、校验后写回 db.files；取不到时返回 null。
 */
export type MissingPdfResolver = (fileHash: string) => Promise<Blob | null>;
let missingPdfResolver: MissingPdfResolver | null = null;

export function setMissingPdfResolver(fn: MissingPdfResolver | null): void {
  missingPdfResolver = fn;
}

/** 从 db.files 读取 PDF（没有时经后备来源取回）并用 pdf.js 打开 */
export const loadPdfFromDb: PdfLoader = async ({ paperId, fileHash }) => {
  const t0 = performance.now();
  const file = await db.files.get(fileHash);
  const blob = file?.blob ?? (missingPdfResolver ? await missingPdfResolver(fileHash) : null);
  if (!blob) throw new Error("缺少 PDF 文件，请重新导入该文件");
  const buf = await blob.arrayBuffer();
  const size = buf.byteLength; // loadPdf 会转移 buffer，之后长度为 0
  const t1 = performance.now();
  // 动态导入，pdf.js 单独分包，也让只用到缓存逻辑的单元测试不必加载 pdf.js
  const { loadPdf } = await import("@/lib/pdf");
  const t2 = performance.now();
  const doc = await loadPdf(buf);
  if (import.meta.env.DEV) {
    const ms = (a: number, b: number) => (b - a).toFixed(0);
    console.debug(
      `[pdfDocs] ${paperId}: 读取 ${(size / 1048576).toFixed(1)} MB ${ms(t0, t1)} ms，加载 pdf.js ${ms(t1, t2)} ms，解析 ${ms(t2, performance.now())} ms`,
    );
  }
  return doc;
};

// 释放后留 300 ms 宽限：标签在前后台、分栏之间移动时，接手者通常在同一帧内就重新持有
const defaultCache = createPdfDocCache(loadPdfFromDb, 300);

/** 获取论文的 PDF 文档；用完调用 release() */
export const acquirePdf = defaultCache.acquire;
export const onPdfDestroyed = defaultCache.onDestroy;
export const pdfDocStats = defaultCache.stats;

// 开发模式下暴露缓存状态，供 e2e 检查共享与销毁
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__paperlensPdfDocs = { stats: pdfDocStats };
}
