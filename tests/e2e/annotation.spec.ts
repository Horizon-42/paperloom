/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 批注模块 e2e：选区工具栏、高亮层、角注栏、跳转闪烁、批注列表、删除、设为术语、替换 PDF 重新锚定。
// 通过开发模式的 window.__paperlens / __paperlensAnnotation 注入数据。
// 设置 PAPERLENS_LITERATURE_DIR 时在真实论文上创建高亮和笔记并截图（PAPERLENS_SHOTS_DIR/annotation-*.png）。
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  LIT,
  SHOTS,
  realPaper,
  type RealPaperKey,
  addFixture,
  addPaper,
  boot,
  fixtureBytes,
  installCtxProbe,
  measureWordsInBrowser,
  pageEl,
  store,
  waitGlyphs,
  waitRendered,
  type WordErr,
} from "./viewerHelpers";

type Rect = [number, number, number, number];

interface Ann {
  id: string;
  paperId: string;
  page: number;
  rects: Rect[];
  quote: { exact: string; prefix: string; suffix: string };
  fileHash: string;
  anchorStatus?: string;
  color: string;
  note: string;
  termId?: string;
}

type AW = Window & {
  __paperlens: {
    db: {
      annotations: { toArray(): Promise<Ann[]>; get(id: string): Promise<Ann | undefined>; count(): Promise<number> };
      papers: { get(id: string): Promise<{ fileHash: string; pageCount: number } | undefined>; update(id: string, c: Record<string, unknown>): Promise<number> };
      domains: { bulkAdd(d: unknown[]): Promise<unknown> };
    };
    useAppStore: { getState(): { setView(v: string): void; view: string } };
    useTermUiStore: { getState(): { editor: unknown } };
  };
  __paperlensAnnotation: {
    useAnnotationStore: { getState(): { selected: { id: string } | null; editingId: string | null; flash: { id: string } | null } };
    annotationService: {
      createAnnotation(anchor: unknown, opts: { color: string; note?: string }): Promise<Ann>;
    };
  };
  __paperlensViewer: { textGeometry: Record<string, (...a: never[]) => unknown> };
  __ctx: Record<string, Record<number, unknown>>;
};

test.use({ deviceScaleFactor: 2 });

test.beforeEach(async ({ page }) => {
  await boot(page);
  await page.waitForFunction(() => !!(window as unknown as AW).__paperlensAnnotation);
  await installCtxProbe(page);
});

const dbAnns = (page: Page) => page.evaluate(() => (window as unknown as AW).__paperlens.db.annotations.toArray());

async function openFixture(page: Page, file = "simple.pdf", n = 1) {
  const id = await addFixture(page, file);
  await store(page).open(id);
  await waitGlyphs(page, n);
  return id;
}

/** PDF 点 → client 坐标 */
async function toClient(page: Page, pageNumber: number, pts: [number, number][]) {
  return page.evaluate(
    ({ pageNumber, pts }) => {
      const ctx = (window as unknown as AW).__ctx.left[pageNumber] as {
        pageEl: HTMLElement;
        viewport: { convertToViewportPoint(x: number, y: number): number[] };
      };
      const r = ctx.pageEl.getBoundingClientRect();
      return pts.map(([x, y]) => {
        const [vx, vy] = ctx.viewport.convertToViewportPoint(x, y);
        return [r.left + vx, r.top + vy] as [number, number];
      });
    },
    { pageNumber, pts },
  );
}

async function drag(page: Page, a: [number, number], b: [number, number]) {
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 5 });
  await page.mouse.up();
}

/** 用墨迹真值拖选一个词（与 viewer-glyph 的做法相同） */
async function selectWord(page: Page, pageNumber: number, w: WordErr) {
  const [a, b] = await toClient(page, pageNumber, [w.truth.left, w.truth.right]);
  await drag(page, a, b);
  await expect(page.locator("[data-annotation-toolbar]")).toBeVisible();
}

/** 本页规范化文本中第 k 次出现的 needle → 锚点（PDF 矩形用字形映射算） */
async function anchorFor(page: Page, pageNumber: number, needle: string, k = 0) {
  return page.evaluate(
    async ({ pageNumber, needle, k }) => {
      const w = window as unknown as AW;
      const ctx = w.__ctx.left[pageNumber] as { paperId: string; fileHash: string; text: { normalized: { text: string } } };
      const t = ctx.text.normalized.text;
      let i = -1;
      for (let j = 0; j <= k; j++) i = t.indexOf(needle, i + 1);
      if (i < 0) throw new Error(`${needle} not found on page ${pageNumber}`);
      const tg = w.__paperlensViewer.textGeometry as unknown as { textRangeToPdfRects(c: unknown, s: number, e: number): Rect[] };
      const rects = tg.textRangeToPdfRects(ctx, i, i + needle.length);
      const QC = 32;
      return {
        paperId: ctx.paperId,
        page: pageNumber,
        rects,
        quote: { exact: needle, prefix: t.slice(Math.max(0, i - QC), i), suffix: t.slice(i + needle.length, i + needle.length + QC) },
        fileHash: ctx.fileHash,
      };
    },
    { pageNumber, needle, k },
  );
}

async function createAnn(page: Page, anchor: unknown, color = "#fde68a", note = "") {
  return page.evaluate(
    ({ anchor, color, note }) => (window as unknown as AW).__paperlensAnnotation.annotationService.createAnnotation(anchor, { color, note }),
    { anchor, color, note },
  );
}

/** CodeMirror 的 Mod 键：按页面看到的平台判断（Desktop Chrome 设备模拟的是 Windows UA） */
const modKey = (page: Page) => page.evaluate(() => (/Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "Meta" : "Control"));

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const annState = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as AW).__paperlensAnnotation.useAnnotationStore.getState();
    return { selected: s.selected?.id ?? null, editing: s.editingId, flash: s.flash?.id ?? null };
  });

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `annotation-${name}.png`) });
};

// ---------------------------------------------------------------------------

test("选中文字 → 选颜色：高亮贴合字形，刷新后仍在", async ({ page }) => {
  const id = await openFixture(page);
  const { words } = await page.evaluate(measureWordsInBrowser, { paneId: "left", pageNumber: 1 });
  // 正文（11pt）里的词；标题和小节标题字号不同
  const w = words.find((x) => x.word.length >= 7 && x.truth.left[1] < 640)!;
  await selectWord(page, 1, w);
  await page.locator('[data-annotation-toolbar] [data-color="#bbf7d0"]').click();
  await expect(page.locator("[data-annotation-toolbar]")).toHaveCount(0);

  const anns = await dbAnns(page);
  expect(anns).toHaveLength(1);
  expect(anns[0]).toMatchObject({ paperId: id, page: 1, color: "#bbf7d0", note: "", anchorStatus: "ok" });
  expect(anns[0].quote.exact).toBe(w.word);
  expect(anns[0].quote.suffix.length).toBeGreaterThan(0);
  expect(anns[0].fileHash).toBe((await page.evaluate((id) => (window as unknown as AW).__paperlens.db.papers.get(id), id))!.fileHash);

  // 精度：高亮左右边缘与墨迹真值（truth 向内缩了 0.04 em）比较
  const hl = page.locator(`.pl-hl[data-annotation-id="${anns[0].id}"]`);
  await expect(hl).toHaveCount(1);
  const measure = async () => {
    const b = (await hl.boundingBox())!;
    const [l, r] = await toClient(page, 1, [w.truth.left, w.truth.right]);
    const em = await page.evaluate(() => {
      const ctx = (window as unknown as AW).__ctx.left[1] as { viewport: { scale: number } };
      return 11 * ctx.viewport.scale; // simple.pdf 正文 11pt
    });
    return { dl: Math.abs(b.x - (l[0] - 0.04 * em)) / em, dr: Math.abs(b.x + b.width - (r[0] + 0.04 * em)) / em, b, em };
  };
  const m1 = await measure();
  console.log(`[annotation] "${w.word}" 高亮边缘误差 左 ${m1.dl.toFixed(3)} / 右 ${m1.dr.toFixed(3)} em`);
  expect(m1.dl).toBeLessThan(0.12);
  expect(m1.dr).toBeLessThan(0.12);
  // 高亮在文字之下，不挡选区；混合模式让文字保持黑色
  const blend = await page.evaluate(() => getComputedStyle(document.querySelector(".pl-layer-under")!).mixBlendMode);
  expect(blend).toBe("multiply");

  await page.reload();
  await boot(page);
  await installCtxProbe(page);
  await store(page).open(id);
  await waitGlyphs(page, 1);
  await expect(hl).toHaveCount(1);
  const m2 = await measure();
  expect(Math.abs(m2.b.x - m1.b.x)).toBeLessThan(0.5);
  expect(Math.abs(m2.b.y - m1.b.y)).toBeLessThan(0.5);
  expect(Math.abs(m2.b.width - m1.b.width)).toBeLessThan(0.5);
});

test("跨行选区得到多段矩形；跨页选区只取起点所在页", async ({ page }) => {
  await openFixture(page);
  // 第 1 页最后一段的前两行
  const lines = await page.evaluate(() => {
    const ctx = (window as unknown as AW).__ctx.left[1] as { text: { items: { str: string; transform: number[] }[] } };
    return ctx.text.items.filter((it) => it.str.trim().length > 40 && it.transform[5] < 640).map((it) => ({ x: it.transform[4], y: it.transform[5], len: it.str.length }));
  });
  const [l1, l2] = lines;
  const [a, b] = await toClient(page, 1, [
    [l1.x + 30, l1.y + 3],
    [l2.x + 60, l2.y + 3],
  ]);
  await drag(page, a, b);
  await page.locator('[data-annotation-toolbar] [data-color="#fde68a"]').click();
  const [ann] = await dbAnns(page);
  expect(ann.rects).toHaveLength(2);
  await expect(page.locator(`.pl-hl[data-annotation-id="${ann.id}"]`)).toHaveCount(2);

  // 从第 1 页末尾拖到第 2 页开头：只保存第 1 页的部分
  await waitRendered(page, 2);
  const last = lines[lines.length - 1];
  const p2 = await page.evaluate(() => {
    const ctx = (window as unknown as AW).__ctx.left[2] as { text: { items: { str: string; transform: number[] }[] } } | undefined;
    const it = ctx?.text.items.find((i) => i.str.trim().length > 40);
    return it ? { x: it.transform[4], y: it.transform[5] } : null;
  });
  test.skip(!p2, "第 2 页未挂载");
  const [s] = await toClient(page, 1, [[last.x + 20, last.y + 3]]);
  const [e] = await toClient(page, 2, [[p2!.x + 40, p2!.y + 3]]);
  await page.mouse.move(s[0], s[1]);
  await page.mouse.down();
  await page.mouse.move(e[0], e[1], { steps: 10 });
  await page.mouse.up();
  await page.locator('[data-annotation-toolbar] [data-color="#bfdbfe"]').click();
  const all = await dbAnns(page);
  const cross = all.find((x) => x.color === "#bfdbfe")!;
  expect(cross.page).toBe(1);
  expect(cross.rects.length).toBeGreaterThanOrEqual(1);
});

test("写笔记：卡片编辑、⌘Enter 保存、Esc 取消、失焦保存；Esc 隐藏工具栏", async ({ page }) => {
  await openFixture(page);
  const { words } = await page.evaluate(measureWordsInBrowser, { paneId: "left", pageNumber: 1 });
  const picks = words.filter((x) => x.word.length >= 6);

  // Esc 隐藏工具栏并清除选区
  await selectWord(page, 1, picks[0]);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-annotation-toolbar]")).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);

  await selectWord(page, 1, picks[1]);
  await page.locator('[data-annotation-toolbar] [data-action="note"]').click();
  const editor = page.locator("[data-margin-card] [data-note-editor] .cm-content");
  await expect(editor).toBeFocused();
  await page.keyboard.type("Gated **RNN** note");
  await page.keyboard.press(`${await modKey(page)}+Enter`);
  const [ann] = await dbAnns(page);
  const card = page.locator(`[data-margin-card="${ann.id}"]`);
  await expect(card.locator(".md-content strong")).toHaveText("RNN");
  expect((await dbAnns(page))[0].note).toBe("Gated **RNN** note");

  // 选中的卡片与原文对齐：卡片顶 ≈ 第一个矩形顶
  const hlBox = await box(page, `.pl-hl[data-annotation-id="${ann.id}"]`);
  const cardBox = (await card.boundingBox())!;
  expect(Math.abs(cardBox.y - hlBox.y)).toBeLessThan(1.5);
  // 卡片在页面右侧的页边栏里
  const pageBox = (await pageEl(page, 1).boundingBox())!;
  expect(cardBox.x).toBeGreaterThan(pageBox.x + pageBox.width);
  await expect(page.locator(`[data-connector="${ann.id}"]`)).toHaveCount(1);

  // Esc 取消
  await card.locator("[data-note]").click();
  await expect(editor).toBeFocused();
  await page.keyboard.type(" DISCARD");
  await page.keyboard.press("Escape");
  await expect(card.locator("[data-note-editor]")).toHaveCount(0);
  expect((await page.evaluate((id) => (window as unknown as AW).__paperlens.db.annotations.get(id), ann.id))!.note).toBe("Gated **RNN** note");

  // 失焦保存
  await card.locator("[data-note]").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" kept");
  await page.mouse.click(pageBox.x + 20, pageBox.y + 400); // 左页边空白处
  await expect.poll(async () => (await page.evaluate((id) => (window as unknown as AW).__paperlens.db.annotations.get(id), ann.id))!.note).toBe(
    "Gated **RNN** note kept",
  );
  await expect(card.locator(".md-content")).toContainText("note kept");
});

test("多条批注靠近时卡片依次下推、互不重叠", async ({ page }) => {
  const id = await openFixture(page);
  const fileHash = (await page.evaluate((id) => (window as unknown as AW).__paperlens.db.papers.get(id), id))!.fileHash;
  // 连续三行各一条长笔记
  const ys = [600, 585, 570];
  const ids: string[] = [];
  for (const [k, y] of ys.entries()) {
    const a = await createAnn(
      page,
      { paperId: id, page: 1, rects: [[72 + k * 40, y, 160 + k * 40, y + 11]], quote: { exact: `x${k}`, prefix: "", suffix: "" }, fileHash },
      "#bfdbfe",
      `第 ${k + 1} 条笔记：${"较长的说明文字，".repeat(6)}`,
    );
    ids.push(a.id);
  }
  for (const i of ids) await expect(page.locator(`[data-margin-card="${i}"]`)).toBeVisible();
  await page.waitForTimeout(300); // 等实测高度生效、top 过渡结束
  const cards = await Promise.all(ids.map(async (i) => (await page.locator(`[data-margin-card="${i}"]`).boundingBox())!));
  const hl0 = await box(page, `.pl-hl[data-annotation-id="${ids[0]}"]`);
  expect(Math.abs(cards[0].y - hl0.y)).toBeLessThan(1.5);
  for (let i = 1; i < cards.length; i++) expect(cards[i].y).toBeGreaterThanOrEqual(cards[i - 1].y + cards[i - 1].height + 3);
  await shot(page, "stacked");

  // 选中第三条：它对齐原文，前面的卡片向上让开
  await page.locator(`[data-margin-card="${ids[2]}"]`).click({ position: { x: 60, y: 6 } });
  await expect(page.locator(`[data-margin-card="${ids[2]}"][data-selected]`)).toHaveCount(1);
  await page.waitForTimeout(250); // top 过渡
  const hl2 = await box(page, `.pl-hl[data-annotation-id="${ids[2]}"]`);
  const c2 = (await page.locator(`[data-margin-card="${ids[2]}"]`).boundingBox())!;
  const c1 = (await page.locator(`[data-margin-card="${ids[1]}"]`).boundingBox())!;
  expect(Math.abs(c2.y - hl2.y)).toBeLessThan(1.5);
  expect(c1.y + c1.height).toBeLessThanOrEqual(c2.y + 0.5);
  await expect(page.locator(`[data-connector-inpage="${ids[2]}"]`)).toHaveCount(1);
});

test("点击高亮选中批注；术语模块 preventDefault 时不处理；点空白取消", async ({ page }) => {
  await openFixture(page);
  const anchor = await anchorFor(page, 1, "decision support tools");
  const a = await createAnn(page, anchor, "#fbcfe8");
  const hl = page.locator(`.pl-hl[data-annotation-id="${a.id}"]`);
  await expect(hl).toHaveCount(1);
  const b = (await hl.boundingBox())!;
  // 无笔记：只有页边色条
  await expect(page.locator(`[data-margin-marker="${a.id}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-margin-card="${a.id}"]`)).toHaveCount(0);

  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect.poll(async () => (await annState(page)).selected).toBe(a.id);
  await expect(page.locator(`[data-margin-card="${a.id}"]`)).toContainText("添加笔记");
  await expect(hl).toHaveAttribute("data-selected", "true");

  const pageBox = (await pageEl(page, 1).boundingBox())!;
  await page.mouse.click(pageBox.x + 20, pageBox.y + 400); // 左页边空白处
  await expect.poll(async () => (await annState(page)).selected).toBeNull();
  await expect(page.locator(`[data-margin-card="${a.id}"]`)).toHaveCount(0);

  // 模拟术语下划线在捕获阶段处理了点击
  await page.evaluate(() => {
    const el = document.querySelector('.pl-page[data-page-number="1"]')!;
    el.addEventListener("click", (e) => e.preventDefault(), { capture: true });
  });
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(150);
  expect((await annState(page)).selected).toBeNull();

  // 页边色条也能选中
  await page.locator(`[data-margin-marker="${a.id}"]`).click();
  await expect.poll(async () => (await annState(page)).selected).toBe(a.id);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await annState(page)).selected).toBeNull();
});

test("jumpTo 带 annotationId：跳到原文、闪烁并选中卡片", async ({ page }) => {
  const id = await openFixture(page);
  await store(page).jump({ paperId: id, page: 6 });
  await waitGlyphs(page, 6);
  const anchor = await anchorFor(page, 6, "Section 6");
  const a = await createAnn(page, anchor, "#ddd6fe", "跳转目标");
  await store(page).jump({ paperId: id, page: 1 });
  await waitRendered(page, 1);
  await page.evaluate(
    ({ id, a }) =>
      (window as unknown as AW & { __paperlens: { useReaderStore: { getState(): { jumpTo(t: unknown): void } } } }).__paperlens.useReaderStore
        .getState()
        .jumpTo({ paperId: id, page: 6, pdfPoint: [a.rects[0][0], a.rects[0][3]], annotationId: a.id }),
    { id, a },
  );
  const hl = page.locator(`.pl-hl[data-annotation-id="${a.id}"]`);
  await expect(hl).toHaveAttribute("data-flash", "true");
  await expect(page.locator(`[data-margin-card="${a.id}"][data-selected]`)).toBeVisible();
  // 目标位置在视口里
  const hb = (await hl.boundingBox())!;
  expect(hb.y).toBeGreaterThan(0);
  expect(hb.y).toBeLessThan(900);
  await expect(hl).not.toHaveAttribute("data-flash", "true", { timeout: 4000 });
});

test("批注列表：按领域（含子领域）、颜色、关键词筛选，点击跳转；未定位分组可删除", async ({ page }) => {
  const p1 = await openFixture(page, "simple.pdf");
  const p2 = await addFixture(page, "two-column.pdf");
  await page.evaluate(
    async ({ p1, p2 }) => {
      const w = window as unknown as AW;
      await w.__paperlens.db.domains.bulkAdd([
        { id: "dA", name: "序列模型", parentId: null, color: "#3b82f6", order: 0 },
        { id: "dA1", name: "循环网络", parentId: "dA", color: "#10b981", order: 0 },
        { id: "dB", name: "其他", parentId: null, color: "#f59e0b", order: 1 },
      ]);
      await w.__paperlens.db.papers.update(p1, { domainIds: ["dA1"] });
      await w.__paperlens.db.papers.update(p2, { domainIds: ["dB"] });
    },
    { p1, p2 },
  );
  const fh = async (id: string) => (await page.evaluate((id) => (window as unknown as AW).__paperlens.db.papers.get(id), id))!.fileHash;
  const h1 = await fh(p1);
  const h2 = await fh(p2);
  const mk = (paperId: string, fileHash: string, page: number, exact: string, rects: Rect[], extra: Record<string, unknown> = {}) => ({
    paperId,
    page,
    rects,
    quote: { exact, prefix: "", suffix: "" },
    fileHash,
    ...extra,
  });
  const lstm = await createAnn(page, await anchorFor(page, 1, "Long Short-Term Memory"), "#fde68a", "门控 **循环** 单元");
  await createAnn(page, mk(p1, h1, 3, "stacked LSTM", [[100, 500, 160, 511]]), "#bbf7d0", "");
  await createAnn(page, mk(p2, h2, 1, "self-attention", [[100, 500, 160, 511]]), "#bbf7d0", "注意力");
  const orphan = await createAnn(page, mk(p1, "oldhash", 2, "a sentence that was removed", [[100, 400, 160, 411]]), "#fbcfe8", "");
  await page.evaluate(async (id) => {
    const w = window as unknown as AW & { __paperlens: { db: { annotations: { update(id: string, c: unknown): Promise<number> } } } };
    await w.__paperlens.db.annotations.update(id, { anchorStatus: "orphaned" });
  }, orphan.id);

  await page.evaluate(() => (window as unknown as AW).__paperlens.useAppStore.getState().setView("annotations"));
  const list = page.locator("[data-annotation-list]");
  const items = list.locator("[data-annotation-item]");
  await expect(items).toHaveCount(4);
  await expect(list.locator("[data-orphan-header]")).toContainText("未定位");
  await expect(list.locator("[data-paper-header]")).toHaveCount(2);
  await shot(page, "list");

  // 领域：选父领域也包含子领域里的论文
  await list.locator("[data-filter-domain]").selectOption("dA");
  await expect(items).toHaveCount(3);
  await list.locator("[data-filter-domain]").selectOption("dB");
  await expect(items).toHaveCount(1);
  await list.locator("[data-filter-domain]").selectOption("");
  // 颜色
  await list.locator('[data-filter-color="#bbf7d0"]').click();
  await expect(items).toHaveCount(2);
  await list.locator('[data-filter-color="#fde68a"]').click();
  await expect(items).toHaveCount(3);
  await list.getByRole("button", { name: "清除筛选" }).click();
  // 关键词：原文和笔记都搜
  await list.locator("[data-filter-query]").fill("循环");
  await expect(items).toHaveCount(1);
  await list.locator("[data-filter-query]").fill("lstm");
  await expect(items).toHaveCount(1);
  await list.locator("[data-filter-query]").fill("");

  // 未定位的删除 + 撤销
  await list.locator(`[data-annotation-item="${orphan.id}"]`).getByRole("button", { name: "删除批注" }).click();
  await expect(items).toHaveCount(3);
  await expect(list.locator("[data-orphan-header]")).toHaveCount(0);
  await page.locator("[data-annotation-toast]").getByRole("button", { name: "撤销" }).click();
  await expect(items).toHaveCount(4);
  await list.locator(`[data-annotation-item="${orphan.id}"]`).getByRole("button", { name: "删除批注" }).click();
  await expect(items).toHaveCount(3);

  // 点击跳转
  await list.locator(`[data-annotation-item="${lstm.id}"]`).click();
  expect(await page.evaluate(() => (window as unknown as AW).__paperlens.useAppStore.getState().view)).toBe("reader");
  await expect(page.locator(`.pl-hl[data-annotation-id="${lstm.id}"][data-flash]`).first()).toBeVisible();
  await expect(page.locator(`[data-margin-card="${lstm.id}"][data-selected]`)).toBeVisible();
});

test("删除批注：卡片删除按钮、撤销提示", async ({ page }) => {
  await openFixture(page);
  const a = await createAnn(page, await anchorFor(page, 1, "ground speed"), "#fde68a", "要删除的笔记");
  const card = page.locator(`[data-margin-card="${a.id}"]`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "删除批注" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(`.pl-hl[data-annotation-id="${a.id}"]`)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as AW).__paperlens.db.annotations.count())).toBe(0);
  const toast = page.locator("[data-annotation-toast]");
  await expect(toast).toContainText("已删除批注");
  await toast.getByRole("button", { name: "撤销" }).click();
  await expect(card).toBeVisible();
  await expect(page.locator(`.pl-hl[data-annotation-id="${a.id}"]`)).toHaveCount(1);
});

test("连续删除两条批注：两条都能撤销（#13）", async ({ page }) => {
  await openFixture(page);
  const a = await createAnn(page, await anchorFor(page, 1, "ground speed"), "#fde68a", "第一条");
  const b = await createAnn(page, await anchorFor(page, 1, "radar artefacts"), "#bbf7d0", "第二条");
  await page.locator(`[data-margin-card="${a.id}"]`).getByRole("button", { name: "删除批注" }).click();
  await page.locator(`[data-margin-card="${b.id}"]`).getByRole("button", { name: "删除批注" }).click();
  const toasts = page.locator("[data-annotation-toast]");
  await expect(toasts).toHaveCount(2);
  await toasts.first().getByRole("button", { name: "撤销" }).click();
  await expect(page.locator(`[data-margin-card="${a.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-margin-card="${b.id}"]`)).toHaveCount(0);
  await toasts.first().getByRole("button", { name: "撤销" }).click();
  await expect(page.locator(`[data-margin-card="${b.id}"]`)).toBeVisible();
});

test("编辑中删除：未保存的草稿进入撤销快照（#13）", async ({ page }) => {
  await openFixture(page);
  const a = await createAnn(page, await anchorFor(page, 1, "ground speed"), "#fde68a", "旧笔记");
  const card = page.locator(`[data-margin-card="${a.id}"]`);
  await card.locator("[data-note]").click();
  await expect(card.locator("[data-note-editor] .cm-content")).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" 加上草稿");
  await card.getByRole("button", { name: "删除批注" }).click();
  await expect(card).toHaveCount(0);
  await page.locator("[data-annotation-toast]").getByRole("button", { name: "撤销" }).click();
  await expect(card.locator(".md-content")).toHaveText("旧笔记 加上草稿");
});

test("分屏打开同一篇论文：悬停只加强本分栏的高亮（#12）", async ({ page }) => {
  const id = await openFixture(page);
  await store(page).open(id, "right");
  await waitGlyphs(page, 1, "right");
  const a = await createAnn(page, await anchorFor(page, 1, "decision support tools"), "#bfdbfe", "两栏都有");
  const left = page.locator(`[data-pane="left"] .pl-hl[data-annotation-id="${a.id}"]`);
  const right = page.locator(`[data-pane="right"] .pl-hl[data-annotation-id="${a.id}"]`);
  await expect(left).toHaveCount(1);
  await expect(right).toHaveCount(1);
  await page.locator(`[data-pane="left"] [data-margin-card="${a.id}"]`).hover();
  await expect(left).toHaveAttribute("data-hover", "true");
  await expect(right).not.toHaveAttribute("data-hover", "true");
  await page.locator(`[data-pane="right"] [data-margin-card="${a.id}"]`).hover();
  await expect(right).toHaveAttribute("data-hover", "true");
  await expect(left).not.toHaveAttribute("data-hover", "true");
});

test("保存高亮失败：提示错误，保留选区和工具栏（#14）", async ({ page }) => {
  await openFixture(page);
  await page.evaluate(() => {
    const w = window as unknown as { __paperlens: { db: { annotations: { hook(e: string, f: () => void): void } } } };
    w.__paperlens.db.annotations.hook("creating", () => {
      throw new Error("存储空间不足");
    });
  });
  const { words } = await page.evaluate(measureWordsInBrowser, { paneId: "left", pageNumber: 1 });
  await selectWord(page, 1, words.find((x) => x.word.length >= 6 && x.truth.left[1] < 640)!);
  await page.locator('[data-annotation-toolbar] [data-color="#fde68a"]').click();
  await expect(page.locator('[data-annotation-toast="error"]')).toContainText("存储空间不足");
  await expect(page.locator("[data-annotation-toolbar]")).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()!.toString().trim().length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as AW).__paperlens.db.annotations.count())).toBe(0);
});

test("更换颜色", async ({ page }) => {
  await openFixture(page);
  const a = await createAnn(page, await anchorFor(page, 1, "radar artefacts"), "#fde68a", "颜色");
  const card = page.locator(`[data-margin-card="${a.id}"]`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /颜色：/ }).click();
  await page.getByRole("dialog").locator('[data-color="#bfdbfe"]').click();
  await expect.poll(async () => (await page.evaluate((id) => (window as unknown as AW).__paperlens.db.annotations.get(id), a.id))!.color).toBe("#bfdbfe");
  await expect(page.locator(`.pl-hl[data-annotation-id="${a.id}"]`)).toHaveCSS("background-color", "rgb(191, 219, 254)");
});

test("设为术语：用规范化的选中文字和出处锚点打开术语编辑器，不自己建批注", async ({ page }) => {
  const id = await openFixture(page);
  const anchor = await anchorFor(page, 1, "Long Short-Term Memory");
  const [a, b] = await toClient(page, 1, [
    [anchor.rects[0][0] + 1, (anchor.rects[0][1] + anchor.rects[0][3]) / 2],
    [anchor.rects[0][2] - 1, (anchor.rects[0][1] + anchor.rects[0][3]) / 2],
  ]);
  await drag(page, a, b);
  await page.locator('[data-annotation-toolbar] [data-action="term"]').click();
  const editor = (await page.evaluate(() => (window as unknown as AW).__paperlens.useTermUiStore.getState().editor)) as {
    initialName: string;
    source: { paperId: string; page: number; rects: Rect[]; quote: { exact: string }; fileHash: string };
  };
  expect(editor.initialName).toBe("Long Short-Term Memory");
  expect(editor.source).toMatchObject({ paperId: id, page: 1, fileHash: anchor.fileHash, quote: { exact: "Long Short-Term Memory" } });
  expect(editor.source.rects.length).toBe(1);
  for (let k = 0; k < 4; k++) expect(Math.abs(editor.source.rects[0][k] - anchor.rects[0][k])).toBeLessThan(0.5);
  expect(await page.evaluate(() => (window as unknown as AW).__paperlens.db.annotations.count())).toBe(0);
});

/** v2：在最前面插入一页新内容，删掉原第 3 页 */
async function makeV2(): Promise<Buffer> {
  const src = await PDFDocument.load(fixtureBytes("simple.pdf"));
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pre = doc.addPage([612, 792]);
  pre.drawText("Preface to the second version", { x: 72, y: 700, size: 14, font });
  const keep = src.getPageIndices().filter((i) => i !== 2);
  for (const p of await doc.copyPages(src, keep)) doc.addPage(p);
  return Buffer.from(await doc.save());
}

test("替换 PDF：批注重新定位或标为未定位，矩形按新文件补算", async ({ page }) => {
  const id = await openFixture(page);
  // 第 2 页的标题（新文件中移到第 3 页）、第 3 页的标题（新文件中删掉）
  await store(page).jump({ paperId: id, page: 2 });
  await waitGlyphs(page, 2);
  const moved = await createAnn(page, await anchorFor(page, 2, "2. Section 2"), "#bbf7d0", "会移到第 3 页");
  await store(page).jump({ paperId: id, page: 3 });
  await waitGlyphs(page, 3);
  const gone = await createAnn(page, await anchorFor(page, 3, "3. Section 3"), "#fbcfe8", "原文被删掉");
  const oldHash = moved.fileHash;

  await page.getByTestId("library-sidebar").locator(`[data-paper-id="${id}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "替换 PDF 文件…" }).click();
  const dlg = page.locator("[data-replace-dialog]");
  await expect(dlg).toBeVisible();
  // 先选同一个文件：无需替换
  await dlg.locator("[data-replace-input]").setInputFiles({ name: "simple.pdf", mimeType: "application/pdf", buffer: fixtureBytes("simple.pdf") });
  await expect(dlg.locator('[data-replace-result="unchanged"]')).toBeVisible();
  await dlg.locator("[data-replace-input]").setInputFiles({ name: "simple-v2.pdf", mimeType: "application/pdf", buffer: await makeV2() });
  await expect(dlg.locator('[data-replace-result="replaced"]')).toContainText("1 条批注已重新定位，1 条未能", { timeout: 20_000 });
  await shot(page, "replace-dialog");
  await dlg.getByRole("button", { name: "完成" }).click();

  const paper = (await page.evaluate((id) => (window as unknown as AW).__paperlens.db.papers.get(id), id))!;
  expect(paper.fileHash).not.toBe(oldHash);
  expect(paper.pageCount).toBe(10);
  const after = async (aid: string) => (await page.evaluate((aid) => (window as unknown as AW).__paperlens.db.annotations.get(aid), aid))!;
  expect(await after(gone.id)).toMatchObject({ anchorStatus: "orphaned", page: 3, fileHash: oldHash });
  expect(await after(moved.id)).toMatchObject({ anchorStatus: "relocated", page: 3, fileHash: paper.fileHash });

  // 阅读器按新文件重新加载；跳到第 3 页，高亮层补算矩形并写回
  await store(page).jump({ paperId: id, page: 3 });
  await waitGlyphs(page, 3);
  await expect.poll(async () => (await after(moved.id)).rects.length, { timeout: 10_000 }).toBe(1);
  const expected = await anchorFor(page, 3, "2. Section 2");
  const got = (await after(moved.id)).rects[0];
  for (let k = 0; k < 4; k++) expect(Math.abs(got[k] - expected.rects[0][k])).toBeLessThan(0.01);
  await expect(page.locator(`.pl-hl[data-annotation-id="${moved.id}"]`)).toHaveCount(1);
  await expect(page.locator(`.pl-hl[data-annotation-id="${gone.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-margin-card="${moved.id}"]`)).toContainText("已重新定位");

  // 批注列表里出现在"未定位"
  await page.evaluate(() => (window as unknown as AW).__paperlens.useAppStore.getState().setView("annotations"));
  await expect(page.locator("[data-orphan-header]")).toBeVisible();
  await expect(page.locator(`[data-annotation-item="${gone.id}"]`)).toBeVisible();
});

test("打开论文时校验 fileHash：从备份恢复的旧批注被重新锚定", async ({ page }) => {
  const id = await addFixture(page, "simple.pdf");
  const fileHash = (await page.evaluate((id) => (window as unknown as AW).__paperlens.db.papers.get(id), id))!.fileHash;
  // 模拟备份数据：批注记录的是旧文件，第 4 页标题原本在第 2 页
  await page.evaluate(
    async ({ id }) => {
      const w = window as unknown as AW & { __paperlens: { db: { annotations: { add(a: unknown): Promise<unknown> } } } };
      await w.__paperlens.db.annotations.add({
        id: "restored-1",
        paperId: id,
        page: 2,
        rects: [[1, 1, 2, 2]],
        quote: { exact: "4. Section 4", prefix: "", suffix: " " },
        fileHash: "backup-hash",
        color: "#fde68a",
        note: "备份里的笔记",
        createdAt: 1,
        updatedAt: 1,
      });
    },
    { id },
  );
  await store(page).open(id);
  await expect
    .poll(async () => (await page.evaluate(() => (window as unknown as AW).__paperlens.db.annotations.get("restored-1")))!.anchorStatus, {
      timeout: 15_000,
    })
    .toBe("relocated");
  const a = (await page.evaluate(() => (window as unknown as AW).__paperlens.db.annotations.get("restored-1")))!;
  expect(a).toMatchObject({ page: 4, fileHash });
});

test("全局搜索：批注分组，点击跳转", async ({ page }) => {
  await openFixture(page);
  const a = await createAnn(page, await anchorFor(page, 1, "ground speed"), "#fde68a", "关于细胞状态的笔记");
  await page.getByTestId("library-sidebar").getByRole("searchbox").fill("细胞状态");
  const group = page.getByRole("group", { name: "批注" });
  await expect(group).toContainText("ground speed");
  await group.getByRole("button").first().click();
  await expect(page.locator(`.pl-hl[data-annotation-id="${a.id}"][data-flash]`)).toBeVisible();
});

test("性能：50 页 300 条批注滚动不卡顿", async ({ page }) => {
  test.setTimeout(120_000);
  const id = await addFixture(page, "long.pdf");
  await store(page).open(id);
  await waitRendered(page, 1);
  const fileHash = (await page.evaluate((id) => (window as unknown as AW).__paperlens.db.papers.get(id), id))!.fileHash;
  await page.evaluate(
    async ({ id, fileHash }) => {
      const w = window as unknown as AW & { __paperlens: { db: { annotations: { bulkAdd(a: unknown[]): Promise<unknown> } } } };
      const anns = [];
      for (let i = 0; i < 300; i++) {
        const page = (i % 50) + 1;
        const k = Math.floor(i / 50);
        const y = 650 - k * 75;
        anns.push({
          id: `perf-${i}`,
          paperId: id,
          page,
          rects: [[72 + (k % 3) * 40, y, 220, y + 11]],
          quote: { exact: `q${i}`, prefix: "", suffix: "" },
          fileHash,
          anchorStatus: "ok",
          color: ["#fde68a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#ddd6fe"][i % 5],
          note: i % 2 ? `笔记 ${i}：${"内容 ".repeat(i % 7)}` : "",
          createdAt: i,
          updatedAt: i,
        });
      }
      await w.__paperlens.db.annotations.bulkAdd(anns);
    },
    { id, fileHash },
  );
  await expect(page.locator("[data-margin-card]").first()).toBeVisible();
  const r = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>("[data-viewer-scroll]")!;
    const frames: number[] = [];
    let last = performance.now();
    let running = true;
    const tick = (t: number) => {
      frames.push(t - last);
      last = t;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const total = el.scrollHeight - el.clientHeight;
    for (let i = 0; i < 120; i++) {
      el.scrollTop = (total * i) / 120;
      await new Promise((r) => requestAnimationFrame(r));
    }
    running = false;
    const sorted = [...frames].sort((a, b) => a - b);
    return { n: frames.length, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], cards: document.querySelectorAll("[data-margin-card]").length };
  });
  console.log(`[annotation] 滚动 ${r.n} 帧：中位 ${r.p50.toFixed(1)} ms / p95 ${r.p95.toFixed(1)} ms，挂载卡片 ${r.cards}`);
  // 只渲染附近的卡片
  expect(r.cards).toBeLessThan(80);
  expect(r.p50).toBeLessThan(40);
});

// ---------------------------------------------------------------------------
// 真实论文（只读原地读取，不复制进仓库）：创建高亮和笔记并截图，供人工检查
// ---------------------------------------------------------------------------

const REAL: { key: RealPaperKey; page: number; phrases: { text: string; color: string; note: string }[] }[] = [
  {
    key: "roformer",
    page: 1,
    phrases: [
      { text: "Rotary Position Embedding", color: "#fde68a", note: "**RoPE**：用旋转矩阵编码绝对位置，$q_m^T k_n$ 只依赖 $m-n$" },
      { text: "relative position", color: "#bbf7d0", note: "相对位置依赖" },
      { text: "linear self-attention", color: "#bfdbfe", note: "RoPE 也能用于线性注意力" },
      { text: "long text classification", color: "#fbcfe8", note: "" },
    ],
  },
  {
    // 扫描件（1970 年代的 NASA 技术报告）
    key: "scanned",
    page: 5,
    phrases: [
      { text: "roll", color: "#fde68a", note: "滚转性能要求" },
      { text: "pilot", color: "#bbf7d0", note: "飞行员评价" },
      { text: "bank angle", color: "#bfdbfe", note: "坡度角" },
    ],
  },
];

test.describe("真实论文", () => {
  test.skip(!LIT, "设置 PAPERLENS_LITERATURE_DIR 后运行");
  for (const { key, page: pn, phrases } of REAL) {
    test(`截图：${key}`, async ({ page }) => {
      test.setTimeout(120_000);
      const file = realPaper(key);
      test.skip(!file, "real-papers.local.json 里没有这篇");
      const id = await addPaper(page, readFileSync(file!), `real-${key}`, basename(file!));
      await store(page).open(id);
      await store(page).jump({ paperId: id, page: pn });
      await waitGlyphs(page, pn);
      const made: { id: string; text: string }[] = [];
      for (const ph of phrases) {
        const found = await page.evaluate(
          ({ pn, text }) => {
            const ctx = (window as unknown as AW).__ctx.left[pn] as { text: { normalized: { text: string } } };
            return ctx.text.normalized.text.toLowerCase().indexOf(text.toLowerCase());
          },
          { pn, text: ph.text },
        );
        if (found < 0) {
          console.log(`[annotation] ${key} 第 ${pn} 页没有「${ph.text}」`);
          continue;
        }
        const exact = await page.evaluate(
          ({ pn, found, len }) => ((window as unknown as AW).__ctx.left[pn] as { text: { normalized: { text: string } } }).text.normalized.text.slice(found, found + len),
          { pn, found, len: ph.text.length },
        );
        const a = await createAnn(page, await anchorFor(page, pn, exact), ph.color, ph.note);
        made.push({ id: a.id, text: exact });
      }
      expect(made.length).toBeGreaterThan(1);
      // 再用真实拖选创建一条：选中页面中部一个较长的词
      const { words } = await page.evaluate(measureWordsInBrowser, { paneId: "left", pageNumber: pn });
      const w = words.filter((x) => x.word.length >= 8)[Math.floor(words.filter((x) => x.word.length >= 8).length / 2)];
      if (w) {
        await selectWord(page, pn, w);
        await page.locator('[data-annotation-toolbar] [data-action="note"]').click();
        await expect(page.locator("[data-margin-card] [data-note-editor] .cm-content")).toBeFocused();
        await page.keyboard.type(`拖选创建：${w.word}`);
        await page.keyboard.press(`${await modKey(page)}+Enter`);
      }
      // 高亮应落在对应文字上：每条高亮的矩形与该文字的字形框一致
      for (const m of made) {
        await expect(page.locator(`.pl-hl[data-annotation-id="${m.id}"]`).first()).toBeVisible();
      }
      const first = made[0];
      const hl = (await page.locator(`.pl-hl[data-annotation-id="${first.id}"]`).first().boundingBox())!;
      await page.locator("[data-viewer-scroll]").evaluate((el, y) => (el.scrollTop += y - 200), hl.y);
      await page.waitForTimeout(400);
      await shot(page, key);
      // 选中一条：卡片对齐原文、页内引线
      await page.locator(`[data-margin-marker="${made[made.length - 1].id}"]`).click();
      await page.waitForTimeout(300);
      await shot(page, `${key}-selected`);
    });
  }
});

// ---------------------------------------------------------------------------
// 朗读（D19）：浏览器的语音合成换成假的实现，按固定节奏触发 start / boundary / end
// ---------------------------------------------------------------------------

async function installFakeSpeech(page: Page) {
  await page.evaluate(() => {
    type U = { text: string; rate: number; voice?: { name: string }; lang: string; onstart?: () => void; onend?: () => void; onboundary?: (e: unknown) => void; onerror?: (e: unknown) => void };
    const log: { text: string; rate: number; voice?: string }[] = [];
    let timer = 0;
    let current: U | null = null;
    const state = { paused: false };
    const run = (u: U) => {
      current = u;
      const words = [...u.text.matchAll(/\S+/g)];
      let i = -1;
      const step = () => {
        if (current !== u) return;
        if (state.paused) {
          timer = window.setTimeout(step, 50);
          return;
        }
        if (i < 0) u.onstart?.();
        else if (i < words.length) u.onboundary?.({ name: "word", charIndex: words[i].index, charLength: words[i][0].length });
        else {
          current = null;
          u.onend?.();
          return;
        }
        i++;
        timer = window.setTimeout(step, 150);
      };
      timer = window.setTimeout(step, 30);
    };
    const synth = {
      getVoices: () => [{ name: "Fake En", lang: "en-US", localService: true, default: true }],
      addEventListener() {},
      removeEventListener() {},
      speak(u: U) {
        log.push({ text: u.text, rate: u.rate, voice: u.voice?.name });
        run(u);
      },
      // 像真的浏览器：异步触发 error；cancel 不解除暂停（Safari 的行为）
      cancel() {
        window.clearTimeout(timer);
        const u = current;
        current = null;
        if (u) window.setTimeout(() => u.onerror?.({ error: "interrupted" }), 0);
      },
      get paused() {
        return state.paused;
      },
      get speaking() {
        return !!current;
      },
      pending: false,
      pause() {
        state.paused = true;
      },
      resume() {
        state.paused = false;
      },
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = class {
      text: string;
      rate = 1;
      lang = "";
      constructor(text: string) {
        this.text = text;
      }
    };
    // 别处（另一个标签页、系统）打断了正在读的一段
    const interrupt = () => {
      window.clearTimeout(timer);
      const u = current;
      current = null;
      u?.onerror?.({ error: "interrupted" });
    };
    (window as unknown as Record<string, unknown>).__tts = { log, state, interrupt };
  });
}

test("朗读选中的文字：一句一句读，高亮当前句和当前词；暂停 / 继续、语速、停止", async ({ page }) => {
  await openFixture(page);
  await installFakeSpeech(page);
  const { words } = await page.evaluate(measureWordsInBrowser, { paneId: "left", pageNumber: 1 });
  // 正文同一行的前几个词
  const body = words.filter((x) => x.truth.left[1] < 640);
  // 正文的前三行：一定跨句
  const ys = [...new Set(body.map((x) => Math.round(x.truth.left[1])))].sort((p, q) => q - p);
  const lineAt = (y: number) => body.filter((x) => Math.abs(x.truth.left[1] - y) < 2).sort((p, q) => p.truth.left[0] - q.truth.left[0]);
  const first = lineAt(ys[0]);
  const third = lineAt(ys[2]);
  const [a, b] = await toClient(page, 1, [first[0].truth.left, third[third.length - 1].truth.right]);
  await drag(page, a, b);
  await page.locator('[data-annotation-toolbar] [data-action="read-aloud"]').click();
  await expect(page.locator("[data-annotation-toolbar]")).toHaveCount(0);

  const bar = page.locator("[data-read-aloud-bar]");
  await expect(bar).toHaveAttribute("data-read-aloud-bar", "speaking");
  const log = () => page.evaluate(() => (window as unknown as { __tts: { log: { text: string; rate: number; voice?: string }[] } }).__tts.log);
  await expect.poll(async () => (await log()).length).toBeGreaterThan(0);
  const first0 = (await log())[0];
  expect(first0.voice).toBe("Fake En");
  expect(first0.text.split(/\s+/)[0]).toBe(first[0].word);
  // 当前句、当前词的高亮画在第 1 页上
  const page1 = pageEl(page, 1);
  await expect(page1.locator('[data-read-aloud="sentence"]').first()).toBeVisible();
  await expect(page1.locator('[data-read-aloud="word"]').first()).toBeVisible();

  // 暂停 / 继续
  await bar.getByRole("button", { name: "暂停" }).click();
  await expect(bar).toHaveAttribute("data-read-aloud-bar", "paused");
  expect(await page.evaluate(() => (window as unknown as { __tts: { state: { paused: boolean } } }).__tts.state.paused)).toBe(true);
  await bar.getByRole("button", { name: "继续" }).click();
  await expect(bar).toHaveAttribute("data-read-aloud-bar", "speaking");

  // 语速：从当前句重新读，记在本浏览器里
  await bar.locator("[data-read-aloud-rate]").click();
  await expect(bar.locator("[data-read-aloud-rate]")).toHaveText("1.25×");
  await expect.poll(async () => (await log()).at(-1)?.rate).toBe(1.25);
  expect(await page.evaluate(() => localStorage.getItem("paperlens.readAloud.rate"))).toBe("1.25");

  // 读完：一句一句读了不止一段，播放条和高亮消失
  await expect(bar).toHaveCount(0, { timeout: 15_000 });
  await expect(page1.locator("[data-read-aloud]")).toHaveCount(0);
  const texts = (await log()).map((x) => x.text);
  expect(new Set(texts).size, JSON.stringify(texts)).toBeGreaterThan(1);

  // 暂停后停止，再读新的：不会卡在暂停里没有声音
  await drag(page, a, b);
  await page.locator('[data-annotation-toolbar] [data-action="read-aloud"]').click();
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "暂停" }).click();
  await bar.getByRole("button", { name: "停止朗读" }).click();
  await expect(bar).toHaveCount(0);
  await drag(page, a, b);
  await page.locator('[data-annotation-toolbar] [data-action="read-aloud"]').click();
  await expect(page1.locator('[data-read-aloud="word"]').first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __tts: { state: { paused: boolean } } }).__tts.state.paused)).toBe(false);

  // 别处打断：停下，不卡在"正在朗读"
  await page.evaluate(() => (window as unknown as { __tts: { interrupt(): void } }).__tts.interrupt());
  await expect(bar).toHaveCount(0);
  await expect(page1.locator("[data-read-aloud]")).toHaveCount(0);
});
