/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 术语后台 e2e：自动提取全文 → Worker 写 occurrences → 术语或论文变化后自动更新 → 术语表界面。
// 单独运行：npx playwright test -c tests/e2e/glossary.config.ts glossary.spec
import { expect, test, type Page } from "@playwright/test";
import { fixtureBytes } from "./viewerHelpers";
import {
  addPdf,
  bootGlossary,
  expectedOcc,
  getOccurrences,
  getPageTexts,
  occFor,
  putDomains,
  putTerms,
  updateRecord,
  waitIndexed,
} from "./glossaryHelpers";

const SIMPLE = "fx-simple";
const TWO = "fx-two";

// 与 surfaceForms 派生的表面形式一致（名称/别名 + 复数 + 连字符变体），用于独立核对计数
const RE = {
  lstm: [/\bLong[ -]Short(?:-| |)Term[ -]Memor(?:y|ies)\b/gi, /\bLSTMs?\b/g],
  atm: [/\bair[ -]traffic[ -]managements?\b/gi, /\bATMs?\b/g],
  tf: [/\btransformers?\b/gi],
  traj: [/\btrajectory[ -]predictions?\b/gi],
  attn: [/\bself[- ]?attentions?\b/gi],
};

async function seed(page: Page) {
  await putDomains(page, [
    { id: "d-atm", name: "ATM", color: "#3b82f6" },
    { id: "d-traj", name: "轨迹预测", parentId: "d-atm", color: "#10b981" },
    { id: "d-nlp", name: "NLP", color: "#8b5cf6" },
  ]);
  await putTerms(page, [
    { id: "t-lstm", name: "Long Short-Term Memory", aliases: ["LSTM"], note: "带门控的**循环网络**。", updatedAt: 3000 },
    { id: "t-atm", name: "air traffic management", aliases: ["ATM"], domains: ["d-atm"], updatedAt: 1000 },
    { id: "t-tf", name: "transformer", note: "基于自注意力。", updatedAt: 2000 },
    { id: "t-traj", name: "trajectory prediction", domains: ["d-traj"], updatedAt: 4000 },
  ]);
  await addPdf(page, fixtureBytes("simple.pdf"), SIMPLE, "Simple Fixture Paper", ["d-atm"]);
  await addPdf(page, fixtureBytes("two-column.pdf"), TWO, "Two-Column Study", []);
}

test("后台提取全文、写入 occurrences，并随术语和论文的变化自动更新", async ({ page }) => {
  await bootGlossary(page);
  await seed(page);
  await waitIndexed(page);

  const texts = { [SIMPLE]: await getPageTexts(page, SIMPLE), [TWO]: await getPageTexts(page, TWO) };
  await test.step("全文已自动提取，pageCount 已更正", async () => {
    expect(texts[SIMPLE]).toHaveLength(10);
    expect(texts[TWO]).toHaveLength(2);
    const counts = await page.evaluate(() =>
      Promise.all(["fx-simple", "fx-two"].map(async (id) => (await (window as any).__paperlens.db.papers.get(id)).pageCount)),
    );
    expect(counts).toEqual([10, 2]);
  });

  await test.step("计数与独立的正则统计一致，作用范围生效", async () => {
    const rows = await getOccurrences(page);
    expect(rows.every((r) => r.engineVersion === 1)).toBe(true);
    expect(occFor(rows, "t-lstm", SIMPLE)).toEqual(expectedOcc(texts[SIMPLE], RE.lstm));
    expect(occFor(rows, "t-lstm", TWO)).toEqual(expectedOcc(texts[TWO], RE.lstm));
    expect(occFor(rows, "t-tf", SIMPLE)).toEqual(expectedOcc(texts[SIMPLE], RE.tf));
    expect(occFor(rows, "t-tf", TWO)).toEqual(expectedOcc(texts[TWO], RE.tf));
    // ATM 限定在 d-atm：只算 simple
    expect(occFor(rows, "t-atm", SIMPLE)).toEqual(expectedOcc(texts[SIMPLE], RE.atm));
    expect(occFor(rows, "t-atm", TWO)).toBeUndefined();
    // 轨迹预测限定在子领域 d-traj：父领域 d-atm 的 simple 不算
    expect(occFor(rows, "t-traj", SIMPLE)).toBeUndefined();
    expect(occFor(rows, "t-traj", TWO)).toBeUndefined();
    // 计数确实非零（避免两边都是 0 的假阳性）
    expect(occFor(rows, "t-lstm", SIMPLE)!.count).toBeGreaterThan(20);
    expect(occFor(rows, "t-tf", TWO)!.count).toBeGreaterThan(5);
    expect(occFor(rows, "t-atm", SIMPLE)!.count).toBeGreaterThan(3);
  });

  await test.step("改别名后自动重扫", async () => {
    await updateRecord(page, "terms", "t-tf", { aliases: ["self-attention"], updatedAt: Date.now() });
    await expect.poll(async () => occFor(await getOccurrences(page), "t-tf", TWO)?.count, { timeout: 15_000 }).toBe(
      expectedOcc(texts[TWO], [...RE.tf, ...RE.attn]).count,
    );
    expect(occFor(await getOccurrences(page), "t-tf", SIMPLE)).toEqual(expectedOcc(texts[SIMPLE], [...RE.tf, ...RE.attn]));
  });

  await test.step("改作用范围后自动重扫", async () => {
    await updateRecord(page, "terms", "t-lstm", { scope: { kind: "domains", domainIds: ["d-nlp"] } });
    await expect.poll(async () => (await getOccurrences(page)).filter((r) => r.termId === "t-lstm").length, { timeout: 15_000 }).toBe(0);
    await updateRecord(page, "terms", "t-lstm", { scope: { kind: "global" } });
    await expect.poll(async () => (await getOccurrences(page)).filter((r) => r.termId === "t-lstm").length, { timeout: 15_000 }).toBe(2);
  });

  await test.step("只改笔记不触发重扫", async () => {
    const before = await page.evaluate(() => (window as any).__paperlensGlossary.useIndexerStore.getState().lastRun?.at);
    await updateRecord(page, "terms", "t-lstm", { note: "只改了笔记", updatedAt: Date.now() });
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => (window as any).__paperlensGlossary.useIndexerStore.getState().lastRun?.at);
    expect(after).toBe(before);
  });

  await test.step("论文换领域触发该论文重扫", async () => {
    await updateRecord(page, "papers", TWO, { domainIds: ["d-traj"] });
    await expect.poll(async () => occFor(await getOccurrences(page), "t-traj", TWO), { timeout: 15_000 }).toEqual(
      expectedOcc(texts[TWO], RE.traj),
    );
    expect(occFor(await getOccurrences(page), "t-traj", TWO)!.count).toBeGreaterThan(0);
    // d-traj 在 d-atm 之下，ATM 术语现在也对它生效（文中没有 ATM，所以仍无记录）
    expect(occFor(await getOccurrences(page), "t-atm", TWO)).toBeUndefined();
    const progress = await page.evaluate(() => (window as any).__paperlensGlossary.useIndexerStore.getState());
    expect(progress.failures).toEqual([]);
  });
});

test("术语表：筛选、搜索、排序、详情、跳转、删除", async ({ page }) => {
  await bootGlossary(page);
  await seed(page);
  await waitIndexed(page);
  const rows = await getOccurrences(page);
  const lstmSimple = occFor(rows, "t-lstm", SIMPLE)!;
  const lstmTwo = occFor(rows, "t-lstm", TWO)!;

  await page.evaluate(() => (window as any).__paperlens.useAppStore.getState().setView("glossary"));
  const view = page.getByTestId("glossary");
  const list = view.getByRole("listbox", { name: "术语列表" });
  const names = () => list.getByRole("option").evaluateAll((els) => els.map((e) => e.querySelector("span")!.textContent));

  await test.step("默认按名称排序，显示出现统计", async () => {
    await expect(list.getByRole("option")).toHaveCount(4);
    await expect.poll(names).toEqual(["air traffic management", "Long Short-Term Memory", "trajectory prediction", "transformer"]);
    await expect(list.getByRole("option", { name: /Long Short-Term Memory/ })).toContainText(`2 篇 · ${lstmSimple.count + lstmTwo.count} 次`);
    await expect(list.getByRole("option", { name: /trajectory prediction/ })).toContainText("未出现");
  });

  await test.step("按出现次数 / 修改时间排序", async () => {
    await view.getByRole("button", { name: /出现次数/ }).click();
    await expect.poll(async () => (await names())[0]).toBe("Long Short-Term Memory");
    expect((await names()).at(-1)).toBe("trajectory prediction");
    await view.getByRole("button", { name: /出现次数/ }).click(); // 切换为升序
    await expect.poll(async () => (await names())[0]).toBe("trajectory prediction");
    await view.getByRole("button", { name: /修改时间/ }).click();
    await expect.poll(names).toEqual(["trajectory prediction", "Long Short-Term Memory", "transformer", "air traffic management"]);
    await view.getByRole("button", { name: /名称/ }).click();
  });

  await test.step("按领域筛选（含子领域）、全局、搜索", async () => {
    const filters = view.getByRole("complementary", { name: "术语筛选" });
    await filters.getByRole("treeitem").filter({ hasText: "ATM" }).getByRole("button", { name: /ATM/ }).click();
    await expect.poll(names).toEqual(["air traffic management", "trajectory prediction"]);
    await expect(view.getByTestId("glossary-count")).toHaveText("2 / 4 个术语");
    await filters.getByRole("button", { name: /^全局/ }).click();
    await expect.poll(names).toEqual(["Long Short-Term Memory", "transformer"]);
    await filters.getByRole("button", { name: /^全部术语/ }).click();
    await filters.getByRole("searchbox", { name: "搜索术语" }).fill("自注意力");
    await expect.poll(names).toEqual(["transformer"]);
    await filters.getByRole("searchbox", { name: "搜索术语" }).fill("lstm");
    await expect.poll(names).toEqual(["Long Short-Term Memory"]);
    await filters.getByRole("button", { name: "清除术语搜索" }).click();
    await expect(list.getByRole("option")).toHaveCount(4);
  });

  await test.step("详情：别名、作用范围、笔记、按领域分组的出现位置", async () => {
    await list.getByRole("option", { name: /Long Short-Term Memory/ }).click();
    const detail = view.getByRole("complementary", { name: "术语详情" });
    await expect(detail.getByTestId("term-detail-name")).toHaveText("Long Short-Term Memory");
    await expect(detail.getByLabel("别名")).toContainText("LSTM");
    await expect(detail.getByTestId("term-detail-scope")).toContainText("全局");
    await expect(detail.getByRole("region", { name: "笔记" }).locator("strong")).toHaveText("循环网络");
    const occ = detail.getByTestId("term-occurrences");
    await expect(occ.getByTestId("term-occurrence-summary")).toHaveText(`2 篇论文 · 共 ${lstmSimple.count + lstmTwo.count} 次`);
    await expect(occ.getByRole("group", { name: "ATM" })).toContainText("Simple Fixture Paper");
    await expect(occ.getByRole("group", { name: "未分类" })).toContainText("Two-Column Study");
    await expect(occ.getByRole("group", { name: "ATM" })).toContainText(`${lstmSimple.count} 次`);

    // 键盘：↓ 选中下一个
    await list.focus();
    await page.keyboard.press("ArrowDown");
    await expect(detail.getByTestId("term-detail-name")).toHaveText("trajectory prediction");
    await page.keyboard.press("ArrowUp");
    await expect(detail.getByTestId("term-detail-name")).toHaveText("Long Short-Term Memory");
  });

  await test.step("点击论文跳到第一次出现的页，并闪烁该处（与弹窗一致）", async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.__flashes = [];
      w.__paperlens.useTermUiStore.subscribe((s: { flash: unknown }) => s.flash && w.__flashes.push(s.flash));
    });
    const detail = view.getByRole("complementary", { name: "术语详情" });
    await detail.locator(`[data-paper-id="${TWO}"]`).click();
    expect(await page.evaluate(() => (window as any).__flashes)).toContainEqual(
      expect.objectContaining({ paperId: TWO, page: lstmTwo.pages[0], termId: "t-lstm" }),
    );
    const state = await page.evaluate(() => {
      const w = window as any;
      return { view: w.__paperlens.useAppStore.getState().view, req: w.__paperlens.useReaderStore.getState().jumpRequest };
    });
    expect(state.view).toBe("reader");
    expect(state.req).toMatchObject({ paperId: TWO, page: lstmTwo.pages[0] });
    await expect(page.locator(`[data-pane="left"] .pl-page[data-page-number="${lstmTwo.pages[0]}"] canvas`)).toHaveCount(1, { timeout: 20_000 });
  });

  await test.step("删除术语（确认后）", async () => {
    await page.evaluate(() => (window as any).__paperlens.useAppStore.getState().setView("glossary"));
    await list.getByRole("option", { name: /^transformer/ }).click();
    const detail = view.getByRole("complementary", { name: "术语详情" });
    await detail.getByRole("button", { name: "删除" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("删除术语「transformer」？");
    await dialog.getByRole("button", { name: "删除术语" }).click();
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect(detail).toContainText("选择一个术语查看详情");
    expect((await getOccurrences(page)).some((r) => r.termId === "t-tf")).toBe(false);
  });

  await test.step("新建 / 编辑按钮打开术语编辑器", async () => {
    await view.getByRole("button", { name: "新建术语" }).click();
    expect(await page.evaluate(() => (window as any).__paperlens.useTermUiStore.getState().editor)).toEqual({});
    await page.evaluate(() => (window as any).__paperlens.useTermUiStore.getState().closeTermEditor());
    await list.getByRole("option", { name: /Long Short-Term Memory/ }).click();
    await view.getByRole("complementary", { name: "术语详情" }).getByRole("button", { name: "编辑" }).click();
    expect(await page.evaluate(() => (window as any).__paperlens.useTermUiStore.getState().editor)).toEqual({ termId: "t-lstm" });
    await page.evaluate(() => (window as any).__paperlens.useTermUiStore.getState().closeTermEditor());
  });
});

test("全局搜索的术语结果切换到术语表并选中", async ({ page }) => {
  await bootGlossary(page);
  await putDomains(page, [{ id: "d-atm", name: "ATM" }]);
  await putTerms(page, [
    { id: "t-a", name: "air traffic management", aliases: ["ATM"], domains: ["d-atm"] },
    { id: "t-b", name: "beam search", note: "解码时保留 k 个候选" },
  ]);
  // 先让术语表筛选到别的领域，激活结果时应自动清除筛选
  await page.evaluate(() => {
    const w = window as any;
    w.__paperlensGlossary.useGlossaryStore.getState().setFilter({ kind: "domain", id: "d-atm" });
  });
  const sidebar = page.getByTestId("library-sidebar");
  await sidebar.getByRole("searchbox", { name: "全局搜索" }).fill("候选");
  const group = sidebar.getByRole("group", { name: "术语" });
  await expect(group).toContainText("beam search");
  await group.getByRole("button", { name: /beam search/ }).click();

  const view = page.getByTestId("glossary");
  await expect(view).toBeVisible();
  await expect(view.getByRole("complementary", { name: "术语详情" }).getByTestId("term-detail-name")).toHaveText("beam search");
  await expect(view.getByRole("option", { name: /beam search/ })).toHaveAttribute("aria-selected", "true");
});

test("无法提取全文的论文被跳过，不影响其他论文", async ({ page }) => {
  await bootGlossary(page);
  await putTerms(page, [{ id: "t-lstm", name: "LSTM" }]);
  const broken = Buffer.from("%PDF-1.7\nthis is not really a pdf\n%%EOF");
  await addPdf(page, broken, "fx-broken", "Broken PDF");
  await addPdf(page, fixtureBytes("simple.pdf"), SIMPLE, "Simple");
  await waitIndexed(page);
  const rows = await getOccurrences(page);
  expect(occFor(rows, "t-lstm", SIMPLE)!.count).toBeGreaterThan(0);
  const failures = await page.evaluate(() => (window as any).__paperlensGlossary.useIndexerStore.getState().failures);
  expect(failures.map((f: { paperId: string }) => f.paperId)).toEqual(["fx-broken"]);

  await page.evaluate(() => (window as any).__paperlens.useAppStore.getState().setView("glossary"));
  await page.getByRole("button", { name: "1 篇论文无法提取全文" }).click();
  await expect(page.getByRole("dialog")).toContainText("Broken PDF");

  // 修好文件后点"重试"：重新提取并建立索引
  const good = fixtureBytes("simple.pdf").toString("base64");
  await page.evaluate(async (b64) => {
    const { db } = (window as any).__paperlens;
    const p = await db.papers.get("fx-broken");
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await db.files.put({ hash: p.fileHash, blob: new Blob([bin], { type: "application/pdf" }), size: bin.length });
  }, good);
  await page.getByRole("dialog").getByRole("button", { name: /^重试/ }).click();
  await expect(page.getByRole("button", { name: /篇论文无法提取全文/ })).toHaveCount(0, { timeout: 20_000 });
  await waitIndexed(page);
  expect(occFor(await getOccurrences(page), "t-lstm", "fx-broken")!.count).toBeGreaterThan(0);
});

test("多个标签页只有一个做索引；它关闭后另一个接手", async ({ page, context }) => {
  await bootGlossary(page);
  const other = await context.newPage();
  await bootGlossary(other);
  const debug = (p: Page) => p.evaluate(() => (window as any).__paperlensGlossary.getIndexerDebug());
  await expect.poll(async () => (await debug(page))?.leader).toBe(true);
  expect((await debug(other))?.leader).toBe(false);

  // 在非索引标签页里写入：由索引标签页处理，进度同步过来
  await putTerms(other, [{ id: "t-lstm", name: "LSTM" }]);
  await addPdf(other, fixtureBytes("simple.pdf"), SIMPLE, "Simple");
  await waitIndexed(page);
  expect(occFor(await getOccurrences(other), "t-lstm", SIMPLE)!.count).toBeGreaterThan(0);
  await expect
    .poll(() => other.evaluate(() => (window as any).__paperlensGlossary.useIndexerStore.getState().lastRun?.scanned ?? 0))
    .toBeGreaterThan(0);

  // 索引标签页关闭：锁释放，另一个标签页接手
  await page.close();
  await expect.poll(async () => (await debug(other))?.leader, { timeout: 10_000 }).toBe(true);
  await putTerms(other, [{ id: "t-mem", name: "Long Short-Term Memory" }]);
  await expect.poll(async () => occFor(await getOccurrences(other), "t-mem", SIMPLE)?.count ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
});
