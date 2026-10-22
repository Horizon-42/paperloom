// 论文标签：侧栏行上的标签、加标签的各种入口（行按钮 / T / 右键菜单 / 阅读器工具栏）、编辑信息对话框、
// 标签筛选（多选 AND、与领域叠加、刷新后保留）、管理标签（改名、合并、删除）、不等高行的虚拟列表、输入法组字。
// npx playwright test -c tests/e2e/tags.config.ts；PAPERLENS_SHOTS_DIR=<目录> 时保存截图
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { addPaper, fixtureBytes, pane, waitRendered } from "./viewerHelpers";

const SHOTS = process.env.PAPERLENS_SHOTS_DIR;

interface SeedPaper {
  id: string;
  title: string;
  tags?: string[];
  domainIds?: string[];
  addedAt?: number;
}

/** 收集页面错误和 console.error（含 React / Radix 的告警），测试末尾断言为空 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || (m.type() === "warning" && /radix|react/i.test(m.text()))) errors.push(m.text());
  });
  return errors;
}

/** 打开应用，切到「全部论文」平铺列表（行上显示标签；按领域浏览的用例自己切回去） */
async function boot(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__paperlens?.useLibraryStore);
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setView("all"));
}

async function seed(page: Page, papers: SeedPaper[], domains: { id: string; name: string }[] = []) {
  await page.evaluate(
    async ({ papers, domains }) => {
      const { db } = (window as any).__paperlens;
      if (domains.length)
        await db.domains.bulkAdd(domains.map((d, i) => ({ ...d, parentId: null, color: "#3b82f6", order: i })));
      await db.papers.bulkAdd(
        papers.map((p, i) => ({
          fileHash: `hash-${p.id}`,
          authors: ["Ada Lovelace"],
          domainIds: [],
          pageCount: 1,
          addedAt: 1_000 + (papers.length - i), // 默认按添加时间倒序：与传入顺序一致
          ...p,
        })),
      );
    },
    { papers, domains },
  );
}

const sidebarOf = (page: Page) => page.getByTestId("library-sidebar");
const rowOf = (sidebar: Locator, id: string) => sidebar.locator(`[role="option"][data-paper-id="${id}"]`);
const editorOf = (page: Page, id: string) => page.locator(`[data-tag-editor="${id}"]`);
const tagInputOf = (editor: Locator) => editor.getByRole("combobox", { name: "添加标签" });
const tagsOf = (page: Page, id: string) =>
  page.evaluate(async (id) => ((await (window as any).__paperlens.db.papers.get(id))?.tags ?? null) as string[] | null, id);
const filterOf = (page: Page) => page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().tagFilter as string[]);

test("row button opens the editor: autocomplete an existing tag, create a new one, search shows tags", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await seed(page, [
    { id: "a", title: "Alpha: attention is all you need", tags: ["深度学习", "Transformer"] },
    { id: "b", title: "Beta: convolutional networks", tags: ["深度学习"] },
    { id: "c", title: "Gamma: a paper without tags" },
  ]);
  const sidebar = sidebarOf(page);
  const row = rowOf(sidebar, "c");
  await expect(row).toBeVisible();
  await expect(rowOf(sidebar, "a").locator("[data-tag-chip]")).toHaveText(["深度学习", "Transformer"]);
  await expect(row.locator("[data-tag-chip]")).toHaveCount(0);

  await row.hover();
  const button = row.getByRole("button", { name: "编辑标签（T）" });
  await expect(button).toBeVisible();
  await button.click();
  const editor = editorOf(page, "c");
  await expect(editor).toBeVisible();
  const input = tagInputOf(editor);
  await expect(input).toBeFocused();
  // 编辑器在行的右侧，不挡住列表
  const rb = (await row.boundingBox())!;
  const eb = (await editor.boundingBox())!;
  expect(eb.x).toBeGreaterThanOrEqual(rb.x + rb.width);
  expect(eb.y).toBeLessThan(rb.y + rb.height); // 与行在同一高度（靠近窗口底部时会被往上推）
  expect(eb.y + eb.height).toBeGreaterThan(rb.y);
  // 没打论文本身
  expect(await page.evaluate(() => (window as any).__paperlens.useReaderStore.getState().panes[0].activePaperId)).toBeNull();

  // 输入为空时列出已有标签（按论文数从多到少）
  await expect(editor.getByRole("option")).toHaveText([/^深度学习/, /^Transformer/]);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "tags-editor-open.png"), clip: { x: 0, y: 300, width: 640, height: 600 } });
  await input.fill("深");
  await expect(editor.getByRole("option")).toHaveCount(2); // 深度学习 + 新建「深」
  await expect(editor.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(editor.locator("[data-tag]")).toHaveText(["深度学习"]);
  await expect.poll(() => tagsOf(page, "c")).toEqual(["深度学习"]);
  await expect(input).toHaveValue("");

  // 新建：只剩"新建标签「…」"一项，回车创建
  await input.fill("待读");
  await expect(editor.getByRole("option")).toHaveText(["新建标签「待读」"]);
  await input.press("Enter");
  await expect.poll(() => tagsOf(page, "c")).toEqual(["深度学习", "待读"]);

  // ↑/↓ 移动高亮：输入 "trans" → Transformer、新建「trans」；↓ 到新建，回车创建原样的 "trans"
  await input.fill("trans");
  await expect(editor.getByRole("option")).toHaveText([/^Transformer/, "新建标签「trans」"]);
  await input.press("ArrowDown");
  await expect(editor.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowUp");
  await input.press("Enter"); // 回到第一项：Transformer（沿用已有的大小写）
  await expect.poll(() => tagsOf(page, "c")).toEqual(["深度学习", "待读", "Transformer"]);
  // 大小写不同视为同一个标签：已有时提示，不重复添加
  await input.fill("transformer");
  await expect(editor).toContainText("已经有「transformer」了");
  await input.press("Enter");
  await expect.poll(() => tagsOf(page, "c")).toEqual(["深度学习", "待读", "Transformer"]);

  await expect(row.locator("[data-tag-chip]")).toHaveText(["深度学习", "待读", "Transformer"]);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "tags-editor-after.png"), clip: { x: 0, y: 300, width: 640, height: 600 } });

  // Esc 关闭，焦点回到行上
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(row).toBeFocused();

  // 再点一次按钮：打开，再点：关闭
  await row.hover();
  await button.click();
  await expect(editor).toBeVisible();
  await button.click();
  await expect(editor).toBeHidden();

  // 按钮在作者行末尾，不盖住标题（当前论文的行上它一直显示，位置相同）
  const longRow = rowOf(sidebar, "a");
  await page.evaluate(() => (window as any).__paperlens.db.papers.update("a", { title: "A very long title that certainly wraps onto a second line in the sidebar list" }));
  await longRow.hover();
  const longButton = longRow.getByRole("button", { name: "编辑标签（T）" });
  await expect(longButton).toHaveCSS("opacity", "1");
  const titleBox = (await longRow.locator("div.line-clamp-2").boundingBox())!;
  const buttonBox = (await longButton.boundingBox())!;
  expect(buttonBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 0.5);
  expect(Math.round((await longRow.boundingBox())!.height)).toBe(91); // 行高不变
  await expect(longRow).toHaveAttribute("aria-keyshortcuts", "T");

  // 搜索：标签参与匹配，"#xx" 只搜标签；搜索结果里的行也显示标签
  const search = sidebar.getByRole("searchbox", { name: "全局搜索" });
  await search.fill("#待读");
  const group = sidebar.getByRole("group", { name: "论文" });
  await expect(group.locator("[role=option]")).toHaveCount(1);
  await expect(group.locator("[data-paper-id='c'] [data-tag-chip]")).toHaveText(["深度学习", "待读", "Transformer"]);
  const hitBox = (await group.locator("[data-paper-id='c']").boundingBox())!;
  expect(Math.round(hitBox.height)).toBe(91);
  await search.fill("");
  expect(errors).toEqual([]);
});

test("keyboard T on a focused row, separators, paste, backspace, context menu", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await seed(page, [
    { id: "a", title: "Alpha paper", tags: ["existing"] },
    { id: "c", title: "Gamma paper" },
  ]);
  const sidebar = sidebarOf(page);
  const row = rowOf(sidebar, "c");
  await row.focus();
  await page.keyboard.press("t");
  const editor = editorOf(page, "c");
  const input = tagInputOf(editor);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(""); // T 本身没有被输入

  // 逗号（键盘）与全角分号（直接插入文字）都提交
  await page.keyboard.type("alpha,beta；");
  await expect.poll(() => tagsOf(page, "c")).toEqual(["alpha", "beta"]);
  await expect(input).toHaveValue("");

  // 粘贴多个
  await input.evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, "x, y，z;existing");
  await expect.poll(() => tagsOf(page, "c")).toEqual(["alpha", "beta", "x", "y", "z", "existing"]);

  // 输入框为空时退格：第一次只选中最后一个，第二次才移除；打字或别的键取消选中
  const chip = (t: string) => editor.locator(`[data-tag="${t}"]`);
  await input.press("Backspace");
  await expect(chip("existing")).toHaveAttribute("data-selected", "true");
  await page.waitForTimeout(100);
  expect(await tagsOf(page, "c")).toEqual(["alpha", "beta", "x", "y", "z", "existing"]);
  await input.press("ArrowLeft");
  await expect(chip("existing")).not.toHaveAttribute("data-selected", "true");
  await input.press("Backspace");
  await expect(chip("existing")).toHaveAttribute("data-selected", "true");
  await input.press("Backspace");
  await expect.poll(() => tagsOf(page, "c")).toEqual(["alpha", "beta", "x", "y", "z"]);
  await expect(chip("z")).not.toHaveAttribute("data-selected", "true");
  await input.press("Backspace");
  await expect(chip("z")).toHaveAttribute("data-selected", "true");
  await page.keyboard.type("q");
  await expect(chip("z")).not.toHaveAttribute("data-selected", "true");
  await input.fill("");

  // 按住退格（自动重复）：删完文字后不删标签
  await page.keyboard.type("abc");
  await page.keyboard.down("Backspace");
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(30);
    await page.keyboard.down("Backspace"); // 已按下时再 down 即为自动重复（repeat: true）
  }
  await page.keyboard.up("Backspace");
  await expect(input).toHaveValue("");
  await page.waitForTimeout(150);
  expect(await tagsOf(page, "c")).toEqual(["alpha", "beta", "x", "y", "z"]);

  // × 删除指定的（鼠标）；键盘 Tab 到 × 上按回车也行，焦点回到输入框
  await editor.getByRole("button", { name: "移除标签「x」" }).click();
  await expect.poll(() => tagsOf(page, "c")).toEqual(["alpha", "beta", "y", "z"]);
  await expect(input).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(editor.getByRole("button", { name: "移除标签「z」" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => tagsOf(page, "c")).toEqual(["alpha", "beta", "y"]);
  await expect(input).toBeFocused();

  // 空输入框回车：关闭，焦点回到行
  await input.press("Enter");
  await expect(editor).toBeHidden();
  await expect(row).toBeFocused();

  // 右键菜单「标签…」
  await row.click({ button: "right" });
  const item = page.getByRole("menuitem", { name: /^标签…/ });
  await expect(item).toContainText("T");
  await item.click();
  await expect(editor).toBeVisible();
  await expect(input).toBeFocused();
  await page.waitForTimeout(300); // 菜单关闭后焦点没有被抢走
  await expect(editor).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.type("from-menu");
  await page.keyboard.press("Enter");
  await expect.poll(() => tagsOf(page, "c")).toEqual(["alpha", "beta", "y", "from-menu"]);

  // 点别处关闭（焦点不抢回）
  await sidebar.getByRole("searchbox", { name: "全局搜索" }).click();
  await expect(editor).toBeHidden();
  await expect(sidebar.getByRole("searchbox", { name: "全局搜索" })).toBeFocused();

  // 论文被删除时编辑器关闭
  await row.focus();
  await page.keyboard.press("t");
  await expect(editor).toBeVisible();
  await page.evaluate(() => (window as any).__paperlens.db.papers.delete("c"));
  await expect(editor).toBeHidden();
  expect(errors).toEqual([]);
});

test("default highlight: only an exact or prefix match, otherwise 新建; hidden suggestions → Enter adds the typed text", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await seed(page, [
    { id: "a", title: "Alpha paper", tags: ["强化学习", "学习理论", "Deep Learning"] },
    { id: "b", title: "Beta paper" },
    { id: "c", title: "Gamma paper" },
  ]);
  const sidebar = sidebarOf(page);
  await rowOf(sidebar, "b").focus();
  await page.keyboard.press("t");
  const editor = editorOf(page, "b");
  const input = tagInputOf(editor);
  const options = editor.getByRole("option");

  // 只有包含（不是开头）的已有标签：默认是"新建"，排在最前；回车新建输入的文字
  await input.fill("化学");
  await expect(options).toHaveText(["新建标签「化学」", /^强化学习/]);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect.poll(() => tagsOf(page, "b")).toEqual(["化学"]);

  // 有以输入开头的：它排最前并默认高亮；其余包含的在后，"新建"在最后
  await input.fill("学习");
  await expect(options).toHaveText([/^学习理论/, /^强化学习/, "新建标签「学习」"]);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  // ↑/↓ 仍可选任意一项
  await input.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect.poll(() => tagsOf(page, "b")).toEqual(["化学", "强化学习"]);
  // 不区分大小写的前缀
  await input.fill("deep");
  await expect(options.first()).toHaveText(/^Deep Learning/);
  await input.press("Enter");
  await expect.poll(() => tagsOf(page, "b")).toEqual(["化学", "强化学习", "Deep Learning"]);
  await page.keyboard.press("Escape");

  // 编辑信息对话框：Esc 收起建议后、或失焦再回来后，回车原样添加输入的文字
  await rowOf(sidebar, "c").click({ button: "right" });
  await page.getByRole("menuitem", { name: "编辑信息…" }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByRole("combobox", { name: /^标签/ });
  await field.fill("学");
  await expect(dialog.getByRole("option").first()).toHaveText(/^学习理论/);
  await field.press("Escape");
  await expect(dialog.getByRole("listbox", { name: "标签建议" })).toBeHidden();
  await field.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-tag]")).toHaveText(["学"]);
  await field.fill("学习");
  await dialog.getByLabel("年份").click();
  await field.focus();
  await expect(dialog.getByRole("listbox", { name: "标签建议" })).toBeHidden();
  await field.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-tag]")).toHaveText(["学", "学习"]);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => tagsOf(page, "c")).toEqual(["学", "学习"]);
  expect(errors).toEqual([]);
});

test("edit dialog only applies its own tag changes (a tag added in another tab meanwhile is kept)", async ({ context }) => {
  const a = await context.newPage();
  const errors = trackErrors(a);
  await boot(a);
  await seed(a, [{ id: "p", title: "Shared paper", tags: ["x", "old"] }]);
  const b = await context.newPage();
  await boot(b);

  await rowOf(sidebarOf(a), "p").click({ button: "right" });
  await a.getByRole("menuitem", { name: "编辑信息…" }).click();
  const dialog = a.getByRole("dialog");
  await expect(dialog.locator("[data-tag]")).toHaveText(["x", "old"]);

  // 另一个标签页加一个标签
  await rowOf(sidebarOf(b), "p").focus();
  await b.keyboard.press("t");
  await b.keyboard.type("y");
  await b.keyboard.press("Enter");
  await expect.poll(() => tagsOf(b, "p")).toEqual(["x", "old", "y"]);

  // 这边只改年份、去掉 old、加上 new，然后保存：y 保留
  await dialog.getByLabel("年份").fill("2020");
  await dialog.getByRole("button", { name: "移除标签「old」" }).click();
  await dialog.getByRole("combobox", { name: /^标签/ }).fill("new");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => tagsOf(a, "p")).toEqual(["x", "y", "new"]);
  expect(await a.evaluate(async () => (await (window as any).__paperlens.db.papers.get("p")).year)).toBe(2020);

  // 只改年份：标签原样
  await rowOf(sidebarOf(a), "p").click({ button: "right" });
  await a.getByRole("menuitem", { name: "编辑信息…" }).click();
  await a.getByRole("dialog").getByLabel("年份").fill("2021");
  await a.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await expect.poll(() => a.evaluate(async () => (await (window as any).__paperlens.db.papers.get("p")).year)).toBe(2021);
  expect(await tagsOf(a, "p")).toEqual(["x", "y", "new"]);
  expect(errors).toEqual([]);
});

test("IME: Enter and separators while composing never commit", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await seed(page, [{ id: "c", title: "Gamma paper" }]);
  const row = rowOf(sidebarOf(page), "c");
  await row.focus();
  await page.keyboard.press("t");
  const input = tagInputOf(editorOf(page, "c"));
  await expect(input).toBeFocused();

  // 真实的组字（CDP）：组字中按回车不提交
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "dai", selectionStart: 3, selectionEnd: 3 });
  await expect(input).toHaveValue("dai");
  await input.evaluate((el) => {
    (window as any).__keys = [];
    el.addEventListener("keydown", (e) => {
      const k = e as KeyboardEvent;
      (window as any).__keys.push({ key: k.key, composing: k.isComposing, code: k.keyCode });
    });
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 229 });
  await page.waitForTimeout(100);
  // 确认模拟的确实是组字中的按键
  const keys = await page.evaluate(() => (window as any).__keys as { composing: boolean; code: number }[]);
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.every((k) => k.composing || k.code === 229)).toBe(true);
  expect(await tagsOf(page, "c")).toBeNull();
  await cdp.send("Input.insertText", { text: "待读" }); // 输入法上屏
  await expect(input).toHaveValue("待读");
  expect(await tagsOf(page, "c")).toBeNull();
  await input.press("Enter");
  await expect.poll(() => tagsOf(page, "c")).toEqual(["待读"]);

  // 合成事件：组字中的回车（isComposing / keyCode 229）、组字中出现的全角逗号都不提交；组字结束后才按分隔符拆分
  await input.evaluate((el: HTMLInputElement) => {
    const setValue = (v: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    setValue("zong");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: "zong", inputType: "insertCompositionText" }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, keyCode: 229 } as KeyboardEventInit));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "，", bubbles: true, cancelable: true, isComposing: true }));
    setValue("综述，");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: "综述，", inputType: "insertCompositionText" }));
  });
  await page.waitForTimeout(100);
  expect(await tagsOf(page, "c")).toEqual(["待读"]);
  await expect(input).toHaveValue("综述，");
  await input.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "综述，" })));
  await expect.poll(() => tagsOf(page, "c")).toEqual(["待读", "综述"]);
  await expect(input).toHaveValue("");
  expect(errors).toEqual([]);
});

test("edit dialog: tags field is part of the form; cancel discards, save writes (including pending text)", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await seed(page, [
    { id: "a", title: "Alpha paper", tags: ["综述", "待读"] },
    { id: "b", title: "Beta paper", tags: ["深度学习"] },
  ]);
  const sidebar = sidebarOf(page);
  const row = rowOf(sidebar, "a");
  const openDialog = async () => {
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "编辑信息…" }).click();
    return page.getByRole("dialog");
  };

  let dialog = await openDialog();
  const field = dialog.getByRole("combobox", { name: /^标签/ });
  await expect(dialog.locator("[data-tag]")).toHaveText(["综述", "待读"]);
  await field.fill("深");
  await expect(dialog.getByRole("option")).toHaveText([/^深度学习/, "新建标签「深」"]);
  // Esc 先收起建议，不关闭对话框
  await field.press("Escape");
  await expect(dialog.getByRole("listbox", { name: "标签建议" })).toBeHidden();
  await expect(dialog).toBeVisible();
  await field.press("ArrowDown");
  await field.press("Enter"); // 选中深度学习，不提交表单
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "移除标签「综述」" }).click();
  await expect(dialog.locator("[data-tag]")).toHaveText(["待读", "深度学习"]);
  expect(await tagsOf(page, "a")).toEqual(["综述", "待读"]); // 还没保存
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  expect(await tagsOf(page, "a")).toEqual(["综述", "待读"]);

  dialog = await openDialog();
  await expect(dialog.locator("[data-tag]")).toHaveText(["综述", "待读"]);
  await dialog.getByRole("button", { name: "移除标签「待读」" }).click();
  const field2 = dialog.getByRole("combobox", { name: /^标签/ });
  await field2.fill("新方向");
  await field2.press("Enter");
  await field2.fill("未回车的");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => tagsOf(page, "a")).toEqual(["综述", "新方向", "未回车的"]);
  await expect(row.locator("[data-tag-chip]")).toHaveText(["综述", "新方向", "未回车的"]);

  // 空输入框回车提交表单
  dialog = await openDialog();
  await dialog.getByRole("button", { name: "移除标签「未回车的」" }).click();
  await dialog.getByRole("combobox", { name: /^标签/ }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(() => tagsOf(page, "a")).toEqual(["综述", "新方向"]);
  expect(errors).toEqual([]);
});

test("tag filter: chip click toggles, multiple tags AND, combines with domains, persists across reload", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await seed(
    page,
    [
      { id: "a", title: "Alpha paper", tags: ["x", "y"], domainIds: ["d1"] },
      { id: "b", title: "Beta paper", tags: ["x"] },
      { id: "c", title: "Gamma paper", tags: ["y"], domainIds: ["d1"] },
      { id: "d", title: "Delta paper" },
    ],
    [{ id: "d1", name: "方法论" }],
  );
  const sidebar = sidebarOf(page);
  const rows = sidebar.getByRole("listbox", { name: "全部论文" }).locator("[role=option]");
  await expect(rows).toHaveCount(4);

  // 点行上的标签：加入筛选，不打开论文
  await rowOf(sidebar, "a").locator("[data-tag-chip='x']").click();
  await expect.poll(() => filterOf(page)).toEqual(["x"]);
  expect(await page.evaluate(() => (window as any).__paperlens.useReaderStore.getState().panes[0].activePaperId)).toBeNull();
  await expect(rows).toHaveCount(2);
  await expect(rowOf(sidebar, "a").locator("[data-tag-chip='x']")).toHaveAttribute("aria-pressed", "true");
  const bar = sidebar.getByRole("group", { name: "标签筛选" });
  await expect(bar.locator("[data-tag]")).toHaveText(["x"]);

  // 筛选菜单：再选 y → 同时带有 x 和 y
  const menuButton = sidebar.getByRole("button", { name: /^按标签筛选/ });
  await menuButton.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemcheckbox")).toHaveText([/^x\s*2$/, /^y\s*2$/]);
  await expect(menu.getByRole("menuitemcheckbox", { name: /^x/ })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemcheckbox", { name: /^y/ }).click();
  await expect(menu).toBeVisible(); // 多选不关菜单
  await page.keyboard.press("Escape");
  await expect(rows).toHaveCount(1);
  await expect(rowOf(sidebar, "a")).toBeVisible();
  await expect(menuButton).toHaveAccessibleName("按标签筛选（已选 2 个）");
  if (SHOTS) await sidebar.screenshot({ path: join(SHOTS, "tags-filter.png") });

  // 刷新后保留
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__paperlens?.useLibraryStore);
  await expect(rows).toHaveCount(1);
  await expect(bar.locator("[data-tag]")).toHaveText(["x", "y"]);

  // 按领域浏览时与筛选叠加：只显示有匹配论文的领域（自动展开），「未分类」里没有匹配的就不显示
  await sidebar.locator('[data-library-view="tree"]').click();
  const tree = sidebar.getByRole("tree");
  await expect(tree.locator("[data-paper-id]")).toHaveCount(1);
  await expect(tree.locator('[data-paper-id="a"][data-parent-domain-id="d1"]')).toBeVisible();
  await expect(tree.locator("[data-unfiled]")).toHaveCount(0);
  // 筛选栏上去掉 y（键盘：Tab 到 × 上回车）：带 x 的还有未分类里的 b；焦点移到下一个按钮
  await bar.getByRole("button", { name: "取消按「x」筛选" }).focus();
  await page.keyboard.press("Tab");
  await expect(bar.getByRole("button", { name: "取消按「y」筛选" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(bar.getByRole("button", { name: "清除" })).toBeFocused();
  await expect(tree.locator("[data-paper-id]")).toHaveCount(2);
  await expect(tree.locator('[data-paper-id="b"][data-parent-domain-id=""]')).toBeVisible();
  // 清除筛选：领域回到原来的折叠状态，「未分类」里是 b 和 d
  await bar.getByRole("button", { name: "清除" }).click();
  await expect(bar).toBeHidden();
  await expect(tree.locator("[data-paper-id]")).toHaveCount(2);
  await expect(tree.locator('[data-parent-domain-id=""]')).toHaveCount(2);

  // 再点一次行上的标签：从筛选中去掉
  await sidebar.locator('[data-library-view="all"]').click();
  await rowOf(sidebar, "b").locator("[data-tag-chip='x']").click();
  await expect(rows).toHaveCount(2);
  await rowOf(sidebar, "b").locator("[data-tag-chip='x']").click();
  await expect(rows).toHaveCount(4);

  // 筛选里的标签被删掉后自动去掉
  await rowOf(sidebar, "c").locator("[data-tag-chip='y']").click();
  await expect.poll(() => filterOf(page)).toEqual(["y"]);
  await page.evaluate(async () => {
    const { db } = (window as any).__paperlens;
    await db.papers.update("a", { tags: ["x"] });
    await db.papers.update("c", { tags: undefined });
  });
  await expect.poll(() => filterOf(page)).toEqual([]);
  await expect(rows).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("manage tags: rename, merge into an existing tag, delete; filter stays consistent", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await seed(page, [
    { id: "a", title: "Alpha paper", tags: ["深度学习", "待读"] },
    { id: "b", title: "Beta paper", tags: ["Deep Learning"] },
    { id: "c", title: "Gamma paper", tags: ["待读"] },
  ]);
  const sidebar = sidebarOf(page);
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setTagFilter(["待读"]));
  await sidebar.getByRole("button", { name: /^按标签筛选/ }).click();
  await page.getByRole("menuitem", { name: "管理标签…" }).click();
  const dialog = page.getByRole("dialog", { name: "管理标签" });
  await expect(dialog).toBeVisible();
  const item = (name: string) => dialog.locator(`[data-manage-tag="${name}"]`);
  await expect(dialog.locator("[data-manage-tag]")).toHaveCount(3);
  await expect(item("待读")).toContainText("2 篇");

  // 改名；Esc 只取消改名
  await dialog.getByRole("button", { name: "重命名「待读」" }).click();
  const renameInput = dialog.getByRole("textbox", { name: "「待读」的新名称" });
  await expect(renameInput).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(renameInput).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "重命名「待读」" }).click();
  await renameInput.fill("待看");
  await renameInput.press("Enter");
  await expect(item("待看")).toContainText("2 篇");
  await expect.poll(() => tagsOf(page, "a")).toEqual(["深度学习", "待看"]);
  await expect.poll(() => tagsOf(page, "c")).toEqual(["待看"]);
  await expect.poll(() => filterOf(page)).toEqual(["待看"]);
  await expect(dialog.getByRole("status")).toContainText("改名为「待看」");

  // 改成已有的标签：提示合并
  await dialog.getByRole("button", { name: "重命名「Deep Learning」" }).click();
  await dialog.getByRole("textbox", { name: "「Deep Learning」的新名称" }).fill("深度学习");
  await expect(dialog).toContainText("已有标签「深度学习」（1 篇论文），保存后两者合并为一个。");
  await dialog.getByRole("button", { name: "合并" }).click();
  await expect(item("深度学习")).toContainText("2 篇");
  await expect(item("Deep Learning")).toHaveCount(0);
  await expect.poll(() => tagsOf(page, "b")).toEqual(["深度学习"]);

  // 删除：确认里显示论文数；论文保留
  await dialog.getByRole("button", { name: "删除「待看」" }).click();
  await expect(item("待看")).toContainText("从 2 篇论文上删除「待看」？");
  await item("待看").getByRole("button", { name: "删除" }).click();
  await expect(item("待看")).toHaveCount(0);
  await expect.poll(() => tagsOf(page, "c")).toBeNull();
  await expect.poll(() => filterOf(page)).toEqual([]);
  await expect(dialog.locator("[data-manage-tag]")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__paperlens.db.papers.count())).toBe(3);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "tags-manage.png") });
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test("reader toolbar shows the pane's tags; click or T inside the pane opens the editor", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  const id = await addPaper(page, fixtureBytes("simple.pdf"), "fx-simple", "Simple fixture paper");
  await page.evaluate((id) => (window as any).__paperlens.useReaderStore.getState().openPaper(id), id);
  await waitRendered(page, 1);
  const control = pane(page).locator(`[data-tag-control="${id}"]`);
  await expect(control).toHaveText("加标签");

  await control.click();
  const editor = editorOf(page, id);
  await expect(editor).toBeVisible();
  const cb = (await control.boundingBox())!;
  const eb = (await editor.boundingBox())!;
  expect(eb.y).toBeGreaterThanOrEqual(cb.y + cb.height); // 在按钮下方
  const input = tagInputOf(editor);
  await expect(input).toBeFocused();
  await page.keyboard.type("精读, 方法, 实验, 复现");
  await page.keyboard.press("Enter");
  await expect.poll(() => tagsOf(page, id)).toEqual(["精读", "方法", "实验", "复现"]);
  await expect(control.locator("[data-tag]")).toHaveText(["精读", "方法"]);
  await expect(control).toContainText("+2");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(control).toBeFocused();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "tags-toolbar.png"), clip: { x: 280, y: 0, width: 1160, height: 120 } });

  // 焦点在阅读区里时按 T
  await pane(page).locator("[data-viewer-scroll]").focus();
  await page.keyboard.press("t");
  await expect(editor).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  // Radix 关闭后在 setTimeout(0) 里把焦点还给按钮：等它落定，否则下面 focus 页码框后焦点又被挪走
  await expect(control).toBeFocused();

  // 在页码框里打字不触发
  const pageInput = pane(page).getByRole("textbox", { name: "页码" });
  await pageInput.focus();
  await page.keyboard.press("t");
  await page.waitForTimeout(150);
  await expect(editor).toBeHidden();

  // 有其他菜单开着时不触发
  await pane(page).locator("[data-viewer-scroll]").focus();
  await pane(page).locator("[data-term-display-menu]").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("t");
  await page.waitForTimeout(150);
  await expect(editor).toBeHidden();
  await page.keyboard.press("Escape");

  // 侧栏里同一篇论文的行也显示刚加的标签
  await expect(rowOf(sidebarOf(page), id).locator("[data-tag-chip]").first()).toHaveText("精读");

  // 切到其他视图时关闭
  await control.click();
  await expect(editor).toBeVisible();
  await page.evaluate(() => (window as any).__paperlens.useAppStore.getState().setView("glossary"));
  await expect(editor).toBeHidden();
  expect(errors).toEqual([]);
});

test("virtual list: tagged and untagged rows don't overlap; reveal clears a hiding tag filter", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page);
  await page.evaluate(async () => {
    const { db, useLibraryStore } = (window as any).__paperlens;
    const papers = Array.from({ length: 600 }, (_, i) => ({
      id: `seed${i}`,
      fileHash: `seedhash${i}`,
      title: `P${String(i).padStart(3, "0")} seeded paper`,
      authors: ["Seed Author"],
      domainIds: [],
      pageCount: 1,
      addedAt: i,
      ...(i % 3 === 0 ? { tags: i % 2 ? ["奇数组", "long tag name number one", "another long tag", "third"] : ["偶数组"] } : {}),
    }));
    await db.papers.bulkAdd(papers);
    useLibraryStore.getState().setSort("title");
  });
  const sidebar = sidebarOf(page);
  const list = sidebar.getByRole("listbox", { name: "全部论文" });
  await expect(sidebar.locator('[data-library-view="all"]')).toContainText("600");
  expect(await list.locator("[role=option]").count()).toBeLessThan(60);

  const checkRows = async () => {
    const boxes = await list.locator("[role=option]").evaluateAll((els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.getAttribute("data-paper-id")!, top: r.top, bottom: r.bottom, h: r.height, tagged: !!el.querySelector("[data-tag-chip]") };
        })
        .sort((a, b) => a.top - b.top),
    );
    expect(boxes.length).toBeGreaterThan(5);
    for (let i = 0; i < boxes.length; i++) {
      expect(Math.round(boxes[i].h)).toBe(boxes[i].tagged ? 91 : 71);
      if (i) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom);
    }
  };
  await checkRows();
  // 多个长标签放不下：折叠为 +N，且不超出行宽
  const crowded = rowOf(sidebar, "seed3");
  await expect(crowded.locator("[data-tag-more]")).toBeVisible();
  const line = await crowded.locator("[role=group][aria-label='标签']").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(line.sw).toBeLessThanOrEqual(line.cw + 1);

  await list.evaluate((el) => (el.scrollTop = 20_000));
  await page.waitForTimeout(100);
  await checkRows();

  // 定位到列表末尾附近的论文（不等高行的 scrollToIndex）
  await list.evaluate((el) => (el.scrollTop = 0));
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().revealPaper("seed590"));
  await expect(rowOf(sidebar, "seed590")).toBeInViewport();

  // 被标签筛选挡住的论文：定位时清除筛选
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setTagFilter(["偶数组"]));
  await expect(list.locator("[role=option]").first()).toBeVisible();
  for (const id of await list.locator("[role=option]").evaluateAll((els) => els.map((e) => e.getAttribute("data-paper-id")!)))
    expect(Number(id.slice(4)) % 6).toBe(0); // 只剩「偶数组」（编号是 6 的倍数）
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().revealPaper("seed301"));
  await expect.poll(() => filterOf(page)).toEqual([]);
  await expect(rowOf(sidebar, "seed301")).toBeInViewport();
  await expect(rowOf(sidebar, "seed301")).toHaveClass(/ring-amber/);
  await checkRows();

  // 打开编辑器后把行滚出可视区（行被卸载）：编辑器还在、还能用
  const row = rowOf(sidebar, "seed301");
  await row.focus();
  await page.keyboard.press("t");
  const editor = editorOf(page, "seed301");
  await expect(editor).toBeVisible();
  await list.evaluate((el) => (el.scrollTop = 0));
  await expect(row).toHaveCount(0);
  await tagInputOf(editor).fill("滚动后");
  await tagInputOf(editor).press("Enter");
  await expect.poll(() => tagsOf(page, "seed301")).toEqual(["滚动后"]);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  expect(errors).toEqual([]);
});
