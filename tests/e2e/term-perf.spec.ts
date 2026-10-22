/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 术语下划线性能（开发文档非功能需求：单页渲染 + 术语标注 200 ms 内；术语 2000 条、论文 50 页不卡顿）
// 与真实论文截图。
// npx playwright test -c tests/e2e/term.config.ts term-perf
// 真实论文：PAPERLENS_LITERATURE_DIR=<你的论文目录>（只读，PDF 只写进测试浏览器的临时 IndexedDB）
// 截图：PAPERLENS_SHOTS_DIR=<目录>，输出 term-*.png
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { LIT, SHOTS, realPaper, addFixture, addPaper, boot, installCtxProbe, store, waitGlyphs } from "./viewerHelpers";

interface TermPerf {
  paperId: string;
  page: number;
  kind: string;
  matches: number;
  shown: number;
  segments: number;
  matchMs: number;
  rectMs: number;
  totalMs: number;
  glyphs: boolean;
  terms: number;
}
interface RenderPerf {
  paperId: string;
  page: number;
  kind: string;
  totalMs: number;
}

// 真实术语 + 常见学术词（制造密集下划线的最坏情况）+ 随机伪词（大部分不命中，测自动机规模）
const REAL = [
  { id: "r-lstm", name: "Long Short-Term Memory", aliases: ["LSTM", "LSTMs"], note: "带输入门、遗忘门、输出门的循环网络，缓解长程依赖中的梯度消失。" },
  { id: "r-tf", name: "Transformer", aliases: [], note: "完全基于自注意力的编码器-解码器结构（Vaswani et al., 2017）。" },
  { id: "r-atm", name: "Air Traffic Management", aliases: ["ATM"], note: "空中交通管理：空域管理、流量管理与空中交通服务的总称。" },
  { id: "r-tp", name: "trajectory prediction", aliases: ["TP"], note: "根据历史航迹与意图预测未来 4D 位置。" },
  { id: "r-attn", name: "self-attention", aliases: [], note: "序列内部两两位置的注意力。" },
  { id: "r-ts", name: "time series", aliases: [], note: "" },
  { id: "r-patch", name: "patch", aliases: ["patching"], note: "把时间序列切成子序列作为 token。" },
  { id: "r-ci", name: "channel-independence", aliases: ["channel independence"], note: "" },
  { id: "r-ads", name: "ADS-B", aliases: [], note: "广播式自动相关监视。" },
  { id: "r-rnn", name: "recurrent neural network", aliases: ["RNN", "RNNs"], note: "" },
  { id: "r-mse", name: "mean squared error", aliases: ["MSE"], note: "" },
  { id: "r-mae", name: "mean absolute error", aliases: ["MAE"], note: "" },
];
const COMMON = (
  "model data prediction network layer training sequence attention encoder decoder forecasting input output " +
  "loss performance dataset feature representation baseline experiment parameter accuracy error horizon window " +
  "embedding token aircraft flight altitude speed position airspace weather controller state gate memory length " +
  "benchmark method approach result table figure section learning neural deep linear optimization validation test"
).split(" ");

function makeTerms(n: number) {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const syl = ["ka", "zu", "mir", "tel", "von", "qua", "bri", "dex", "lor", "pha", "sen", "tro", "gu", "xi", "om", "ret"];
  const word = () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => syl[Math.floor(rnd() * syl.length)]).join("");
  const now = Date.now();
  const terms: Record<string, unknown>[] = REAL.map((t) => ({ ...t, matchMode: "auto", scope: { kind: "global" }, createdAt: now, updatedAt: now }));
  COMMON.forEach((w, i) => terms.push({ id: `c-${i}`, name: w, aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: now, updatedAt: now }));
  for (let i = terms.length; i < n; i++) {
    const words = Array.from({ length: 1 + Math.floor(rnd() * 3) }, word).join(" ");
    const acr = rnd() < 0.3 ? [words.split(" ").map((w) => w[0].toUpperCase()).join("") + "X" + i] : [];
    terms.push({ id: `g-${i}`, name: words, aliases: acr, matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: now, updatedAt: now });
  }
  return terms;
}

async function seed(page: Page, terms: Record<string, unknown>[]) {
  await page.evaluate((terms) => (window as unknown as { __paperlens: { db: { terms: { bulkPut(r: unknown[]): Promise<unknown> } } } }).__paperlens.db.terms.bulkPut(terms), terms);
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (r: number) => s[Math.min(s.length - 1, Math.floor(r * s.length))] ?? NaN;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1) ?? NaN };
};
const f = (x: number) => x.toFixed(1);
const fmt = (s: ReturnType<typeof stats>) => `n=${s.n} 中位 ${f(s.p50)} / p95 ${f(s.p95)} / 最大 ${f(s.max)} ms`;

/** 每帧把滚动容器往下推 px 像素，记录帧间隔；同时记录长任务 */
async function scrollThrough(page: Page, px: number, maxFrames: number) {
  return page.evaluate(
    async ({ px, maxFrames }) => {
      const el = document.querySelector<HTMLElement>('[data-pane="left"] [data-viewer-scroll]')!;
      el.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 300));
      const longTasks: number[] = [];
      const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration)));
      try {
        po.observe({ type: "longtask", buffered: false });
      } catch {
        /* 不支持时忽略 */
      }
      const dts: number[] = [];
      let last = performance.now();
      for (let i = 0; i < maxFrames; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        dts.push(now - last);
        last = now;
        el.scrollTop += px;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) break;
      }
      await new Promise((r) => setTimeout(r, 500));
      po.disconnect();
      return { dts: dts.slice(1), longTasks, pages: Math.round(el.scrollHeight / el.clientHeight) };
    },
    { px, maxFrames },
  );
}

async function clearPerf(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __paperlensTermPerf?: unknown[]; __paperlensPerf?: unknown[] };
    w.__paperlensTermPerf = [];
    w.__paperlensPerf = [];
  });
}
async function readPerf(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __paperlensTermPerf?: TermPerf[]; __paperlensPerf?: RenderPerf[] };
    return { term: w.__paperlensTermPerf ?? [], render: w.__paperlensPerf ?? [] };
  });
}

async function measurePaper(page: Page, paperId: string, label: string) {
  await clearPerf(page);
  await store(page).open(paperId);
  await waitGlyphs(page, 1);
  await expect.poll(async () => (await readPerf(page)).term.some((t) => t.page === 1), { timeout: 20_000 }).toBe(true);
  const run = await scrollThrough(page, 60, 3000);
  const { term, render } = await readPerf(page);
  const initial = term.filter((t) => t.kind === "initial" && t.paperId === paperId);
  const firstRender = new Map<number, number>();
  for (const r of render) if (r.paperId === paperId && r.kind === "initial" && !firstRender.has(r.page)) firstRender.set(r.page, r.totalMs);
  const combined = initial.filter((t) => firstRender.has(t.page)).map((t) => firstRender.get(t.page)! + t.totalMs);
  // 单页匹配本身远小于计时器精度（0.1 ms），在仍在渲染范围内的页上重复 50 次取平均
  const matchEach = await page.evaluate(() => {
    const w = window as unknown as {
      __ctx: Record<string, Record<number, { text: { normalized: unknown } | null }>>;
      __paperlensTerm: { getTermRuntime(): { matcher: { match(nt: unknown): unknown[] } } };
    };
    const m = w.__paperlensTerm.getTermRuntime().matcher;
    const out: number[] = [];
    for (const ctx of Object.values(w.__ctx.left ?? {})) {
      if (!ctx.text) continue;
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) m.match(ctx.text.normalized);
      out.push((performance.now() - t0) / 50);
    }
    return out;
  });
  const frames = stats(run.dts);
  const jank = run.dts.filter((d) => d > 50).length;
  const out = {
    pages: new Set(initial.map((t) => t.page)).size,
    terms: initial[0]?.terms ?? 0,
    matches: stats(initial.map((t) => t.matches)),
    segments: stats(initial.map((t) => t.segments)),
    match: stats(matchEach),
    rect: stats(initial.map((t) => t.rectMs)),
    total: stats(initial.map((t) => t.totalMs)),
    renderPlusTerm: stats(combined),
    frames,
    jank,
    longTasks: stats(run.longTasks),
    glyphs: initial.every((t) => t.glyphs),
  };
  console.log(
    `[term-perf] ${label}：${out.pages} 页，${out.terms} 条术语，每页命中 中位 ${out.matches.p50} / 最大 ${out.matches.max}，下划线段 最大 ${out.segments.max}\n` +
      `  每页匹配（重复 50 次平均，${out.match.n} 页） 中位 ${out.match.p50.toFixed(3)} / 最大 ${out.match.max.toFixed(3)} ms\n  每页定位 ${fmt(out.rect)}\n  每页匹配+定位+写入 DOM ${fmt(out.total)}\n` +
      `  单页渲染（canvas+文本层+字形映射）+ 术语标注 ${fmt(out.renderPlusTerm)}\n` +
      `  滚动帧间隔 ${fmt(out.frames)}，>50 ms 的帧 ${jank} 个；长任务 ${fmt(out.longTasks)}；全部用字形映射：${out.glyphs}`,
  );
  return out;
}

test.describe.configure({ mode: "serial" });

/** 重新加载页面（IndexedDB 保留），清掉文档、字形映射等内存缓存，让每轮测量从冷启动开始 */
async function reload(page: Page) {
  await page.reload();
  await page.waitForFunction(() => {
    const w = window as unknown as Record<string, unknown>;
    return !!w.__paperlens && !!w.__paperlensViewer && !!w.__paperlensTerm;
  });
  await installCtxProbe(page);
}

async function waitTermCount(page: Page, n: number) {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __paperlensTerm: { getTermRuntime(): { matcher: { terms: unknown[] } } } }).__paperlensTerm.getTermRuntime().matcher.terms.length), { timeout: 20_000 })
    .toBe(n);
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await installCtxProbe(page);
});

test("2000 条术语 × 50 页（fixtures/long.pdf）：每页匹配与绘制耗时、滚动帧间隔", async ({ page }) => {
  test.setTimeout(180_000);
  const id = await addFixture(page, "long.pdf");
  // 基线：没有术语
  const base = await measurePaper(page, id, "long.pdf 无术语（基线）");

  await seed(page, makeTerms(2000));
  await reload(page);
  await waitTermCount(page, 2000);
  const buildMs = await page.evaluate(() => (window as unknown as { __paperlensTerm: { getTermRuntime(): { buildMs: number } } }).__paperlensTerm.getTermRuntime().buildMs);
  console.log(`[term-perf] 主线程匹配器重建（2000 条）${buildMs.toFixed(1)} ms`);
  const r = await measurePaper(page, id, "long.pdf 2000 条术语");
  expect(r.pages).toBeGreaterThanOrEqual(45);
  expect(r.total.p95).toBeLessThan(30);
  expect(r.renderPlusTerm.p95).toBeLessThan(200);
  // 与基线相比不明显变卡
  expect(r.frames.p95).toBeLessThan(Math.max(base.frames.p95 * 1.5, 40));
});

const REAL_PAPERS = [
  ["patchtst", "PatchTST"],
  ["lstm", "LSTM"],
] as const;

test("真实论文：2000 条术语的耗时 + 截图", async ({ page }) => {
  test.skip(!LIT, "未设置 PAPERLENS_LITERATURE_DIR");
  test.setTimeout(240_000);
  const files = REAL_PAPERS.flatMap(([key, title]) => {
    const path = realPaper(key);
    return path ? [{ path, title }] : [];
  });
  expect(files.length).toBeGreaterThan(0);
  const ids: string[] = [];
  for (const [i, f2] of files.entries()) ids.push(await addPaper(page, readFileSync(f2.path), `lit-${i}`, f2.title));
  // 基线：没有术语
  for (const [i, f2] of files.entries()) {
    await reload(page);
    await measurePaper(page, ids[i], `${f2.title} 无术语（基线）`);
  }
  await seed(page, makeTerms(2000));
  // 第二个 ATM 用于展示多候选
  await page.evaluate(() =>
    (window as unknown as { __paperlens: { db: { terms: { put(r: unknown): Promise<unknown> } } } }).__paperlens.db.terms.put({
      id: "r-atm2",
      name: "Asynchronous Transfer Mode",
      aliases: ["ATM"],
      matchMode: "auto",
      scope: { kind: "global" },
      note: "网络协议，与空管无关。",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  for (const [i, f2] of files.entries()) {
    await reload(page);
    await waitTermCount(page, 2001);
    const r = await measurePaper(page, ids[i], `${f2.title} 2000 条术语`);
    expect(r.total.p95).toBeLessThan(30);
  }

  if (!SHOTS) return;
  // 截图用较少的术语，避免常见词下划线铺满页面
  await page.evaluate(async () => {
    const db = (window as unknown as { __paperlens: { db: { terms: { toCollection(): { primaryKeys(): Promise<string[]> }; bulkDelete(k: string[]): Promise<unknown> } } } }).__paperlens.db;
    const keys = await db.terms.toCollection().primaryKeys();
    await db.terms.bulkDelete(keys.filter((k) => !k.startsWith("r-")));
  });
  const lstmPaper = ids[files.findIndex((x) => x.title === "LSTM")] ?? ids[0];
  await reload(page);
  await store(page).open(lstmPaper);
  await waitGlyphs(page, 1);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SHOTS, "term-underlines.png") });

  // 点击第一处 LSTM 打开弹窗
  const ul = page.locator('[data-pane="left"] .pl-page[data-page-number="1"] [data-term-ul][data-term-ids="r-lstm"]').first();
  await ul.waitFor({ state: "attached", timeout: 10_000 });
  const b = (await ul.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(page.locator("[data-term-popover]")).toBeVisible();
  await expect(page.locator("[data-term-nav-label]")).toHaveText(/本文第/, { timeout: 20_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, "term-popover.png") });
  await page.keyboard.press("Escape");

  // 多候选：ATM
  const atm = page.locator('[data-pane="left"] [data-term-ul][data-multi]').first();
  if (await atm.count()) {
    await atm.scrollIntoViewIfNeeded();
    const a = (await atm.boundingBox())!;
    await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
    await expect(page.locator("[data-term-candidates]")).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, "term-candidates.png") });
  }
});
