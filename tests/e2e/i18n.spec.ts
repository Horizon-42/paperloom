/// <reference lib="dom" />
// 界面多语言：英文浏览器默认英文界面，走一遍各视图和常用弹层，界面上（文字和 title/aria-label/placeholder）不能出现中文；
// 切换到中文再切回英文。测试数据（fixtures 里的英文 PDF）本身不含中文，所以页面上出现的中文都来自界面文案。
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const simplePdf = fileURLToPath(new URL("../../fixtures/simple.pdf", import.meta.url));

/** 页面上可见的中文：文字节点和 title / aria-label / placeholder / alt */
function cjkOnPage(): string[] {
  const CJK = /[　-〿㐀-鿿＀-￯]/;
  const out = new Set<string>();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? "";
    if (CJK.test(text) && n.parentElement && visible(n.parentElement)) out.add(`${n.parentElement.tagName.toLowerCase()}: ${text.trim().slice(0, 80)}`);
  }
  // 下拉框的选项不可见时也算（展开后就会显示）
  for (const o of Array.from(document.querySelectorAll("option"))) {
    if (CJK.test(o.textContent ?? "")) out.add(`option: ${(o.textContent ?? "").trim().slice(0, 80)}`);
  }
  for (const el of Array.from(document.querySelectorAll("[title],[aria-label],[placeholder],[alt]"))) {
    for (const a of ["title", "aria-label", "placeholder", "alt"]) {
      const v = el.getAttribute(a);
      if (v && CJK.test(v)) out.add(`${el.tagName.toLowerCase()}[${a}]: ${v.slice(0, 80)}`);
    }
  }
  if (CJK.test(document.title)) out.add(`<title>: ${document.title}`);
  return [...out];
}

async function expectNoCjk(page: Page, where: string) {
  const found = await page.evaluate(cjkOnPage);
  expect(found, `${where} 出现中文`).toEqual([]);
}

const tabs = (page: Page) => page.locator('[data-testid="library-sidebar"] [role="tablist"] [role="tab"]');

/** 在文字片段中间横向拖选，出现选区工具栏 */
async function selectInSpan(page: Page, span: ReturnType<Page["locator"]>) {
  const b = (await span.boundingBox())!;
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + b.width * 0.1, y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("[data-annotation-toolbar]")).toBeVisible();
}

async function openFixture(page: Page) {
  await page.getByTestId("import-input").setInputFiles(simplePdf);
  const row = page.locator("[data-library-sidebar] [data-paper-id]");
  await expect(row).toHaveCount(1);
  await row.click();
  const word = page.locator(".textLayer span").filter({ hasText: /\w{6,}/ }).first();
  await expect(word).toBeVisible();
  return { row, word };
}

test.describe("英文界面", () => {
  test.use({ locale: "en-US" });

  test("浏览器是英文时默认英文；各视图和弹层里没有中文", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("library-sidebar")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");
    await expect(page.getByTestId("storage-status")).toHaveAttribute("data-phase", "offline");
    await expectNoCjk(page, "空文库");

    const { row, word } = await openFixture(page);
    await expectNoCjk(page, "阅读器");

    // 选区工具栏 → 设为术语：术语编辑器
    await selectInSpan(page, word);
    await expectNoCjk(page, "选区工具栏");
    await page.locator('[data-annotation-toolbar] [data-action="term"]').click();
    await expect(page.locator("[data-term-editor]")).toBeVisible();
    await expectNoCjk(page, "术语编辑器");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-term-editor]")).toHaveCount(0);

    // 选区工具栏 → 高亮
    await selectInSpan(page, word);
    await page.locator("[data-annotation-toolbar] [data-color]").first().click();
    await expect(page.locator(".pl-hl")).toHaveCount(1);
    await expectNoCjk(page, "高亮之后");

    // 论文右键菜单
    await row.click({ button: "right" });
    await expect(page.locator('[role="menu"]')).toBeVisible();
    await expectNoCjk(page, "论文右键菜单");
    await page.keyboard.press("Escape");

    // 项目菜单
    await page.getByTestId("project-switcher").click();
    await expect(page.getByTestId("project-menu")).toBeVisible();
    await expectNoCjk(page, "项目菜单");
    await page.keyboard.press("Escape");

    // 数据与备份
    await page.getByTestId("storage-status").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoCjk(page, "数据与备份对话框");
    await page.keyboard.press("Escape");

    // 其他主视图：术语表、批注、画布
    const n = await tabs(page).count();
    for (let i = 1; i < n; i++) {
      await tabs(page).nth(i).click();
      await expect(tabs(page).nth(i)).toHaveAttribute("aria-selected", "true");
      await page.waitForTimeout(500);
      await expectNoCjk(page, `主视图 ${i}`);
    }

    // 画布：新建对话框、新建后的画布
    await expect(page.locator("[data-create-first-board]")).toBeVisible();
    await page.locator("[data-create-first-board]").click();
    const nameInput = page.locator('[data-canvas-dialog="board-name"] input');
    await expect(nameInput).toBeVisible();
    await expectNoCjk(page, "新建画布对话框");
    await nameInput.fill("Board A");
    await nameInput.press("Enter");
    await expect(page.locator("[data-canvas-flow]")).toBeVisible();
    await page.waitForTimeout(500);
    await expectNoCjk(page, "画布");
  });

  test("切换到中文、再切回英文；选择在重新加载后保留", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("library-sidebar")).toBeVisible();

    await page.getByTestId("language-switcher").click();
    await page.locator('[data-testid="language-menu"] [data-locale="zh"]').click();
    // 切换会重新加载页面：等新页面的 <html lang>
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByTestId("library-sidebar")).toBeVisible();
    expect((await page.evaluate(cjkOnPage)).length).toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByTestId("library-sidebar")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");

    await page.getByTestId("language-switcher").click();
    await page.locator('[data-testid="language-menu"] [data-locale="en"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByTestId("library-sidebar")).toBeVisible();
    await expectNoCjk(page, "切回英文后");
  });

  test("?lang=zh 指定语言并记住", async ({ page }) => {
    await page.goto("/?lang=zh");
    await expect(page.getByTestId("library-sidebar")).toBeVisible();
    expect(await page.evaluate(() => [document.documentElement.lang, localStorage.getItem("paperlens.locale")])).toEqual(["zh-CN", "zh"]);
  });
});

test.describe("中文界面", () => {
  test.use({ locale: "zh-CN" });

  test("浏览器是中文时默认中文", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("library-sidebar")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
    expect((await page.evaluate(cjkOnPage)).length).toBeGreaterThan(0);
  });
});
