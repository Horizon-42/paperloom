/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 术语后台性能：2000 条术语 × 100 篇论文 × 20 页（生成的全文，不需要真实 PDF）。
// 测全库扫描耗时（Worker 内）与扫描期间主线程的长任务；术语表视图保持打开。
// 单独运行：npx playwright test -c tests/e2e/glossary.config.ts glossary-perf
import { expect, test, type Page } from "@playwright/test";
import { bootGlossary, waitIndexed } from "./glossaryHelpers";

const N_TERMS = 2000;
const N_PAPERS = 100;
const PAGES = 20;

interface LongTask {
  start: number;
  duration: number;
}

/** 生成论文、全文与术语（固定种子）。术语先不写入，返回给后续步骤。topic：每篇论文用到的术语数；rate：正文中术语的比例 */
async function generate(page: Page, opts: { topic: number; rate: number } = { topic: 300, rate: 0.03 }) {
  return page.evaluate(
    async ({ N_TERMS, N_PAPERS, PAGES, topicSize, rate }) => {
      const w = window as any;
      const db = w.__paperlens.db;
      const EV = w.__paperlensGlossary.NORMALIZE_VERSION;
      let seed = 20261020;
      const rnd = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
      const syl = ["ka", "lo", "mi", "ne", "ru", "ta", "vo", "shi", "ex", "an", "pr", "ol", "ty", "ber", "con", "tion", "al", "ic", "ing", "er", "de", "sa", "pu", "gor"];
      const word = () => {
        let s = "";
        const n = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) s += pick(syl);
        return s;
      };
      const vocab = Array.from({ length: 5000 }, word);
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const acr = (i: number) => "Q" + letters[i % 26] + letters[Math.floor(i / 26) % 26] + letters[Math.floor(i / 676) % 26];

      const domainIds = ["d0", "d1", "d2", "d3", "d4"];
      await db.domains.bulkPut(domainIds.map((id, i) => ({ id, name: `领域 ${i}`, parentId: i === 4 ? "d0" : null, color: "#3b82f6", order: i })));

      const now = Date.now();
      const terms = Array.from({ length: N_TERMS }, (_, i) => {
        const r = rnd();
        const base = `${word()}x${i.toString(36)}`;
        const name = r < 0.4 ? base : `${word()} ${base}${r < 0.6 ? " " + word() : ""}`;
        const aliases = rnd() < 0.5 ? [acr(i)] : [];
        const scope = rnd() < 0.3 ? { kind: "domains", domainIds: [pick(domainIds)] } : { kind: "global" };
        return { id: `t${i}`, name, aliases, matchMode: "auto", scope, note: `术语 ${i} 的笔记：${word()} ${word()} ${word()}`, createdAt: now, updatedAt: now - i * 1000 };
      });

      // 每篇论文从 300 个术语里取，正文约 3% 的位置是术语
      let pageRows: unknown[] = [];
      let chars = 0;
      const papers: unknown[] = [];
      for (let p = 0; p < N_PAPERS; p++) {
        const topic = Array.from({ length: topicSize }, () => pick(terms));
        const forms = (t: (typeof terms)[number]) => [t.name, ...t.aliases];
        const id = `perf-${p}`;
        const fileHash = `perf-hash-${p}`;
        for (let n = 1; n <= PAGES; n++) {
          const out: string[] = [];
          for (let k = 0; k < 650; k++) {
            out.push(rnd() < rate ? pick(forms(pick(topic))) : pick(vocab));
            if (k % 13 === 12) out[out.length - 1] += ".";
            if (k % 90 === 89) out.push("\n");
          }
          const text = out.join(" ").replace(/ \n /g, "\n");
          chars += text.length;
          pageRows.push({ paperId: id, page: n, text, fileHash, engineVersion: EV });
        }
        papers.push({ id, fileHash, title: `Generated paper ${p}`, authors: [], domainIds: [pick(domainIds)], pageCount: PAGES, addedAt: now - p });
        if (pageRows.length >= 200) {
          await db.pageTexts.bulkPut(pageRows);
          pageRows = [];
        }
      }
      if (pageRows.length) await db.pageTexts.bulkPut(pageRows);
      await db.papers.bulkPut(papers);
      (w as any).__perfTerms = terms;
      return { chars };
    },
    { N_TERMS, N_PAPERS, PAGES, topicSize: opts.topic, rate: opts.rate },
  );
}

async function startLongTaskObserver(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__longTasks = [];
    w.__ltObserver?.disconnect();
    w.__ltObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push({ start: e.startTime, duration: e.duration });
    });
    w.__ltObserver.observe({ type: "longtask" });
    // 长动画帧带脚本归因，用于定位长任务来源
    w.__loaf = [];
    w.__loafObserver?.disconnect();
    w.__loafObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (e.duration < 50) continue;
        w.__loaf.push({
          start: Math.round(e.startTime),
          duration: Math.round(e.duration),
          blocking: Math.round(e.blockingDuration),
          render: Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0),
          scripts: (e.scripts ?? []).map((x: any) => `${x.invoker || x.invokerType}@${(x.sourceURL || "").split("/").pop()}:${Math.round(x.duration)}ms`).slice(0, 4),
        });
      }
    });
    w.__loafObserver.observe({ type: "long-animation-frame" });
  });
}

const takeLoaf = (page: Page) =>
  page.evaluate(() => {
    const w = window as any;
    const xs = w.__loaf;
    w.__loaf = [];
    return xs as unknown[];
  });

const takeLongTasks = (page: Page): Promise<LongTask[]> =>
  page.evaluate(() => {
    const w = window as any;
    const xs = w.__longTasks as LongTask[];
    w.__longTasks = [];
    return xs;
  });

const lastRun = (page: Page) => page.evaluate(() => (window as any).__paperlensGlossary.useIndexerStore.getState().lastRun);

/** 写入后到索引空闲的墙钟时间。action 在页面里执行写入，返回写入完成时的 performance.now() */
async function timeUntilIndexed(page: Page, action: () => Promise<number>) {
  const t0 = await page.evaluate(() => performance.now());
  const writeDone = await action();
  await waitIndexed(page, 120_000);
  // waitIndexed 末尾有 700 ms 的稳定等待，用 lastRun.at 反推实际完成时间
  const end = await page.evaluate(() => {
    const at = (window as any).__paperlensGlossary.useIndexerStore.getState().lastRun?.at ?? Date.now();
    return performance.now() - (Date.now() - at);
  });
  return { t0, writeDone, wallMs: end - t0 };
}

/** 防抖 400 ms：扫描不可能在写入完成后 350 ms 内开始，之前的长任务属于写入本身（Dexie 处理主线程写入的通知） */
const SCAN_START_GUARD_MS = 350;

const fmtTasks = (xs: LongTask[]) => (xs.length ? xs.map((x) => `${x.duration.toFixed(0)}ms@${x.start.toFixed(0)}`).join(", ") : "无");

test("2000 条术语 × 100 篇 × 20 页：全库扫描耗时与主线程长任务", async ({ page }) => {
  test.setTimeout(300_000);
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") console.log(`[console.${m.type()}]`, m.text());
  });
  await bootGlossary(page);

  // 自检：长任务观察器确实能记录（否则"无长任务"没有意义）。page.evaluate 里直接执行的代码不算任务，要放进 setTimeout
  await startLongTaskObserver(page);
  await page.evaluate(() => {
    setTimeout(() => {
      const t = performance.now();
      while (performance.now() - t < 80);
    }, 0);
  });
  await page.waitForTimeout(200);
  expect((await takeLongTasks(page)).length).toBeGreaterThan(0);

  const gen = await generate(page);
  await waitIndexed(page, 120_000); // 没有术语时的首轮扫描（只写扫描戳）
  await page.evaluate(() => (window as any).__paperlens.useAppStore.getState().setView("glossary"));
  await page.waitForTimeout(500);
  await startLongTaskObserver(page);

  // 1) 写入 2000 条术语 → 全库扫描
  const first = await timeUntilIndexed(page, () =>
    page.evaluate(async () => {
      await (window as any).__paperlens.db.terms.bulkPut((window as any).__perfTerms);
      return performance.now();
    }),
  );
  const run1 = await lastRun(page);
  const lt1all = await takeLongTasks(page);
  const lt1 = lt1all.filter((x) => x.start >= first.writeDone + SCAN_START_GUARD_MS);
  const lt1write = lt1all.filter((x) => x.start < first.writeDone + SCAN_START_GUARD_MS);
  const loaf1 = await takeLoaf(page);
  if (loaf1.length) console.log(`[perf] 长动画帧（≥50ms）：${JSON.stringify(loaf1)}`);
  const occCount = await page.evaluate(() => (window as any).__paperlens.db.occurrences.count());
  console.log(
    `[perf] 全文 ${(gen.chars / 1e6).toFixed(1)}M 字符；全库扫描：Worker 内 ${run1.ms.toFixed(0)} ms（建自动机 ${run1.buildMs.toFixed(0)} ms，匹配 ${run1.matchMs.toFixed(0)} ms），` +
      `${run1.scanned} 篇 / ${run1.pages} 页，occurrences ${occCount} 行（写 ${run1.written}）；写入术语到完成 ${first.wallMs.toFixed(0)} ms`,
  );
  console.log(`[perf] 扫描期间主线程长任务（≥50ms）：${fmtTasks(lt1)}；写入 2000 条术语本身（主线程 bulkPut 后 Dexie 的通知处理）：${fmtTasks(lt1write)}`);
  expect(run1).toMatchObject({ scanned: N_PAPERS, pages: N_PAPERS * PAGES, termCount: N_TERMS });
  expect(await page.evaluate(() => (window as any).__paperlensGlossary.getIndexerDebug().usesWorker), "应在 Worker 中扫描").toBe(true);
  expect(occCount).toBeGreaterThan(5000);
  expect(run1.ms).toBeLessThan(15_000);

  // 术语表在扫描结束后显示统计
  await expect(page.getByTestId("glossary-count")).toHaveText(`${N_TERMS} 个术语`);
  await expect(page.getByRole("listbox", { name: "术语列表" }).getByRole("option").first()).toContainText(/篇 · \d+ 次|未出现/);

  // 2) 改一个术语的别名 → 全库重扫（多数记录不变，不重写）
  await startLongTaskObserver(page);
  const second = await timeUntilIndexed(page, () =>
    page.evaluate(async () => {
      await (window as any).__paperlens.db.terms.update("t7", { aliases: ["QZZZ"], updatedAt: Date.now() });
      return performance.now();
    }),
  );
  const run2 = await lastRun(page);
  const lt2 = await takeLongTasks(page);
  console.log(
    `[perf] 改别名后全库重扫：Worker 内 ${run2.ms.toFixed(0)} ms（建自动机 ${run2.buildMs.toFixed(0)} ms），写 ${run2.written} / 删 ${run2.deleted} 行；墙钟 ${second.wallMs.toFixed(0)} ms；长任务：${fmtTasks(lt2)}`,
  );
  expect(run2.scanned).toBe(N_PAPERS);
  expect(run2.written + run2.deleted).toBeLessThan(N_PAPERS * 2);

  // 3) 重新加载：启动自检全部命中扫描戳
  await page.reload();
  await bootGlossary(page);
  await waitIndexed(page, 60_000);
  const run3 = await lastRun(page);
  console.log(`[perf] 启动自检：${run3.papers} 篇，跳过 ${run3.skipped}，重扫 ${run3.scanned}，Worker 内 ${run3.ms.toFixed(0)} ms`);
  expect(run3).toMatchObject({ scanned: 0, skipped: N_PAPERS });

  // 4) 术语表交互：2000 条下搜索、换排序
  await page.evaluate(() => (window as any).__paperlens.useAppStore.getState().setView("glossary"));
  await expect(page.getByTestId("glossary-count")).toHaveText(`${N_TERMS} 个术语`);
  await page.waitForTimeout(1500);
  await startLongTaskObserver(page);
  const search = page.getByRole("searchbox", { name: "搜索术语" });
  const t0 = Date.now();
  await search.pressSequentially("qab", { delay: 30 });
  await expect(page.getByTestId("glossary-count")).toContainText("/ 2000 个术语");
  await search.fill("");
  await page.getByRole("button", { name: /出现次数/ }).click();
  await page.getByRole("button", { name: /修改时间/ }).click();
  await page.getByRole("listbox", { name: "术语列表" }).evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  await page.waitForTimeout(300);
  const lt4 = await takeLongTasks(page);
  console.log(`[perf] 术语表交互（搜索、排序、滚动，${Date.now() - t0} ms）长任务：${fmtTasks(lt4)}`);

  const all = [...lt1, ...lt2];
  expect(Math.max(0, ...all.map((x) => x.duration)), `扫描期间的长任务：${fmtTasks(all)}`).toBeLessThanOrEqual(50);
});

test("术语统计：约 10 万行 occurrences 时刷新统计的主线程开销（改前读全表 vs 改后读统计记录）", async ({ page }) => {
  test.setTimeout(300_000);
  await bootGlossary(page);
  await generate(page, { topic: 2500, rate: 0.3 });
  await page.evaluate(() => (window as any).__paperlens.db.terms.bulkPut((window as any).__perfTerms));
  await waitIndexed(page, 180_000);
  const run = await lastRun(page);
  const rows: number = await page.evaluate(() => (window as any).__paperlens.db.occurrences.count());
  console.log(`[perf-stats] 稠密数据：${rows} 行 occurrences；全库扫描 Worker 内 ${run.ms.toFixed(0)} ms（写 ${run.written} 行）`);
  expect(rows).toBeGreaterThan(90_000);

  /** 在一个普通任务里执行一次刷新，返回耗时和其间的长任务 */
  const measure = async (kind: "old" | "new") => {
    await startLongTaskObserver(page);
    const ms: number = await page.evaluate(
      (kind) =>
        new Promise<number>((resolve) => {
          setTimeout(async () => {
            const w = window as any;
            const db = w.__paperlens.db;
            const t0 = performance.now();
            if (kind === "old") {
              // 改前：每次读整张 occurrences 表再汇总
              const all = await db.occurrences.toArray();
              const m = new Map<string, [number, number]>();
              for (const o of all) {
                const x = m.get(o.termId) ?? [0, 0];
                x[0]++;
                x[1] += o.count;
                m.set(o.termId, x);
              }
            } else {
              // 改后：读 Worker 维护的统计记录
              const rec = (await db.kv.get("indexer:termStats")).value;
              const m = new Map<string, [number, number]>();
              for (const id in rec.stats) m.set(id, rec.stats[id]);
            }
            resolve(performance.now() - t0);
          }, 0);
        }),
      kind,
    );
    await page.waitForTimeout(200);
    return { ms, longTasks: await takeLongTasks(page) };
  };
  const old: { ms: number; longTasks: LongTask[] }[] = [];
  const now: { ms: number; longTasks: LongTask[] }[] = [];
  for (let i = 0; i < 3; i++) {
    old.push(await measure("old"));
    now.push(await measure("new"));
  }
  const fmt = (xs: { ms: number; longTasks: LongTask[] }[]) =>
    `耗时 ${xs.map((x) => x.ms.toFixed(1)).join(" / ")} ms，长任务 ${xs.map((x) => fmtTasks(x.longTasks)).join(" / ")}`;
  console.log(`[perf-stats] 刷新一次统计——改前（读全表）：${fmt(old)}`);
  console.log(`[perf-stats] 刷新一次统计——改后（读统计记录）：${fmt(now)}`);

  // 改后：术语表打开、按次数排序，全库重扫期间（统计记录随每篇论文的写入更新）主线程的长任务
  await page.evaluate(() => {
    const w = window as any;
    w.__paperlens.useAppStore.getState().setView("glossary");
    w.__paperlensGlossary.useGlossaryStore.getState().setSort({ key: "occurrences", dir: "desc" });
  });
  await page.waitForTimeout(1500);
  await startLongTaskObserver(page);
  const second = await timeUntilIndexed(page, () =>
    page.evaluate(async () => {
      await (window as any).__paperlens.db.terms.update("t3", { aliases: ["QYYY"], name: "renamed term", updatedAt: Date.now() });
      return performance.now();
    }),
  );
  const lt = (await takeLongTasks(page)).filter((x) => x.start >= second.writeDone + SCAN_START_GUARD_MS);
  const run2 = await lastRun(page);
  console.log(`[perf-stats] 术语表打开时全库重扫（${rows} 行）：Worker 内 ${run2.ms.toFixed(0)} ms，主线程长任务：${fmtTasks(lt)}`);
  expect(Math.max(0, ...now.map((x) => x.ms))).toBeLessThan(20);
  expect(Math.max(0, ...lt.map((x) => x.duration)), fmtTasks(lt)).toBeLessThanOrEqual(50);
});
