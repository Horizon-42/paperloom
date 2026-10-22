// 文库性能检查：2000 篇论文（约 40% 带标签）+ 30 个领域。只在 PAPERLENS_PERF=1 时运行（数字受机器影响，不放进常规 e2e）
// 输出：单次 db.papers.update 后的最长 long task、冷启动到列表出现的时间、滚动帧间隔
import { expect, test, type Page } from "@playwright/test";

test.skip(!process.env.PAPERLENS_PERF, "set PAPERLENS_PERF=1 to run");
test.setTimeout(120_000);

const N_PAPERS = 2000;

async function seed(page: Page) {
  await page.evaluate(async (n) => {
    const { db } = (window as any).__paperlens;
    let s = 42;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
    const domains: any[] = [];
    for (let r = 0; r < 6; r++) {
      domains.push({ id: `r${r}`, name: `领域 ${r}`, parentId: null, color: colors[r], order: r });
      for (let c = 0; c < 4; c++) domains.push({ id: `r${r}c${c}`, name: `子领域 ${r}.${c}`, parentId: `r${r}`, color: colors[(r + c) % 6], order: c });
    }
    const words = "trajectory prediction transformer attention aircraft learning model deep neural network flight terminal airspace control reinforcement policy generative diffusion".split(" ");
    // 约 40% 的论文带 1–3 个标签（行高不一，标签行折叠）；按 i 决定，不占用随机序列
    const tagPool = ["待读", "精读", "综述", "方法", "实验", "复现", "Transformer", "强化学习", "long tag name for overflow"];
    const papers: any[] = [];
    for (let i = 0; i < n; i++) {
      const len = 4 + Math.floor(rnd() * 12);
      const title = Array.from({ length: len }, () => words[Math.floor(rnd() * words.length)]).join(" ");
      const domainIds = Array.from({ length: Math.floor(rnd() * 3) }, () => domains[Math.floor(rnd() * domains.length)].id);
      papers.push({
        id: `p${i}`,
        fileHash: `hash${i}`,
        title: `${i} ${title}`,
        authors: Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, k) => `Author${k} Name${i}`),
        year: 1990 + Math.floor(rnd() * 36),
        domainIds: [...new Set(domainIds)],
        pageCount: 10,
        addedAt: 1_700_000_000_000 + i * 1000,
        ...(rnd() < 0.3 ? { lastOpenedAt: 1_700_100_000_000 + i } : {}),
        ...(i % 5 < 2 ? { tags: tagPool.slice(i % 7, i % 7 + 1 + (i % 3)) } : {}),
      });
    }
    await db.transaction("rw", db.domains, db.papers, async () => {
      await db.domains.clear();
      await db.papers.clear();
      await db.domains.bulkAdd(domains);
      await db.papers.bulkAdd(papers);
    });
  }, N_PAPERS);
}

/** 在页面里装 long task 和帧间隔监视器 */
async function startMonitor(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const m = { longTasks: [] as number[], frames: [] as number[], running: true, last: performance.now() };
    w.__mon = m;
    const obs = new PerformanceObserver((list) => list.getEntries().forEach((e) => m.longTasks.push(Math.round(e.duration))));
    obs.observe({ type: "longtask" });
    w.__monObs = obs;
    const loop = (t: number) => {
      m.frames.push(t - m.last);
      m.last = t;
      if (m.running) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function stopMonitor(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    w.__mon.running = false;
    w.__monObs.disconnect();
    const frames: number[] = w.__mon.frames.slice(1);
    const sorted = [...frames].sort((a, b) => a - b);
    return {
      longTasks: w.__mon.longTasks as number[],
      maxLongTask: Math.max(0, ...(w.__mon.longTasks as number[])),
      frames: frames.length,
      maxFrame: Math.round(Math.max(0, ...frames)),
      p95Frame: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      slowFrames: frames.filter((f) => f > 34).length,
    };
  });
}

test("library performance with 2000 papers", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__paperlens?.db);
  await seed(page);
  // 测平铺列表（2000 行都在一个列表里；视图选择会被记住，重新加载后仍是它）
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setView("all"));

  // 冷启动：重新加载页面，记录侧栏挂载和第一行论文出现的时间（相对导航开始）
  await page.addInitScript(() => {
    const w = window as any;
    w.__boot = { sidebar: 0, firstRow: 0 };
    new MutationObserver((_, obs) => {
      if (!w.__boot.sidebar && document.querySelector("[data-testid=library-sidebar]")) w.__boot.sidebar = performance.now();
      if (!w.__boot.firstRow && document.querySelector("[data-paper-id]")) {
        w.__boot.firstRow = performance.now();
        obs.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const boots: { sidebar: number; firstRow: number }[] = [];
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.waitForFunction(() => (window as any).__boot?.firstRow > 0, null, { timeout: 30_000 });
    boots.push(await page.evaluate(() => (window as any).__boot));
  }
  await page.waitForFunction(() => (window as any).__paperlens?.db);
  await expect(page.getByTestId("library-sidebar").locator('[data-library-view="all"]')).toContainText(String(N_PAPERS));
  const rowsInDom = await page.locator("[data-paper-id]").count();

  // 单次 update：可见行、不可见行、只改 lastOpenedAt 各测一次
  await page.waitForTimeout(500);
  const updates: Record<string, Awaited<ReturnType<typeof stopMonitor>>> = {};
  const cases: [string, string, Record<string, unknown>][] = [
    ["visibleTitle", `p${N_PAPERS - 1}`, { title: "Updated visible title" }],
    ["hiddenTitle", "p3", { title: "Updated hidden title" }],
    ["lastOpenedAt", "p1000", { lastOpenedAt: Date.now() }],
    ["domainIds", "p500", { domainIds: ["r1c1"] }],
  ];
  for (const [name, id, changes] of cases) {
    await startMonitor(page);
    await page.waitForTimeout(200);
    await page.evaluate(({ id, changes }) => (window as any).__paperlens.db.papers.update(id, changes), { id, changes });
    await page.waitForTimeout(800);
    updates[name] = await stopMonitor(page);
  }
  await expect(page.locator(`[data-paper-id="p${N_PAPERS - 1}"]`)).toContainText("Updated visible title");

  // 按标题排序 + 选中一个领域（含子领域过滤）时的单次 update
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setSort("title"));
  await page.waitForTimeout(300);
  for (const [name, id, changes] of [
    ["titleSort", "p10", { title: "AAA moved to top by title sort" }],
    ["titleSortLastOpened", "p11", { lastOpenedAt: Date.now() }],
  ] as [string, string, Record<string, unknown>][]) {
    await startMonitor(page);
    await page.waitForTimeout(200);
    await page.evaluate(({ id, changes }) => (window as any).__paperlens.db.papers.update(id, changes), { id, changes });
    await page.waitForTimeout(800);
    updates[name] = await stopMonitor(page);
  }
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().select({ kind: "domain", id: "r1" }));
  await page.waitForTimeout(300);
  await startMonitor(page);
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as any).__paperlens.db.papers.update("p12", { domainIds: ["r1c2"] }));
  await page.waitForTimeout(800);
  updates.domainSelected = await stopMonitor(page);
  await page.evaluate(() => {
    const s = (window as any).__paperlens.useLibraryStore.getState();
    s.select({ kind: "all" });
    s.setSort("added");
  });
  await page.waitForTimeout(300);

  // 连续 20 次单篇写入（模拟批量导入时每篇一次写）
  await startMonitor(page);
  await page.evaluate(async () => {
    const { db } = (window as any).__paperlens;
    for (let i = 0; i < 20; i++) {
      await db.papers.add({ id: `new${i}`, fileHash: `newhash${i}`, title: `New ${i}`, authors: [], domainIds: [], pageCount: 1, addedAt: Date.now() });
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await page.waitForTimeout(500);
  const batch = await stopMonitor(page);

  // 滚动：每帧滚 160px，共 150 帧，从顶部滚到约第 2000 行附近再回来
  const list = page.getByRole("listbox", { name: "全部论文" });
  await startMonitor(page);
  await list.evaluate(async (el) => {
    for (let i = 0; i < 150; i++) {
      el.scrollTop += i < 75 ? 1600 : -1600;
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  const scroll = await stopMonitor(page);

  // 滚轮滚动（真实输入事件）
  await list.hover();
  await startMonitor(page);
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  const wheel = await stopMonitor(page);

  const report = { boots, rowsInDom, updates, batch, scroll, wheel };
  console.log("PERF " + JSON.stringify(report, null, 1));

  // 验收目标
  for (const [name, r] of Object.entries(updates)) expect.soft(r.maxLongTask, `update ${name}`).toBeLessThan(50);
  expect.soft(batch.maxLongTask, "batch adds").toBeLessThan(50);
  const medianBoot = boots.map((b) => b.firstRow).sort((a, b) => a - b)[1];
  expect.soft(medianBoot, "cold start → first row (ms)").toBeLessThan(300);
  expect.soft(rowsInDom, "virtualized rows").toBeLessThan(60);
  expect.soft(scroll.slowFrames, "slow frames while scrolling").toBeLessThanOrEqual(2);
  expect.soft(scroll.maxLongTask, "long task while scrolling").toBeLessThan(50);
});
