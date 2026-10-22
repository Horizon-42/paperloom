// 文库冒烟测试：导入 → 出现在列表 → 新建领域 → 拖入领域 → 点击领域可见
// 截图路径可用 LIBRARY_SCREENSHOT 指定；设置 PAPERLENS_REAL_PDF_DIR 时额外用真实 PDF 测试批量导入
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

async function makePdf(title: string, author: string, pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor(author);
  doc.setCreationDate(new Date("2021-06-01T00:00:00Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${title} - page ${i + 1}`, { x: 72, y: 760, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

const sidebarOf = (page: Page) => page.getByTestId("library-sidebar");
const paperRows = (sidebar: Locator) => sidebar.locator("[data-paper-id]");
const domainRow = (sidebar: Locator, name: string) => sidebar.locator("[data-domain-id]", { hasText: name });

/** 收集页面错误和 console.error（含 React / Radix 的告警），测试末尾断言为空 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || (m.type() === "warning" && /radix|react/i.test(m.text()))) errors.push(m.text());
  });
  return errors;
}

async function createDomain(sidebar: Locator, name: string) {
  await sidebar.getByRole("button", { name: "新建领域" }).click();
  const input = sidebar.getByRole("textbox", { name: "领域名称" });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press("Enter");
  await expect(domainRow(sidebar, name)).toBeVisible();
}

test("import a PDF, file it into a domain, filter by domain", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  await expect(sidebar).toBeVisible();

  const title = "Smoke Test: Trajectory Prediction with Transformers";
  const pdf = await makePdf(title, "Alice Zhang; Bob Li");
  await page.getByTestId("import-input").setInputFiles({ name: "smoke_test.pdf", mimeType: "application/pdf", buffer: pdf });

  const row = paperRows(sidebar).filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Alice Zhang, Bob Li");
  await expect(row).toContainText("2021");

  // 同一文件再导入一次：提示已在文库中，不新增
  await page.getByTestId("import-input").setInputFiles({ name: "renamed_copy.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByTestId("import-status")).toContainText("已在文库中");
  await expect(paperRows(sidebar)).toHaveCount(1);

  await createDomain(sidebar, "轨迹预测");
  const domain = domainRow(sidebar, "轨迹预测");

  // 论文拖到领域上 → 归入该领域
  await row.dragTo(domain);
  await expect(domain).toContainText("1");

  await domain.click();
  await expect(sidebar.getByRole("heading", { name: /轨迹预测/ })).toBeVisible();
  await expect(paperRows(sidebar)).toHaveCount(1);
  await expect(row.locator("span[title='轨迹预测']")).toHaveCount(1); // 领域色点

  await sidebar.getByRole("button", { name: /未分类/ }).click();
  await expect(paperRows(sidebar)).toHaveCount(0);

  // 子领域：把新领域拖到"轨迹预测"上成为其子领域；选中父领域仍能看到子领域下的论文
  await createDomain(sidebar, "ATM");
  await domainRow(sidebar, "轨迹预测").dragTo(domainRow(sidebar, "ATM"));
  await expect(domainRow(sidebar, "ATM")).toHaveAttribute("aria-expanded", "true");
  await expect(domainRow(sidebar, "轨迹预测")).toHaveAttribute("aria-level", "2");
  await domainRow(sidebar, "ATM").click();
  await expect(paperRows(sidebar)).toHaveCount(1);

  // 搜索
  await sidebar.getByRole("searchbox", { name: "全局搜索" }).fill("zhang transformers");
  await expect(sidebar.getByRole("group", { name: "论文" })).toContainText(title);
  await sidebar.getByRole("searchbox", { name: "全局搜索" }).fill("nothing-matches");
  await expect(sidebar).toContainText("没有找到");
  await sidebar.getByRole("button", { name: "清除搜索" }).click();

  // 单击打开论文
  await row.click();
  await expect.poll(() => page.evaluate(() => (window as any).__paperlens?.useReaderStore.getState().panes[0].activePaperId)).toBeTruthy();

  await page.waitForTimeout(2000); // 等闪烁提示消失再截图
  await sidebar.screenshot({ path: process.env.LIBRARY_SCREENSHOT ?? "test-results/library-sidebar.png" });
  expect(errors).toEqual([]);
});

test("拖到领域上是移动（可撤销）；右键「添加到领域」保留原领域", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  await page.getByTestId("import-input").setInputFiles({ name: "move.pdf", mimeType: "application/pdf", buffer: await makePdf("Move Me", "Carol") });
  const row = paperRows(sidebar).first();
  await expect(row).toBeVisible();
  await createDomain(sidebar, "甲");
  await createDomain(sidebar, "乙");
  const names = () =>
    page.evaluate(async () => {
      const { db } = (window as any).__paperlens;
      const [p] = await db.papers.toArray();
      const all = await db.domains.toArray();
      return p.domainIds.map((id: string) => all.find((d: any) => d.id === id)?.name);
    });

  // 全部论文 → 甲
  await row.dragTo(domainRow(sidebar, "甲"));
  await expect.poll(names).toEqual(["甲"]);
  // 在「甲」里拖到「乙」：移出甲
  await domainRow(sidebar, "甲").click();
  await paperRows(sidebar).first().dragTo(domainRow(sidebar, "乙"));
  await expect.poll(names).toEqual(["乙"]);
  await expect(paperRows(sidebar)).toHaveCount(0); // 已不在「甲」里
  // 每次移动都有一条可撤销的提示
  const toast = page.locator('[data-annotation-toast="info"]', { hasText: "已移到「乙」" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "撤销" }).click();
  await expect.poll(names).toEqual(["甲"]);
  await expect(paperRows(sidebar)).toHaveCount(1);

  // 右键 → 添加到领域 → 乙：甲保留；已在的领域打勾、不能再选
  await paperRows(sidebar).first().click({ button: "right" });
  await page.locator("[data-add-to-domain]").click();
  const sub = page.locator('[role="menu"]').last();
  await expect(sub.locator("[data-domain-id]", { hasText: "甲" })).toHaveAttribute("data-disabled", "");
  await sub.locator("[data-domain-id]", { hasText: "乙" }).click();
  await expect.poll(names).toEqual(["甲", "乙"]);
  expect(errors).toEqual([]);
});

test("edit metadata and delete a domain", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  await page
    .getByTestId("import-input")
    .setInputFiles({ name: "Some_Paper_2019.pdf", mimeType: "application/pdf", buffer: await makePdf("untitled", "mwatson") });
  const row = paperRows(sidebar).first();
  await expect(row).toContainText("Some Paper 2019"); // 无意义的元数据标题回退到文件名
  await expect(row).toContainText("2019");

  await createDomain(sidebar, "方法");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑信息…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("标题").fill("A Better Title");
  await dialog.getByLabel(/作者/).fill("张三；李四, 王五");
  await dialog.getByLabel("年份").fill("2020");
  await dialog.getByRole("checkbox").first().check();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText("A Better Title");
  await expect(row).toContainText("张三, 李四, 王五");
  await expect(row).toContainText("2020");

  await domainRow(sidebar, "方法").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除领域…" }).click();
  await expect(page.getByRole("dialog")).toContainText("1 篇论文将移出这些领域");
  await page.getByRole("button", { name: "删除领域" }).click();
  await expect(domainRow(sidebar, "方法")).toHaveCount(0);
  await expect(paperRows(sidebar)).toHaveCount(1); // 论文本身保留
  await sidebar.getByRole("button", { name: /未分类/ }).click();
  await expect(paperRows(sidebar)).toHaveCount(1);

  // 删除论文
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除论文…" }).click();
  await page.getByRole("button", { name: "删除论文" }).click();
  await expect(paperRows(sidebar)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__paperlens.db.files.count())).toBe(0);
  expect(errors).toEqual([]);
});

test("reorder and nest domains by drag and drop, refusing cycles", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  const names = () => sidebar.locator("[data-domain-id]").allInnerTexts().then((xs) => xs.map((x) => x.trim()));
  await createDomain(sidebar, "A");
  await createDomain(sidebar, "B");
  expect(await names()).toEqual(["A", "B"]);

  // 拖到 A 的上沿 → 排到 A 之前
  await domainRow(sidebar, "B").dragTo(domainRow(sidebar, "A"), { targetPosition: { x: 40, y: 2 } });
  await expect.poll(names).toEqual(["B", "A"]);

  // A 拖到 B 中间 → 成为 B 的子领域
  await domainRow(sidebar, "A").dragTo(domainRow(sidebar, "B"));
  await expect(domainRow(sidebar, "A")).toHaveAttribute("aria-level", "2");

  // B 拖进自己的子领域 A：不允许，结构不变
  await domainRow(sidebar, "B").dragTo(domainRow(sidebar, "A"));
  await expect(domainRow(sidebar, "B")).toHaveAttribute("aria-level", "1");
  await expect(domainRow(sidebar, "A")).toHaveAttribute("aria-level", "2");

  // 拖到"移到顶层"放置区
  const a = domainRow(sidebar, "A");
  await a.hover();
  await page.mouse.down();
  await page.mouse.move(100, 400, { steps: 4 });
  const zone = sidebar.getByText("拖到这里移到顶层");
  await expect(zone).toBeVisible();
  const box = (await zone.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(domainRow(sidebar, "A")).toHaveAttribute("aria-level", "1");
  await expect.poll(names).toEqual(["B", "A"]);

  // 调整侧栏宽度
  const before = (await sidebar.boundingBox())!.width;
  const handle = sidebar.getByRole("separator");
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 80, 300, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await sidebar.boundingBox())!.width - before)).toBe(80);

  expect(errors).toEqual([]);
});

test("virtualized long list: reveal after import, context menu and drag still work", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__paperlens?.useLibraryStore);
  const sidebar = sidebarOf(page);
  await createDomain(sidebar, "目标领域");
  await page.evaluate(async () => {
    const { db, useLibraryStore } = (window as any).__paperlens;
    const papers = Array.from({ length: 600 }, (_, i) => ({
      id: `seed${i}`,
      fileHash: `seedhash${i}`,
      title: `${String.fromCharCode(65 + (i % 26))}${String(i).padStart(3, "0")} seeded paper`,
      authors: ["Seed Author"],
      domainIds: [],
      pageCount: 1,
      addedAt: i,
    }));
    await db.papers.bulkAdd(papers);
    useLibraryStore.getState().setSort("title");
  });
  await expect(sidebar.getByRole("heading", { name: /全部论文/ })).toContainText("600");
  expect(await paperRows(sidebar).count()).toBeLessThan(60); // 只渲染可视区域附近的行

  // 新论文按标题排在列表中部：导入后应滚动到它并高亮
  const pdf = await makePdf("Mmm Middle Of The List", "Carol Wu");
  await page.getByTestId("import-input").setInputFiles({ name: "middle.pdf", mimeType: "application/pdf", buffer: pdf });
  const row = paperRows(sidebar).filter({ hasText: "Mmm Middle Of The List" });
  await expect(row).toBeInViewport();
  await expect(row).toHaveClass(/ring-amber/);

  // 滚回顶部后再导入同一文件：重复 → 再次定位到它
  await sidebar.getByRole("listbox", { name: "全部论文" }).evaluate((el) => (el.scrollTop = 0));
  await expect(row).toHaveCount(0);
  await page.getByTestId("import-input").setInputFiles({ name: "middle-copy.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByTestId("import-status")).toContainText("已在文库中");
  await expect(row).toBeInViewport();

  // 右键菜单（列表共用一个菜单）
  await row.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "编辑信息…" })).toBeVisible();
  await page.keyboard.press("Escape");

  // 拖到领域
  await row.dragTo(domainRow(sidebar, "目标领域"));
  await expect(domainRow(sidebar, "目标领域")).toContainText("1");
  expect(errors).toEqual([]);
});

const realDir = process.env.PAPERLENS_REAL_PDF_DIR;

test("bulk import real PDFs", async ({ page }) => {
  test.skip(!realDir, "set PAPERLENS_REAL_PDF_DIR to run");
  test.setTimeout(120_000);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.toLowerCase().endsWith(".pdf") && statSync(p).size < 15e6) files.push(p);
    }
  };
  walk(realDir!);
  const picked = files.sort().filter((_, i) => i % Math.max(1, Math.floor(files.length / 24)) === 0).slice(0, 24);

  await page.goto("/");
  const sidebar = sidebarOf(page);
  await createDomain(sidebar, "真实论文");
  await domainRow(sidebar, "真实论文").click();
  await page.getByTestId("import-input").setInputFiles(
    picked.map((p) => ({ name: p.split("/").pop()!, mimeType: "application/pdf", buffer: readFileSync(p) })),
  );
  await expect(page.getByTestId("import-status")).toContainText(/导入完成|已导入/, { timeout: 100_000 });
  const status = await page.getByTestId("import-status").innerText();
  console.log(status.replace(/\s+/g, " "));
  await expect(paperRows(sidebar)).not.toHaveCount(0);
  await page.screenshot({ path: process.env.LIBRARY_SCREENSHOT_REAL ?? "test-results/library-real.png" });
});
