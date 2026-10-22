import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPdfDocCache, type PdfKey } from "@/lib/pdfDocs";
import type { PDFDocumentProxy } from "@/lib/pdf";

const k = (paperId: string, fileHash = "h1"): PdfKey => ({ paperId, fileHash });

function fakeLoader() {
  const destroyed: string[] = [];
  const loader = vi.fn(async ({ paperId, fileHash }: PdfKey) => {
    const doc = { id: `${paperId}@${fileHash}`, loadingTask: { destroy: async () => void destroyed.push(`${paperId}@${fileHash}`) } };
    return doc as unknown as PDFDocumentProxy;
  });
  return { loader, destroyed };
}

describe("createPdfDocCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("同一论文共享一次加载，最后一个引用释放后才销毁", async () => {
    const { loader, destroyed } = fakeLoader();
    const cache = createPdfDocCache(loader);
    const a = cache.acquire(k("p1"));
    const b = cache.acquire(k("p1"));
    expect(await a.promise).toBe(await b.promise);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats().entries).toEqual([{ paperId: "p1", fileHash: "h1", refs: 2 }]);

    a.release();
    a.release(); // 重复释放无效
    await vi.runAllTimersAsync();
    expect(destroyed).toEqual([]);

    b.release();
    await vi.runAllTimersAsync();
    expect(destroyed).toEqual(["p1@h1"]);
    expect(cache.stats()).toMatchObject({ loads: 1, destroys: 1, entries: [] });
  });

  it("释放后立刻重新获取（StrictMode 重挂载）不会销毁重载", async () => {
    const { loader, destroyed } = fakeLoader();
    const cache = createPdfDocCache(loader);
    cache.acquire(k("p1")).release();
    const again = cache.acquire(k("p1"));
    await vi.runAllTimersAsync();
    expect(destroyed).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(1);
    again.release();
    await vi.runAllTimersAsync();
    expect(destroyed).toEqual(["p1@h1"]);
  });

  it("加载失败的条目释放后可重试", async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({
      loadingTask: { destroy: async () => {} },
    });
    const cache = createPdfDocCache(loader);
    const a = cache.acquire(k("p1"));
    await expect(a.promise).rejects.toThrow("boom");
    a.release();
    await vi.runAllTimersAsync();
    const b = cache.acquire(k("p1"));
    await expect(b.promise).resolves.toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("同一论文换了 PDF 文件（fileHash 变化）得到新文档", async () => {
    const { loader } = fakeLoader();
    const cache = createPdfDocCache(loader);
    const a = await cache.acquire(k("p1", "old")).promise;
    const b = await cache.acquire(k("p1", "new")).promise;
    expect(a).not.toBe(b);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("销毁前通知监听者", async () => {
    const { loader } = fakeLoader();
    const cache = createPdfDocCache(loader);
    const seen: unknown[] = [];
    const off = cache.onDestroy((doc) => seen.push(doc));
    const lease = cache.acquire(k("p1"));
    const doc = await lease.promise;
    lease.release();
    await vi.runAllTimersAsync();
    expect(seen).toEqual([doc]);
    off();
  });
});
