// 在线版冒烟测试：子路径部署、没有本地存储服务时，导入 PDF → 高亮 → 刷新后仍在；首次提示可以关掉且不再出现；
// pdf.js 附属资源的地址（中文 CMap）。
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const simplePdf = fileURLToPath(new URL("../../fixtures/simple.pdf", import.meta.url));
const cjkPdf = fileURLToPath(new URL("../../fixtures/cjk.pdf", import.meta.url));

test("在线版：导入、高亮、刷新后仍在", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    // 探测本地服务的请求本来就会 404
    if (r.status() >= 400 && !r.url().includes("/__paperlens/")) errors.push(`${r.status()} ${r.url()}`);
  });

  await page.goto("/paperlens/");
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-phase", "offline");
  await expect(page.getByTestId("browser-only-hint")).toBeVisible();

  await page.getByTestId("import-input").setInputFiles(simplePdf);
  const row = page.locator("[data-library-sidebar] [data-paper-id]");
  await expect(row).toHaveCount(1);
  await row.click();

  const word = page.locator(".textLayer span").filter({ hasText: /\w{6,}/ }).first();
  await expect(word).toBeVisible();
  // 在一个文本片段中间横向拖选
  const b = (await word.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + b.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("[data-annotation-toolbar]")).toBeVisible();
  await page.locator("[data-annotation-toolbar] [data-color]").first().click();
  await expect(page.locator(".pl-hl")).toHaveCount(1);

  await page.getByTestId("browser-only-hint").getByRole("button", { name: "知道了" }).click();
  await expect(page.getByTestId("browser-only-hint")).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-phase", "offline");
  await expect(page.getByTestId("browser-only-hint")).toHaveCount(0);
  await page.locator("[data-library-sidebar] [data-paper-id]").click();
  await expect(page.locator(".pl-hl")).toHaveCount(1);

  expect(errors).toEqual([]);
});

// pdf.js 的附属资源（cmaps、wasm、标准字体）由它的 Worker 下载：地址必须按页面而不是 Worker 脚本解析
test("在线版：不嵌入字体的中文 PDF 能从 pdfjs/cmaps/ 取到 CMap，文字层正常", async ({ page }) => {
  const failed: string[] = [];
  const cmaps: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/cmaps/")) cmaps.push(`${r.status()} ${new URL(r.url()).pathname}`);
    if (r.status() >= 400 && !r.url().includes("/__paperlens/")) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.goto("/paperlens/");
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-phase", "offline");
  await page.getByTestId("import-input").setInputFiles(cjkPdf);
  await page.locator("[data-library-sidebar] [data-paper-id]").click();
  await expect(page.locator(".textLayer")).toContainText("\u4e2d\u6587\u8bba\u6587"); // 中文论文
  expect(cmaps).toContain("200 /paperlens/pdfjs/cmaps/UniGB-UCS2-H.bcmap");
  expect(failed).toEqual([]);
});
