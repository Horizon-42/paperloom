/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 阅读器 e2e 的公共工具：通过开发模式的 window.__paperlens 写入 PDF 并驱动界面。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

export const FIXTURES = fileURLToPath(new URL("../../fixtures", import.meta.url));
export const SHOTS = process.env.PAPERLENS_SHOTS_DIR;
export const LIT = process.env.PAPERLENS_LITERATURE_DIR;

export type PaneId = "left" | "right";

export interface PageRenderTiming {
  paperId: string;
  page: number;
  kind: "initial" | "rerender";
  canvasMs: number;
  textMs: number;
  glyphMs: number;
  fixMs: number;
  totalMs: number;
}

export type W = Window & {
  __paperlens: {
    db: {
      files: { put(r: unknown): Promise<unknown> };
      papers: {
        put(r: unknown): Promise<unknown>;
        get(id: string): Promise<{ fileHash: string } | undefined>;
        update(id: string, changes: Record<string, unknown>): Promise<number>;
      };
    };
    useReaderStore: {
      getState(): {
        openPaper(id: string, opts?: { paneId?: PaneId }): void;
        closeTab(paneId: PaneId, id: string): void;
        activateTab(paneId: PaneId, id: string): void;
        toggleSplit(): void;
        jumpTo(t: { paperId: string; page: number; pdfPoint?: [number, number]; annotationId?: string }): void;
        panes: { id: string; tabs: string[]; activePaperId: string | null }[];
      };
    };
    useAppStore: { getState(): { setView(v: string): void } };
  };
  __paperlensPdfDocs: {
    stats(): { loads: number; destroys: number; entries: { paperId: string; fileHash: string; refs: number }[] };
  };
  __paperlensViewer: {
    pageOverlays: unknown[];
    docOverlays: unknown[];
    MARGIN_WIDTH: number;
    textGeometry: Record<string, (...args: never[]) => unknown>;
    pageCacheStats(): { displayed: number; released: number };
  };
  __paperlensPerf?: PageRenderTiming[];
  __jumped?: unknown[];
  /** 测试用覆盖层记录的最新 PageLayerContext：__ctx[paneId][pageNumber] */
  __ctx?: Record<string, Record<number, unknown>>;
};

export async function boot(page: Page) {
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("console", (msg) => {
    const debug = process.env.PAPERLENS_DEBUG;
    if (msg.type() === "error" || debug === "all" || (debug && /^\[(viewer|pdfDocs)\]/.test(msg.text())))
      console.log(`[console.${msg.type()}]`, msg.text());
  });
  await page.goto("/");
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    return !!w.__paperlens && !!w.__paperlensPdfDocs && !!w.__paperlensViewer;
  });
}

export const fileHashOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 把 PDF 写进 db.papers / db.files，返回 paperId */
export async function addPaper(page: Page, bytes: Buffer, id: string, title: string) {
  const hash = fileHashOf(bytes);
  await page.evaluate(
    async ({ b64, hash, id, title }) => {
      const { db } = (window as unknown as W).__paperlens;
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await db.files.put({ hash, blob: new Blob([bin], { type: "application/pdf" }), size: bin.length });
      await db.papers.put({ id, fileHash: hash, title, authors: [], domainIds: [], pageCount: 0, addedAt: Date.now() });
    },
    { b64: bytes.toString("base64"), hash, id, title },
  );
  return id;
}

export const fixtureBytes = (file: string) => readFileSync(join(FIXTURES, file));
export const addFixture = (page: Page, file: string, title = file) => addPaper(page, fixtureBytes(file), `fx-${file}`, title);

export const store = (page: Page) => ({
  open: (id: string, paneId?: PaneId) =>
    page.evaluate(
      ([id, paneId]) =>
        (window as unknown as W).__paperlens.useReaderStore.getState().openPaper(id!, paneId ? { paneId: paneId as PaneId } : undefined),
      [id, paneId],
    ),
  jump: (t: { paperId: string; page: number; pdfPoint?: [number, number] }) =>
    page.evaluate((t) => (window as unknown as W).__paperlens.useReaderStore.getState().jumpTo(t), t),
  toggleSplit: () => page.evaluate(() => (window as unknown as W).__paperlens.useReaderStore.getState().toggleSplit()),
  close: (paneId: PaneId, id: string) =>
    page.evaluate(([p, id]) => (window as unknown as W).__paperlens.useReaderStore.getState().closeTab(p as PaneId, id), [paneId, id]),
  activate: (paneId: PaneId, id: string) =>
    page.evaluate(([p, id]) => (window as unknown as W).__paperlens.useReaderStore.getState().activateTab(p as PaneId, id), [paneId, id]),
});

export const pdfStats = (page: Page) => page.evaluate(() => (window as unknown as W).__paperlensPdfDocs.stats());

export const pane = (page: Page, id: PaneId = "left") => page.locator(`[data-pane="${id}"]`);
export const pageEl = (page: Page, n: number, paneId: PaneId = "left") =>
  pane(page, paneId).locator(`.pl-page[data-page-number="${n}"]`);

/** 等某页 canvas 渲染完、文本层出现 */
export async function waitRendered(page: Page, n: number, paneId: PaneId = "left") {
  const el = pageEl(page, n, paneId);
  await expect(el.locator("canvas")).toHaveCount(1, { timeout: 20_000 });
  await expect(el.locator(".textLayer span").first()).toBeAttached({ timeout: 20_000 });
}

export const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `viewer-${name}.png`) });
};

/** 注册一个测试用页面覆盖层，把每页最新的 ctx 记到 window.__ctx（须在打开论文前调用） */
export async function installCtxProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__ctx = {};
    w.__paperlensViewer.pageOverlays.push({
      key: "test-ctx-probe",
      slot: "over-text",
      Component: ({ ctx }: { ctx: { paneId: string; pageNumber: number } }) => {
        ((w.__ctx![ctx.paneId] ??= {}) as Record<number, unknown>)[ctx.pageNumber] = ctx;
        return null;
      },
    });
  });
}

/** 等到该页的 ctx.text.charBoxes 就绪（字形映射完成并已做词级校正） */
export async function waitGlyphs(page: Page, n: number, paneId: PaneId = "left") {
  await waitRendered(page, n, paneId);
  await page.waitForFunction(
    ([paneId, n]) => {
      const ctx = (window as unknown as W).__ctx?.[paneId as string]?.[n as number] as { text?: { charBoxes: unknown } } | undefined;
      return !!ctx?.text?.charBoxes;
    },
    [paneId, n] as const,
    { timeout: 20_000 },
  );
}

export interface WordErr {
  word: string;
  /** 词框左右边缘与墨迹边缘的距离（em） */
  glyphL: number;
  glyphR: number;
  /** 词级校正后文本层 DOM Range 的误差（em）；片段不在 DOM 中时为 null */
  domL: number | null;
  domR: number | null;
  /** 真值（墨迹）在 PDF 坐标下沿基线方向的范围，以及基线中部的点，用于拖选测试 */
  truth: { left: [number, number]; right: [number, number] };
  rotated: boolean;
}

/**
 * 以 canvas 墨迹为真值测量词框误差（在浏览器中执行，须自包含）。
 * 对每个片段：在基线 −0.02 至 +0.75 em 的带内（含衬线，不含上下行）沿基线逐像素判断有无墨迹，
 * 用"最大的 N−1 个空隙"把墨迹切成 N 段（N = 片段里以空白分隔的词数），
 * 第 N−1 大空隙不够明显（< 0.1 em 或 < 第 N 大的 1.5 倍）时跳过该片段。
 * 片段的起止取 pdf.js textContent 的 transform/width（与被测的字形映射无关）。
 */
export function measureWordsInBrowser(args: { paneId: string; pageNumber: number }) {
  type Ctx = {
    viewport: {
      scale: number;
      width: number;
      rotation: number;
      convertToViewportPoint(x: number, y: number): number[];
      convertToPdfPoint(x: number, y: number): number[];
    };
    pageEl: HTMLElement;
    text: {
      items: { str: string; transform: number[]; width: number }[];
      divs: HTMLElement[];
      charBoxes: Float32Array[] | null;
    };
  };
  type TG = {
    itemRangeToTextRange(ctx: Ctx, item: number, s: number, e: number): { start: number; end: number } | null;
    textRangeToPdfRects(ctx: Ctx, start: number, end: number): number[][];
  };
  const w = window as unknown as { __ctx: Record<string, Record<number, Ctx>>; __paperlensViewer: { textGeometry: TG } };
  const ctx = w.__ctx[args.paneId][args.pageNumber];
  const tg = w.__paperlensViewer.textGeometry;
  const vp = ctx.viewport;
  const canvas = ctx.pageEl.querySelector("canvas")!;
  const W = canvas.width;
  const H = canvas.height;
  const data = canvas.getContext("2d")!.getImageData(0, 0, W, H).data;
  const ppx = W / vp.width;
  const dark = (px: number, py: number) => {
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const o = (y * W + x) * 4;
    return data[o] * 0.3 + data[o + 1] * 0.59 + data[o + 2] * 0.11 < 140;
  };
  const pageRect = ctx.pageEl.getBoundingClientRect();
  const words: WordErr[] = [];
  let skipped = 0;
  ctx.text.items.forEach((it, i) => {
    const str = it.str;
    if (!str.trim()) return;
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]);
    const len0 = Math.hypot(t[0], t[1]);
    if (!(size > 0) || !(len0 > 0)) return;
    const [dx, dy, ux, uy, ox, oy] = [t[0] / len0, t[1] / len0, t[2] / size, t[3] / size, t[4], t[5]];
    const tokens = [...str.matchAll(/\S+/g)].map((m) => ({ s: m.index!, e: m.index! + m[0].length, w: m[0] }));
    const N = tokens.length;
    const sMin = -0.15 * size;
    const sMax = it.width + (/\s$/.test(str) ? -0.1 * size : 0.15 * size);
    const step = 1 / (vp.scale * ppx);
    const ink: boolean[] = [];
    for (let s = sMin; s <= sMax; s += step) {
      let any = false;
      for (let u = -0.02 * size; u <= 0.75 * size && !any; u += step) {
        const [vx, vy] = vp.convertToViewportPoint(ox + dx * s + ux * u, oy + dy * s + uy * u);
        any = dark(vx * ppx, vy * ppx);
      }
      ink.push(any);
    }
    const runs: [number, number][] = [];
    for (let k = 0; k < ink.length; k++) {
      if (!ink[k]) continue;
      let e = k;
      while (e + 1 < ink.length && ink[e + 1]) e++;
      runs.push([k, e]);
      k = e;
    }
    if (runs.length < N) {
      skipped += N;
      return;
    }
    const gaps = runs.slice(1).map((r, j) => ({ j, size: r[0] - runs[j][1] - 1 }));
    const sorted = [...gaps].sort((a, b) => b.size - a.size);
    if (N > 1) {
      const kth = sorted[N - 2].size * step;
      const next = (sorted[N - 1]?.size ?? 0) * step;
      if (kth < 0.1 * size || kth < 1.5 * next) {
        skipped += N;
        return;
      }
    }
    const cuts = sorted
      .slice(0, N - 1)
      .map((g) => g.j)
      .sort((a, b) => a - b);
    const segs: [number, number][] = [];
    let from = 0;
    for (const c of [...cuts, runs.length - 1]) {
      segs.push([runs[from][0], runs[c][1]]);
      from = c + 1;
    }
    const proj = (x: number, y: number) => (x - ox) * dx + (y - oy) * dy;
    const at = (s: number) => [ox + dx * s + ux * 0.35 * size, oy + dy * s + uy * 0.35 * size] as [number, number];
    tokens.forEach((tok, q) => {
      if (!/^[A-Za-z]{3,}$/.test(tok.w)) return;
      const truthL = sMin + segs[q][0] * step;
      const truthR = sMin + (segs[q][1] + 1) * step;
      const tr = tg.itemRangeToTextRange(ctx, i, tok.s, tok.e);
      const rects = tr ? tg.textRangeToPdfRects(ctx, tr.start, tr.end) : [];
      if (rects.length !== 1) {
        skipped++;
        return;
      }
      const [x1, y1, x2, y2] = rects[0];
      const ps = [proj(x1, y1), proj(x2, y1), proj(x1, y2), proj(x2, y2)];
      let domL: number | null = null;
      let domR: number | null = null;
      const div = ctx.text.divs[i];
      if (div?.isConnected) {
        const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
        let acc = 0;
        let a: [Text, number] | null = null;
        let b: [Text, number] | null = null;
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          const L = n.data.length;
          if (!a && tok.s < acc + L) a = [n, tok.s - acc];
          if (!b && tok.e <= acc + L) b = [n, tok.e - acc];
          acc += L;
        }
        if (a && b) {
          const r = document.createRange();
          r.setStart(a[0], a[1]);
          r.setEnd(b[0], b[1]);
          const rr = r.getBoundingClientRect();
          const c = [
            [rr.left, rr.top],
            [rr.right, rr.top],
            [rr.left, rr.bottom],
            [rr.right, rr.bottom],
          ].map(([cx, cy]) => {
            const [px, py] = vp.convertToPdfPoint(cx - pageRect.left, cy - pageRect.top);
            return proj(px, py);
          });
          domL = Math.abs(Math.min(...c) - truthL) / size;
          domR = Math.abs(Math.max(...c) - truthR) / size;
        }
      }
      words.push({
        word: tok.w,
        glyphL: Math.abs(Math.min(...ps) - truthL) / size,
        glyphR: Math.abs(Math.max(...ps) - truthR) / size,
        domL,
        domR,
        truth: { left: at(truthL + 0.04 * size), right: at(truthR - 0.04 * size) },
        rotated: vp.rotation % 360 !== 0,
      });
    });
  });
  return { words, skipped };
}

export function summarize(values: number[]) {
  const xs = [...values].sort((a, b) => a - b);
  const q = (r: number) => xs[Math.min(xs.length - 1, Math.floor(r * xs.length))] ?? NaN;
  return { n: xs.length, median: q(0.5), p95: q(0.95), max: xs.at(-1) ?? NaN, over025: xs.filter((x) => x > 0.25).length / (xs.length || 1) };
}

export const fmt = (s: ReturnType<typeof summarize>) =>
  `n=${s.n} 中位 ${s.median.toFixed(3)} / p95 ${s.p95.toFixed(3)} / 最大 ${s.max.toFixed(3)} em，>0.25em ${(s.over025 * 100).toFixed(1)}%`;

export interface DragResult {
  total: number;
  /** 浏览器原生选区恰好是该词 */
  native: number;
  /** refineRangeByPointer 校正后恰好是该词 */
  refined: number;
  /** 原生选区为空 */
  empty: number;
  /** 原生选区为空时，textRangeFromPointer 兜底恰好得到该词 */
  recovered: number;
  misses: string[];
}

/**
 * 紧贴字母拖选（按下点 = 词首墨迹往里 0.04 em，抬起点 = 词尾墨迹往里 0.04 em），
 * 比较原生选区与 refineRangeByPointer 的结果。reverse 时从右往左拖。
 */
export async function dragWords(
  page: import("@playwright/test").Page,
  pageNumber: number,
  words: WordErr[],
  opts: { steps?: number; reverse?: boolean } = {},
): Promise<DragResult> {
  const res: DragResult = { total: 0, native: 0, refined: 0, empty: 0, recovered: 0, misses: [] };
  for (const w of words) {
    const pts = await page.evaluate(
      ({ left, right, n }) => {
        const ctx = (window as unknown as W).__ctx!.left[n] as {
          pageEl: HTMLElement;
          viewport: { convertToViewportPoint(x: number, y: number): number[] };
        };
        const c = (p: [number, number]) => {
          const r = ctx.pageEl.getBoundingClientRect();
          const [x, y] = ctx.viewport.convertToViewportPoint(p[0], p[1]);
          return { x: r.left + x, y: r.top + y };
        };
        // 先把这个词滚到分栏中部（视口外的坐标无法拖选）
        const scroll = ctx.pageEl.closest<HTMLElement>("[data-viewer-scroll]")!;
        const box = scroll.getBoundingClientRect();
        const a = c(left);
        scroll.scrollTop += a.y - (box.top + box.height / 2);
        const b2 = c(right);
        if (b2.x > box.right - 20 || a.x < box.left + 20) scroll.scrollLeft += (a.x + b2.x) / 2 - (box.left + box.width / 2);
        return [c(left), c(right)];
      },
      { ...w.truth, n: pageNumber },
    );
    const [a, b] = opts.reverse ? [pts[1], pts[0]] : pts;
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: opts.steps ?? 12 });
    await page.mouse.up();
    const got = await page.evaluate(
      ({ a, b, n }) => {
        const sel = window.getSelection()!;
        const ctx = (window as unknown as W).__ctx!.left[n] as { text: { normalized: { text: string } } };
        const tg = (window as unknown as W).__paperlensViewer.textGeometry as unknown as {
          domRangeToTextRange(ctx: unknown, r: Range): { start: number; end: number } | null;
          refineRangeByPointer(
            ctx: unknown,
            r: { start: number; end: number },
            d: { clientX: number; clientY: number },
            u: { clientX: number; clientY: number },
          ): { start: number; end: number };
          textRangeFromPointer(
            ctx: unknown,
            d: { clientX: number; clientY: number },
            u: { clientX: number; clientY: number },
          ): { start: number; end: number } | null;
        };
        const r = sel.rangeCount ? tg.domRangeToTextRange(ctx, sel.getRangeAt(0)) : null;
        const t = ctx.text.normalized.text;
        const d = { clientX: a.x, clientY: a.y };
        const u = { clientX: b.x, clientY: b.y };
        const refined = r ? tg.refineRangeByPointer(ctx, r, d, u) : null;
        const fb = r ? null : tg.textRangeFromPointer(ctx, d, u);
        return {
          native: r ? t.slice(r.start, r.end) : "",
          refined: refined ? t.slice(refined.start, refined.end) : "",
          fallback: fb ? t.slice(fb.start, fb.end) : "",
        };
      },
      { a, b, n: pageNumber },
    );
    res.total++;
    if (!got.native) {
      res.empty++;
      if (got.fallback === w.word) res.recovered++;
      else res.misses.push(`${w.word}→（空）/兜底 ${got.fallback || "（空）"}`);
      continue;
    }
    if (got.native === w.word) res.native++;
    if (got.refined === w.word) res.refined++;
    if (got.native !== w.word || got.refined !== w.word) res.misses.push(`${w.word}→${got.native}/${got.refined}`);
  }
  return res;
}

/**
 * 跨行高亮两段矩形的纵向重叠（em）：对相邻两行（同栏、基线相差 0.8–2.5 倍字号），
 * 取上一行最后一个词到下一行第一个词的区间，量 textRangeToPdfRects 两段矩形的重叠高度。
 */
export function crossLineOverlapInBrowser(args: { paneId: string; pageNumber: number }) {
  type Ctx = { text: { items: { str: string; transform: number[]; width: number }[] } };
  const w = window as unknown as {
    __ctx: Record<string, Record<number, Ctx>>;
    __paperlensViewer: { textGeometry: { itemRangeToTextRange: Function; textRangeToPdfRects: Function } };
  };
  const ctx = w.__ctx[args.paneId][args.pageNumber];
  const tg = w.__paperlensViewer.textGeometry;
  const items = ctx.text.items;
  const out: number[] = [];
  for (let i = 0; i + 1 < items.length; i++) {
    const a = items[i];
    const b = items[i + 1];
    const ta = a.transform;
    const tb = b.transform;
    if (Math.abs(ta[1]) > 1e-3 || Math.abs(tb[1]) > 1e-3 || ta[0] <= 0 || tb[0] <= 0) continue;
    const size = Math.hypot(ta[2], ta[3]);
    const dy = ta[5] - tb[5];
    if (!(dy > 0.8 * size && dy < 2.5 * size)) continue;
    if (Math.abs(Math.hypot(tb[2], tb[3]) - size) > 0.1 * size) continue;
    const la = [...a.str.matchAll(/\S+/g)].at(-1);
    const fb = [...b.str.matchAll(/\S+/g)][0];
    if (!la || !fb) continue;
    const s = tg.itemRangeToTextRange(ctx, i, la.index!, la.index! + la[0].length) as { start: number } | null;
    const e = tg.itemRangeToTextRange(ctx, i + 1, fb.index!, fb.index! + fb[0].length) as { end: number } | null;
    if (!s || !e) continue;
    const rects = tg.textRangeToPdfRects(ctx, s.start, e.end) as number[][];
    if (rects.length !== 2) continue;
    out.push((rects[1][3] - rects[0][1]) / size);
  }
  return out;
}
