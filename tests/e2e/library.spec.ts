// 文库冒烟测试：导入 → 出现在「未分类」→ 新建领域 → 拖入领域 → 领域像文件夹一样展开可见
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

  // 新导入的论文在「未分类」里；领域树里的行和「全部」列表一样显示作者、年份
  const row = paperRows(sidebar).filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-parent-domain-id", "");
  await expect(row).toContainText("Alice Zhang, Bob Li");
  await expect(row).toContainText("2021");

  // 同一文件再导入一次：提示已在文库中，不新增
  await page.getByTestId("import-input").setInputFiles({ name: "renamed_copy.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByTestId("import-status")).toContainText("已在文库中");
  await expect(paperRows(sidebar)).toHaveCount(1);

  await createDomain(sidebar, "轨迹预测");
  const domain = domainRow(sidebar, "轨迹预测");

  // 论文拖到领域上 → 移进该领域；「未分类」空了就不显示
  await row.dragTo(domain);
  await expect(domain).toContainText("1");
  await expect(sidebar.locator("[data-unfiled]")).toHaveCount(0);
  await expect(paperRows(sidebar)).toHaveCount(0); // 领域默认折叠

  // 点领域：选中并展开，论文在它下面
  await domain.click();
  await expect(domain).toHaveAttribute("aria-expanded", "true");
  await expect(domain).toHaveAttribute("aria-selected", "true");
  await expect(paperRows(sidebar)).toHaveCount(1);
  const domainId = await domain.getAttribute("data-domain-id");
  await expect(row).toHaveAttribute("data-parent-domain-id", domainId!);
  await expect(row).toHaveAttribute("aria-level", "2");
  // 收起
  await domain.getByRole("button", { name: "折叠" }).click();
  await expect(paperRows(sidebar)).toHaveCount(0);
  await domain.getByRole("button", { name: "展开" }).click();

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

test("领域树：多领域标记、拖到论文行和「未分类」、右键从所在领域移除、导入到选中的领域并定位、视图切换", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__paperlens?.useLibraryStore);
  const sidebar = sidebarOf(page);
  await page.evaluate(async () => {
    const { db } = (window as any).__paperlens;
    await db.domains.bulkAdd([
      { id: "A", name: "甲", parentId: null, color: "#3b82f6", order: 0 },
      { id: "A1", name: "甲一", parentId: "A", color: "#10b981", order: 0 },
      { id: "B", name: "乙", parentId: null, color: "#f59e0b", order: 1 },
    ]);
    const paper = (id: string, domainIds: string[]) => ({ id, fileHash: `h-${id}`, title: `Paper ${id}`, authors: [], domainIds, pageCount: 1, addedAt: 1 });
    await db.papers.bulkAdd([paper("p", ["A1", "B"]), paper("q", ["B"]), paper("r", [])]);
  });
  const rowIn = (paperId: string, parent: string) => sidebar.locator(`[data-paper-id="${paperId}"][data-parent-domain-id="${parent}"]`);
  const domainsOf = (id: string) => page.evaluate(async (id) => (await (window as any).__paperlens.db.papers.get(id)).domainIds, id);

  // 计数含子领域、不重复；展开后子领域在前、论文在后；多领域的论文在每个领域下各出现一次，带标记
  await expect(domainRow(sidebar, "甲")).toContainText("1");
  await expect(domainRow(sidebar, "乙")).toContainText("2");
  await domainRow(sidebar, "甲").click();
  await domainRow(sidebar, "甲一").click();
  await domainRow(sidebar, "乙").click();
  await expect(rowIn("p", "A1")).toHaveAttribute("aria-level", "3");
  await expect(rowIn("p", "A1").locator("[data-multi-field]")).toHaveAttribute("aria-label", "也在：乙");
  await expect(rowIn("p", "B").locator("[data-multi-field]")).toHaveAttribute("aria-label", "也在：甲 / 甲一");
  await expect(rowIn("q", "B").locator("[data-multi-field]")).toHaveCount(0);

  // 「乙」里的 p 拖到「甲一」里的论文行上 = 拖到「甲一」：只移出「乙」（p 本来就在甲一，结果只剩甲一）
  await rowIn("p", "B").dragTo(rowIn("p", "A1"));
  await expect.poll(() => domainsOf("p")).toEqual(["A1"]);
  await expect(rowIn("p", "B")).toHaveCount(0);
  // q 从「乙」拖到「未分类」：移出乙
  await rowIn("q", "B").dragTo(sidebar.locator("[data-unfiled]"));
  await expect.poll(() => domainsOf("q")).toEqual([]);
  await expect(page.locator('[data-annotation-toast="info"]', { hasText: "已移出「乙」" })).toBeVisible();
  await expect(rowIn("q", "")).toBeVisible();

  // 右键「从「甲一」移除」：只移出这一行所在的领域
  await page.evaluate(() => (window as any).__paperlens.db.papers.update("p", { domainIds: ["A1", "B"] }));
  await rowIn("p", "A1").click({ button: "right" });
  await page.locator("[data-remove-from-domain]").click();
  await expect.poll(() => domainsOf("p")).toEqual(["B"]);
  // 领域行上右键是领域菜单，不是论文菜单
  await domainRow(sidebar, "乙").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "新建子领域" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "编辑信息…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 选中「甲一」后收起「甲」，导入：归入甲一，并展开到它、定位闪烁
  await domainRow(sidebar, "甲一").click();
  await domainRow(sidebar, "甲").getByRole("button", { name: "折叠" }).click();
  await expect(domainRow(sidebar, "甲一")).toHaveCount(0);
  await page.getByTestId("import-input").setInputFiles({ name: "new.pdf", mimeType: "application/pdf", buffer: await makePdf("Fresh Import", "Dan") });
  const fresh = paperRows(sidebar).filter({ hasText: "Fresh Import" });
  await expect(fresh).toBeInViewport();
  await expect(fresh).toHaveAttribute("data-parent-domain-id", "A1");
  await expect(fresh).toHaveClass(/ring-amber/);

  // 「未分类」收起；视图和展开状态刷新后保留
  await sidebar.locator("[data-unfiled]").click();
  await expect(rowIn("q", "")).toHaveCount(0);
  await sidebar.locator('[data-library-view="all"]').click();
  await expect(sidebar.getByRole("listbox", { name: "全部论文" }).locator("[role=option]")).toHaveCount(4);
  await page.reload();
  await expect(sidebar.getByRole("listbox", { name: "全部论文" })).toBeVisible();
  await sidebar.locator('[data-library-view="tree"]').click();
  await expect(fresh).toBeVisible();
  await expect(rowIn("q", "")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("领域树：在树里编辑标签、筛选时新建领域、移动后撤销、键盘导航", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__paperlens?.useLibraryStore);
  const sidebar = sidebarOf(page);
  await page.evaluate(async () => {
    const { db } = (window as any).__paperlens;
    await db.domains.bulkAdd([
      { id: "A", name: "甲", parentId: null, color: "#3b82f6", order: 0 },
      { id: "B", name: "乙", parentId: null, color: "#f59e0b", order: 1 },
    ]);
    const paper = (id: string, domainIds: string[], tags?: string[]) => ({ id, fileHash: `h-${id}`, title: `Paper ${id}`, authors: [], domainIds, pageCount: 1, addedAt: 1, ...(tags ? { tags } : {}) });
    await db.papers.bulkAdd([paper("p", ["A", "B"], ["x"]), paper("q", ["A"])]);
  });
  const rowIn = (paperId: string, parent: string) => sidebar.locator(`[data-paper-id="${paperId}"][data-parent-domain-id="${parent}"]`);
  const domainsOf = (id: string) => page.evaluate(async (id) => (await (window as any).__paperlens.db.papers.get(id)).domainIds, id);
  await domainRow(sidebar, "甲").click();
  await domainRow(sidebar, "乙").click();

  // 标签编辑器锚定在点击的那一行上（p 在甲、乙下各一行），在屏幕内
  await rowIn("p", "B").hover();
  await rowIn("p", "B").locator("[data-tag-trigger]").click();
  const editor = page.locator('[data-tag-editor="p"]');
  await expect(editor).toBeInViewport();
  const eb = (await editor.boundingBox())!;
  const rb = (await rowIn("p", "B").boundingBox())!;
  // 在这一行的右侧、与它竖直方向重叠（靠近窗口底部时会向上挪一些）
  expect(eb.x).toBeGreaterThan(rb.x + rb.width - 8);
  expect(eb.y).toBeLessThan(rb.y + rb.height);
  expect(eb.y + eb.height).toBeGreaterThan(rb.y);
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(rowIn("p", "B")).toBeFocused(); // 焦点回到打开它的那一行（不是同一篇论文在「甲」下的那行）
  // 在行上按 T
  await rowIn("q", "A").focus();
  await page.keyboard.press("t");
  await expect(page.locator('[data-tag-editor="q"]')).toBeInViewport();
  await page.keyboard.press("Escape");

  // 按标签筛选时新建领域：新领域（没有匹配论文）也显示并进入重命名
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setTagFilter(["x"]));
  await expect(rowIn("q", "A")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "新建领域" }).click();
  const input = sidebar.getByRole("textbox", { name: "领域名称" });
  await expect(input).toBeFocused();
  await input.fill("丙");
  await input.press("Enter");
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setTagFilter([]));
  await expect(domainRow(sidebar, "丙")).toBeVisible();

  // 「全部」上显示筛选匹配数
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setTagFilter(["x"]));
  await expect(sidebar.locator('[data-library-view="all"]')).toContainText("1/2");
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setTagFilter([]));
  await expect(sidebar.locator('[data-library-view="all"]')).toContainText("2");

  // 右键「从「乙」移除」可撤销
  await rowIn("p", "B").click({ button: "right" });
  await page.locator("[data-remove-from-domain]").click();
  await expect.poll(() => domainsOf("p")).toEqual(["A"]);
  await page.locator('[data-annotation-toast="info"]', { hasText: "已移出「乙」" }).getByRole("button", { name: "撤销" }).click();
  await expect.poll(() => domainsOf("p")).toEqual(["A", "B"]);

  // 选中的领域是导入目标：再点一次取消选中，Esc 也取消
  const selection = () => page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().selection);
  await expect.poll(selection).toEqual({ kind: "domain", id: "B" }); // 开头点「乙」展开时已选中
  await expect(page.getByRole("button", { name: "导入" })).toHaveAttribute("title", /将归入「乙」/);
  await domainRow(sidebar, "乙").click();
  await expect.poll(selection).toEqual({ kind: "all" });
  await expect(domainRow(sidebar, "乙")).toHaveAttribute("aria-expanded", "true"); // 取消选中不收起
  await domainRow(sidebar, "乙").click();
  await page.keyboard.press("Escape");
  await expect.poll(selection).toEqual({ kind: "all" });

  // 移动后撤销
  await rowIn("q", "A").dragTo(domainRow(sidebar, "乙"));
  await expect.poll(() => domainsOf("q")).toEqual(["B"]);
  await page.locator('[data-annotation-toast="info"]', { hasText: "已移到「乙」" }).getByRole("button", { name: "撤销" }).click();
  await expect.poll(() => domainsOf("q")).toEqual(["A"]);

  // 键盘：上下移动焦点，论文行上按左键回到所在领域，展开的领域按左键收起
  await rowIn("p", "A").focus();
  await page.keyboard.press("ArrowDown");
  await expect(rowIn("q", "A")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(domainRow(sidebar, "甲")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(domainRow(sidebar, "甲")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(domainRow(sidebar, "乙")).toBeFocused();
  expect(errors).toEqual([]);
});

test("导入到某个领域：领域行上的导入按钮、右键菜单、把文件拖到领域行上", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  await expect(sidebar).toBeVisible();
  await createDomain(sidebar, "甲");
  await createDomain(sidebar, "乙");
  const jia = domainRow(sidebar, "甲");
  const yi = domainRow(sidebar, "乙");
  // 选中乙：按钮、菜单和拖放都应导入到指定的领域，而不是选中的
  await yi.click();
  await expect(yi).toHaveAttribute("aria-selected", "true");
  const domainsOf = (title: string) =>
    page.evaluate(async (title) => {
      const { db } = (window as any).__paperlens;
      const p = (await db.papers.toArray()).find((x: any) => x.title === title);
      const all = await db.domains.toArray();
      return p ? p.domainIds.map((id: string) => all.find((d: any) => d.id === id)?.name) : null;
    }, title);

  // 行上的导入按钮（悬停时出现，在 + 右边）
  await jia.hover();
  const btn = jia.locator("[data-import-into]");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("title", /导入 PDF 到「甲」/);
  const chooser = page.waitForEvent("filechooser");
  await btn.click();
  await (await chooser).setFiles({ name: "a.pdf", mimeType: "application/pdf", buffer: await makePdf("Paper Via Button", "Ann") });
  await expect.poll(() => domainsOf("Paper Via Button")).toEqual(["甲"]);
  // 导入完展开该领域，新论文就在它下面；选中的仍是乙
  await expect(jia).toHaveAttribute("aria-expanded", "true");
  await expect(paperRows(sidebar).filter({ hasText: "Paper Via Button" })).toHaveAttribute("data-parent-domain-id", (await jia.getAttribute("data-domain-id"))!);
  await expect(yi).toHaveAttribute("aria-selected", "true");
  // 各行共用一个挂在 body 上的 input
  await expect(page.locator('[data-testid="import-input-domain"]')).toHaveCount(1);

  // 右键菜单
  await jia.click({ button: "right" });
  const chooser2 = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "导入论文到此领域…" }).click();
  await (await chooser2).setFiles({ name: "b.pdf", mimeType: "application/pdf", buffer: await makePdf("Paper Via Menu", "Ben") });
  await expect.poll(() => domainsOf("Paper Via Menu")).toEqual(["甲"]);

  // 从系统拖文件到领域行上：拖入提示显示这个领域，放下后只导入一次、归入它
  const pdf = (await makePdf("Paper Via Drop", "Cid")).toString("base64");
  const dt = await page.evaluateHandle((b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const d = new DataTransfer();
    d.items.add(new File([bin], "c.pdf", { type: "application/pdf" }));
    return d;
  }, pdf);
  await jia.dispatchEvent("dragenter", { dataTransfer: dt });
  await jia.dispatchEvent("dragover", { dataTransfer: dt });
  await expect(jia).toHaveClass(/ring-blue-400/);
  await expect(page.getByText("将归入「甲」")).toBeVisible();
  await jia.dispatchEvent("drop", { dataTransfer: dt });
  await expect.poll(() => domainsOf("Paper Via Drop")).toEqual(["甲"]);
  await expect(page.getByText("将归入「甲」")).toHaveCount(0);
  await expect(jia).not.toHaveClass(/ring-blue-400/);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__paperlens.db.papers.count())).toBe(3);

  // 拖到领域行以外的地方：仍然导入到选中的领域（乙）
  const dt2 = await page.evaluateHandle((b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const d = new DataTransfer();
    d.items.add(new File([bin], "d.pdf", { type: "application/pdf" }));
    return d;
  }, (await makePdf("Paper Elsewhere", "Dee")).toString("base64"));
  const search = sidebar.getByRole("searchbox", { name: "全局搜索" });
  await search.dispatchEvent("dragenter", { dataTransfer: dt2 });
  await search.dispatchEvent("dragover", { dataTransfer: dt2 });
  await expect(page.getByText("将归入「乙」")).toBeVisible();
  await search.dispatchEvent("drop", { dataTransfer: dt2 });
  await expect.poll(() => domainsOf("Paper Elsewhere")).toEqual(["乙"]);

  // 拖到领域里的论文行上 = 导入到那个领域；拖到「未分类」上 = 不归类
  const fileDrag = async (title: string) => {
    const b64 = (await makePdf(title, "Eve")).toString("base64");
    return page.evaluateHandle(
      ([b64, name]) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const d = new DataTransfer();
        d.items.add(new File([bin], name, { type: "application/pdf" }));
        return d;
      },
      [b64, `${title}.pdf`],
    );
  };
  const paperInJia = paperRows(sidebar).filter({ hasText: "Paper Via Button" });
  const dt3 = await fileDrag("Paper On Paper Row");
  await paperInJia.dispatchEvent("dragenter", { dataTransfer: dt3 });
  await paperInJia.dispatchEvent("dragover", { dataTransfer: dt3 });
  await expect(page.getByText("将归入「甲」")).toBeVisible();
  await paperInJia.dispatchEvent("drop", { dataTransfer: dt3 });
  await expect.poll(() => domainsOf("Paper On Paper Row")).toEqual(["甲"]);

  // 「未分类」只在有未归类论文时显示：先放一篇进去
  await yi.click(); // 再点一次取消选中：之后拖到别处的不归类
  await expect(yi).toHaveAttribute("aria-selected", "false");
  const dt4 = await fileDrag("Unfiled Seed");
  await search.dispatchEvent("dragenter", { dataTransfer: dt4 });
  await search.dispatchEvent("dragover", { dataTransfer: dt4 });
  await search.dispatchEvent("drop", { dataTransfer: dt4 });
  await expect.poll(() => domainsOf("Unfiled Seed")).toEqual([]);
  await jia.click(); // 选中甲；拖到「未分类」上的仍然不归类
  const unfiled = sidebar.locator("[data-unfiled]");
  const dt5 = await fileDrag("Paper On Unfiled");
  await unfiled.dispatchEvent("dragenter", { dataTransfer: dt5 });
  await unfiled.dispatchEvent("dragover", { dataTransfer: dt5 });
  await expect(page.getByText("不归入任何领域")).toBeVisible();
  await unfiled.dispatchEvent("drop", { dataTransfer: dt5 });
  await expect.poll(() => domainsOf("Paper On Unfiled")).toEqual([]);

  // 放在会自己 preventDefault 的元素上（如笔记编辑器）：仍按选中的领域导入
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "eats-drops";
    el.style.cssText = "position:fixed;left:600px;top:300px;width:100px;height:100px";
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("drop", (e) => e.preventDefault());
    document.body.appendChild(el);
  });
  const dt6 = await fileDrag("Paper On Editor");
  const eater = page.locator("#eats-drops");
  await eater.dispatchEvent("dragenter", { dataTransfer: dt6 });
  await eater.dispatchEvent("dragover", { dataTransfer: dt6 });
  await eater.dispatchEvent("drop", { dataTransfer: dt6 });
  await expect.poll(() => domainsOf("Paper On Editor")).toEqual(["甲"]);
  await expect(page.getByText("松开以导入 PDF")).toHaveCount(0);

  // 导入按钮的图标是"箭头进入托盘"
  await expect(sidebar.getByRole("button", { name: "导入", exact: true }).locator("path")).toHaveAttribute("d", /^M12 3v11/);
  expect(errors).toEqual([]);
});

test("双击领域展开 / 收起（不再改名，改名用 F2 或菜单）", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  await page.getByTestId("import-input").setInputFiles({ name: "d.pdf", mimeType: "application/pdf", buffer: await makePdf("Double Click Paper", "Ann") });
  await createDomain(sidebar, "丙");
  const row = paperRows(sidebar).first();
  const folder = domainRow(sidebar, "丙");
  await row.dragTo(folder);
  await expect(folder).toHaveAttribute("aria-expanded", "false");

  // 收起的领域：双击展开并选中
  await folder.locator("span", { hasText: "丙" }).dblclick();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(folder).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("textbox", { name: "领域名称" })).toHaveCount(0);
  // 展开的、已选中的领域：双击收起，仍然选中（第一次单击不会取消选中）
  await folder.dblclick();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(folder).toHaveAttribute("aria-selected", "true");
  // 连着双击两次（第二次双击时 click 的 detail 是 3、4）：开、关各一次
  const box = (await folder.locator("span", { hasText: "丙" }).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2 });
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 4 });
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 3 });
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  // 展开箭头上的双击只按箭头算（两次切换），不额外再切换一次
  await folder.getByRole("button", { name: "展开" }).dblclick();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  // F2 改名
  await folder.focus();
  await page.keyboard.press("F2");
  await expect(sidebar.getByRole("textbox", { name: "领域名称" })).toBeFocused();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("领域笔记：右键新建，在右侧面板编辑并自动保存；列表里显示第一行；预览；删除可撤销；删除领域时笔记保留为自由笔记", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  await createDomain(sidebar, "父领域");
  const parent = domainRow(sidebar, "父领域");
  const notes = () => page.evaluate(() => (window as any).__paperlens.db.notes.toArray());

  // 右键 → 新建领域笔记：展开领域，右侧面板打开、焦点在编辑器里
  await parent.click({ button: "right" });
  await page.locator("[data-new-field-note]").click();
  const panel = page.locator("[data-note-panel]");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("父领域");
  const row = sidebar.locator("[data-note-id]");
  await expect(row).toHaveText("空白笔记");
  await expect(panel.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("## 整体总结\n这个领域关注轨迹预测");
  await expect(row).toHaveText("整体总结");
  await expect(panel.locator('[data-note-status="saved"]')).toBeVisible();
  const [n] = await notes();
  expect(n.text).toBe("## 整体总结\n这个领域关注轨迹预测");
  expect(n.domainId).toBe(await parent.getAttribute("data-domain-id"));
  await expect(row).toHaveAttribute("aria-current", "true");

  // 预览
  await panel.getByRole("button", { name: "预览" }).click();
  await expect(panel.locator("h2")).toHaveText("整体总结");
  // 关闭（Esc 在编辑器里）、再点列表里的条目打开
  await panel.getByRole("button", { name: "编辑" }).click();
  await panel.locator(".cm-content").click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await row.click();
  await expect(panel).toBeVisible();

  // 右键删除：面板关闭，可撤销
  await row.click({ button: "right" });
  await page.locator("[data-delete-note]").click();
  await expect(row).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(row).toHaveText("整体总结");

  // 子领域也可以有领域笔记；删除父领域：笔记保留，变成画布上的自由笔记
  await parent.click({ button: "right" });
  await page.getByRole("menuitem", { name: "新建子领域" }).click();
  const input = sidebar.getByRole("textbox", { name: "领域名称" });
  await input.fill("子领域");
  await input.press("Enter");
  const child = domainRow(sidebar, "子领域");
  await child.click({ button: "right" });
  await page.locator("[data-new-field-note]").click();
  await expect(panel).toContainText("父领域 / 子领域");
  await expect(panel.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("子领域的总结");
  await expect(sidebar.locator("[data-note-id]")).toHaveText(["整体总结", "子领域的总结"]);
  await parent.click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除领域…" }).click();
  await expect(page.getByRole("dialog")).toContainText("2 条领域笔记会保留");
  await page.getByRole("dialog").getByRole("button", { name: "删除领域" }).click();
  await expect(sidebar.locator("[data-note-id]")).toHaveCount(0);
  const left = await notes();
  expect(left).toHaveLength(2);
  expect(left.every((x: any) => x.domainId === undefined)).toBe(true);
  expect(errors).toEqual([]);
});

test("领域笔记：刚输入就删除，撤销恢复的是最新内容；预览时 Esc 关闭；Backspace 不删除", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  await createDomain(sidebar, "甲");
  await domainRow(sidebar, "甲").click({ button: "right" });
  await page.locator("[data-new-field-note]").click();
  const panel = page.locator("[data-note-panel]");
  await expect(panel.locator(".cm-content")).toBeFocused();
  await page.keyboard.type("最后几个字");
  // 不等自动保存（0.5 秒），立即删除
  await panel.getByRole("button", { name: "删除笔记" }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "撤销" }).click();
  const row = sidebar.locator("[data-note-id]");
  await expect(row).toHaveText("最后几个字");

  // 焦点在行上按 Backspace：不删除
  await row.focus();
  await page.keyboard.press("Backspace");
  await expect(row).toHaveCount(1);
  // 预览时按 Esc 关闭，焦点回到这一行
  await row.click();
  await panel.getByRole("button", { name: "预览" }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(row).toBeFocused();
  // Delete 键删除
  await page.keyboard.press("Delete");
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("撤销 / 重做（⌘/Ctrl + Z、⌘/Ctrl + Shift + Z）：移动论文、新建领域；输入框里不拦截", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const sidebar = sidebarOf(page);
  await page.getByTestId("import-input").setInputFiles({ name: "u.pdf", mimeType: "application/pdf", buffer: await makePdf("Undo Me", "Ann") });
  const row = paperRows(sidebar).first();
  await expect(row).toBeVisible();
  await createDomain(sidebar, "甲");
  const jia = domainRow(sidebar, "甲");
  const domainsOfPaper = () => page.evaluate(async () => (await (window as any).__paperlens.db.papers.toArray())[0].domainIds);
  await page.waitForTimeout(400); // 让"新建领域"单独成为一步
  await row.dragTo(jia);
  await expect.poll(domainsOfPaper).toHaveLength(1);
  await page.waitForTimeout(400);

  // 焦点不在输入框里：撤销移动 → 回到未分类
  await page.locator("body").click({ position: { x: 900, y: 400 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(domainsOfPaper).toEqual([]);
  await expect(page.getByRole("status").filter({ hasText: "已撤销" })).toBeVisible();
  // 再撤销：新建领域和改名是一步，领域整个没了
  const domainCount = () => page.evaluate(() => (window as any).__paperlens.db.domains.count());
  await page.keyboard.press("ControlOrMeta+z");
  await expect(jia).toHaveCount(0);
  await expect.poll(domainCount).toBe(0);
  // 重做两次
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(jia).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(domainsOfPaper).toHaveLength(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.getByRole("status").filter({ hasText: "没有可重做的操作" })).toBeVisible();

  // 输入框里的 ⌘Z 交给输入框，不撤销数据
  const search = sidebar.getByRole("searchbox", { name: "全局搜索" });
  await search.fill("abc");
  await search.press("ControlOrMeta+z");
  await expect.poll(domainsOfPaper).toHaveLength(1);
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
  // 归入「方法」后从「未分类」移走；展开「方法」可见
  await expect(sidebar.locator("[data-unfiled]")).toHaveCount(0);
  await domainRow(sidebar, "方法").click();
  await expect(row).toContainText("A Better Title");
  await expect(row).toContainText("张三, 李四, 王五");
  await expect(row).toContainText("2020");

  await domainRow(sidebar, "方法").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除领域…" }).click();
  await expect(page.getByRole("dialog")).toContainText("1 篇论文将移出这些领域");
  await page.getByRole("button", { name: "删除领域" }).click();
  await expect(domainRow(sidebar, "方法")).toHaveCount(0);
  // 论文本身保留，回到「未分类」
  await expect(sidebar.locator("[data-unfiled]")).toContainText("1");
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
  await expect(sidebar.locator('[data-library-view="all"]')).toContainText("600");
  await expect(sidebar.locator("[data-unfiled]")).toContainText("600");
  expect(await paperRows(sidebar).count()).toBeLessThan(60); // 只渲染可视区域附近的行

  // 新论文按标题排在列表中部：导入后应滚动到它并高亮
  const pdf = await makePdf("Mmm Middle Of The List", "Carol Wu");
  await page.getByTestId("import-input").setInputFiles({ name: "middle.pdf", mimeType: "application/pdf", buffer: pdf });
  const row = paperRows(sidebar).filter({ hasText: "Mmm Middle Of The List" });
  await expect(row).toBeInViewport();
  await expect(row).toHaveClass(/ring-amber/);

  // 滚回顶部后再导入同一文件：重复 → 再次定位到它
  await sidebar.getByRole("tree").evaluate((el) => (el.scrollTop = 0));
  await expect(row).toHaveCount(0);
  await page.getByTestId("import-input").setInputFiles({ name: "middle-copy.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByTestId("import-status")).toContainText("已在文库中");
  await expect(row).toBeInViewport();

  // 右键菜单（列表共用一个菜单）
  await row.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "编辑信息…" })).toBeVisible();
  await page.keyboard.press("Escape");

  // 拖到领域（领域在树的顶部：滚回顶部，拖「未分类」里靠前的一篇）
  await sidebar.getByRole("tree").evaluate((el) => (el.scrollTop = 0));
  const top = paperRows(sidebar).filter({ hasText: "A000 seeded paper" });
  await top.dragTo(domainRow(sidebar, "目标领域"));
  await expect(domainRow(sidebar, "目标领域")).toContainText("1");
  await expect(sidebar.locator("[data-unfiled]")).toContainText("600"); // 600 + 1 篇导入 − 1 篇移走
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
