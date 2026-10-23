// 引用数（D17）：第一次查询前的说明、从 PDF 识别 DOI、按标题匹配取正式版、批量查询与额度用完、按引用数排序、编辑 DOI。
// OpenAlex 的请求全部由 page.route 拦截，不会真的联网。
import { expect, test, type Page, type Route } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

async function makePdf(title: string, author: string, firstPageLines: string[] = []): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor(author);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(title, { x: 72, y: 760, size: 14, font });
  firstPageLines.forEach((l, i) => page.drawText(l, { x: 72, y: 720 - i * 20, size: 10, font }));
  return Buffer.from(await doc.save());
}

const work = (id: string, title: string, count: number, extra: Record<string, unknown> = {}) => ({
  id: `https://openalex.org/${id}`,
  display_name: title,
  publication_year: 2023,
  publication_date: "2023-01-01",
  cited_by_count: count,
  doi: null,
  type: "article",
  primary_location: { version: "publishedVersion", source: { type: "journal" } },
  authorships: [],
  ...extra,
});

interface Mock {
  dois: Record<string, unknown>;
  titles: Record<string, unknown[]>;
  status?: number;
  requests: string[];
}

async function mockOpenAlex(page: Page, mock: Mock) {
  await page.route("https://api.openalex.org/**", (route: Route) => {
    const url = new URL(route.request().url());
    mock.requests.push(decodeURIComponent(url.pathname + url.search));
    if (mock.status) return route.fulfill({ status: mock.status, body: "quota" });
    const doi = /\/works\/doi:(.+)$/.exec(decodeURIComponent(url.pathname))?.[1];
    if (doi) return mock.dois[doi] ? route.fulfill({ json: mock.dois[doi] }) : route.fulfill({ status: 404, body: "" });
    const q = (url.searchParams.get("filter") ?? "").replace(/^title\.search:/, "");
    return route.fulfill({ json: { results: mock.titles[q] ?? [] } });
  });
}

const sidebarOf = (page: Page) => page.getByTestId("library-sidebar");
const row = (page: Page, title: string) => sidebarOf(page).locator("[data-paper-id]", { hasText: title }).first();
const paperBy = (page: Page, title: string) =>
  page.evaluate(async (title) => (await (window as any).__paperlens.db.papers.toArray()).find((p: any) => p.title === title), title);

async function importPdfs(page: Page, files: { name: string; buffer: Buffer }[]) {
  await page.getByTestId("import-input").setInputFiles(files.map((f) => ({ ...f, mimeType: "application/pdf" })));
  await expect(page.getByTestId("import-status")).toContainText(`${files.length}`);
}

test("单篇：第一次先说明；从 PDF 第一页识别 DOI 并核对标题；结果显示在行上和编辑信息里", async ({ page }) => {
  const mock: Mock = {
    requests: [],
    dois: { "10.1234/rope.2023": work("W100", "Rotary Embeddings for Everyone", 1934, { doi: "https://doi.org/10.1234/rope.2023" }) },
    titles: {},
  };
  await mockOpenAlex(page, mock);
  await page.goto("/");
  await importPdfs(page, [{ name: "rope.pdf", buffer: await makePdf("Rotary Embeddings for Everyone", "Jianlin Su", ["https://doi.org/10.1234/rope.2023"]) }]);
  const r = row(page, "Rotary Embeddings");
  await expect(r).toBeVisible();

  await r.click({ button: "right" });
  await page.locator("[data-query-citations]").click();
  // 说明：会发什么、发给谁；确认前没有任何请求
  const consent = page.locator("[data-citation-consent]");
  await expect(consent).toContainText("OpenAlex");
  await expect(consent).toContainText("不会发送 PDF");
  expect(mock.requests).toEqual([]);
  await consent.getByRole("button", { name: "查询" }).click();

  await expect(r.locator("[data-citations]")).toHaveText("被引 1934");
  await expect(page.getByRole("status").filter({ hasText: "被引 1,934 次" })).toBeVisible();
  const p = await paperBy(page, "Rotary Embeddings for Everyone");
  expect(p.doi).toBe("10.1234/rope.2023");
  expect(p.citations).toMatchObject({ status: "found", count: 1934, matchedBy: "doi", workId: "W100" });
  // 只按 DOI 查了一次，没有做标题搜索
  expect(mock.requests).toEqual([expect.stringContaining("/works/doi:10.1234/rope.2023")]);

  // 同意过之后不再提示；编辑信息里显示详情和 DOI
  await r.click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑信息" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("#paper-doi")).toHaveValue("10.1234/rope.2023");
  await expect(dialog.locator("[data-citation-detail]")).toContainText("被引 1,934 次");
  await expect(dialog.locator("[data-citation-detail]")).toContainText("按 DOI 查到");
  await expect(dialog.getByRole("link", { name: "在 OpenAlex 查看" })).toHaveAttribute("href", "https://openalex.org/works/W100");
});

test("编辑信息：DOI 校验与规范化；查询前先保存改过的 DOI；没有 DOI 按标题匹配取正式版", async ({ page }) => {
  const title = "Train Short Test Long Attention with Linear Biases";
  const mock: Mock = {
    requests: [],
    dois: { "10.5555/alibi": work("W7", title, 77, { doi: "https://doi.org/10.5555/alibi" }) },
    titles: {
      [title]: [
        work("W1", title, 300, { type: "preprint", publication_date: "2021-08-27", primary_location: { source: { type: "repository" } } }),
        work("W2", title, 512, { publication_date: "2022-04-25", doi: "https://doi.org/10.5555/iclr" }),
        work("W3", "Something Else Entirely", 9999),
      ],
    },
  };
  await mockOpenAlex(page, mock);
  await page.goto("/");
  // 跳过说明
  await page.evaluate(() => localStorage.setItem("paperlens.citations.consent", "1"));
  await importPdfs(page, [{ name: "alibi.pdf", buffer: await makePdf(title, "Ofir Press") }]);
  const r = row(page, "Train Short");
  await r.click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑信息" }).click();
  const dialog = page.getByRole("dialog");
  const detail = dialog.locator("[data-citation-detail]");
  await expect(detail).toContainText("还没有查询");

  // 按标题：取正式发表的版本（W2），不取预印本和标题不同的
  await detail.getByRole("button", { name: "查询引用数" }).click();
  await expect(detail).toContainText("被引 512 次");
  await expect(detail).toContainText(`按标题匹配到「${title}」 · 2023`);
  expect((await paperBy(page, title)).doi).toBeUndefined();

  // DOI 格式不对：提示，保存按钮不可用
  const doi = dialog.locator("#paper-doi");
  await doi.fill("not a doi");
  await expect(dialog).toContainText("不像 DOI");
  await expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();
  // 带前缀的 DOI：查询前先保存（规范化）再按 DOI 查
  await doi.fill("https://doi.org/10.5555/ALIBI");
  await detail.getByRole("button", { name: "重新查询" }).click();
  await expect(detail).toContainText("被引 77 次");
  await expect(detail).toContainText("按 DOI 查到");
  expect((await paperBy(page, title)).doi).toBe("10.5555/alibi");
  // 保存表单不会把 DOI 改回去
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  expect((await paperBy(page, title)).doi).toBe("10.5555/alibi");
});

test("批量查询：跳过最近查过的；进度与结果；额度用完时停止并说明；按引用数排序", async ({ page }) => {
  const mock: Mock = {
    requests: [],
    dois: {},
    titles: {
      "Alpha Paper About Graphs": [work("WA", "Alpha Paper About Graphs", 10)],
      "Beta Paper About Trees": [work("WB", "Beta Paper About Trees", 2000)],
    },
  };
  await mockOpenAlex(page, mock);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("paperlens.citations.consent", "1"));
  await importPdfs(page, [
    { name: "a.pdf", buffer: await makePdf("Alpha Paper About Graphs", "Ann") },
    { name: "b.pdf", buffer: await makePdf("Beta Paper About Trees", "Ben") },
    { name: "c.pdf", buffer: await makePdf("Gamma Paper Nobody Indexed", "Cid") },
  ]);
  await expect(sidebarOf(page).locator("[data-paper-id]")).toHaveCount(3);

  const sortButton = sidebarOf(page).getByRole("button", { name: /^排序/ });
  await sortButton.click();
  await page.locator("[data-query-all-citations]").click();
  const status = page.getByTestId("citation-status");
  await expect(status).toContainText("引用数：查到 2 篇，1 篇没找到");
  await expect(row(page, "Beta").locator("[data-citations]")).toHaveText("被引 2000");
  expect((await paperBy(page, "Gamma Paper Nobody Indexed")).citations.status).toBe("notFound");

  // 按引用数排序：多的在前，没有的在最后
  await page.locator('[data-library-view="all"]').click();
  await sortButton.click();
  await page.getByRole("menuitemradio", { name: "引用数" }).click();
  await expect(sidebarOf(page).locator("[data-paper-id]")).toHaveText([/Beta/, /Alpha/, /Gamma/]);

  // 再批量查：都在最近查过，不发请求
  const before = mock.requests.length;
  await sortButton.click();
  await page.locator("[data-query-all-citations]").click();
  await expect(page.getByRole("status").filter({ hasText: "所有论文的引用数都在最近查过" })).toBeVisible();
  expect(mock.requests.length).toBe(before);

  // 额度用完：停止，说明原因，没查的论文保持原样
  await page.evaluate(async () => {
    const { db } = (window as any).__paperlens;
    await db.papers.toCollection().modify((p: any) => delete p.citations);
  });
  mock.status = 429;
  await sortButton.click();
  await page.locator("[data-query-all-citations]").click();
  await expect(status).toContainText("OpenAlex 今日的免费额度用完了，还有 3 篇没查");
  expect((await paperBy(page, "Alpha Paper About Graphs")).citations).toBeUndefined();
});

test("编辑信息：DOI 留空时查询，识别出的 DOI 显示在框里，保存不会把它清掉；改 DOI 清掉旧的引用数", async ({ page }) => {
  const title = "Rotary Embeddings for Everyone";
  const mock: Mock = {
    requests: [],
    dois: { "10.1234/rope.2023": work("W100", title, 1934, { doi: "https://doi.org/10.1234/rope.2023" }) },
    titles: {},
  };
  await mockOpenAlex(page, mock);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("paperlens.citations.consent", "1"));
  await importPdfs(page, [{ name: "rope.pdf", buffer: await makePdf(title, "Jianlin Su", ["doi: 10.1234/rope.2023"]) }]);
  await row(page, "Rotary").click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑信息" }).click();
  const dialog = page.getByRole("dialog");
  const doi = dialog.locator("#paper-doi");
  await expect(doi).toHaveValue("");
  await dialog.locator("[data-citation-detail]").getByRole("button", { name: "查询引用数" }).click();
  await expect(dialog.locator("[data-citation-detail]")).toContainText("被引 1,934 次");
  await expect(doi).toHaveValue("10.1234/rope.2023");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  expect((await paperBy(page, title)).doi).toBe("10.1234/rope.2023");

  // 改 DOI 保存：旧的引用数清掉
  await row(page, "Rotary").click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑信息" }).click();
  await doi.fill("10.1234/other");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  const p = await paperBy(page, title);
  expect(p.doi).toBe("10.1234/other");
  expect(p.citations).toBeUndefined();
  await expect(row(page, "Rotary").locator("[data-citations]")).toHaveCount(0);
});
