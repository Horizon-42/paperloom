/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 笔记画布 e2e（开发文档第 9 节）：新建画布、收件箱拖入、自由笔记、连线与关系、刷新后保留、
// 与 PDF 角注双向同步、双击跳回原文、角注连线数跳到画布、术语弹窗的连线出现在画布上、
// 删除（连线/节点/笔记/画布）、导出 .canvas、多画布互相独立、视口保留、600 节点性能。
// npx playwright test -c tests/e2e/canvas.config.ts
// 真实论文截图：PAPERLENS_LITERATURE_DIR=<你的论文目录> PAPERLENS_SHOTS_DIR=<目录>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { LIT, SHOTS, realPaper, addFixture, addPaper, boot, installCtxProbe, store, waitGlyphs } from "./viewerHelpers";

type Rect = [number, number, number, number];
interface Ref {
  kind: "annotation" | "term" | "paper" | "note";
  id: string;
}
interface Ann {
  id: string;
  paperId: string;
  page: number;
  rects: Rect[];
  quote: { exact: string; prefix: string; suffix: string };
  note: string;
  color: string;
}
interface Table {
  bulkPut(rows: unknown[]): Promise<unknown>;
  put(row: unknown): Promise<unknown>;
  get(k: unknown): Promise<unknown>;
  toArray(): Promise<unknown[]>;
  count(): Promise<number>;
  update(k: unknown, c: unknown): Promise<number>;
}
type CW = Window & {
  __paperlens: {
    db: Record<string, Table>;
    useAppStore: { getState(): { view: string; setView(v: string): void } };
  };
  __paperlensCanvas: {
    useCanvasStore: { getState(): { activeBoardId: string | null; openBoard(id: string): void } };
    canvasService: {
      createBoard(name: string, domainIds?: string[]): Promise<{ id: string }>;
      addNodeToBoard(boardId: string, ref: Ref, pos: { x: number; y: number }, size?: { w: number; h: number }): Promise<{ node: { id: string }; existed: boolean }>;
    };
    noteService: { createNote(text: string): Promise<{ id: string }> };
    linkService: { createLink(i: { from: Ref; to: Ref; relation: string; label?: string }): Promise<{ id: string }> };
    produceCanvasFiles(): Promise<{ name: string; content: string }[]>;
  };
  __paperlensAnnotation: {
    annotationService: { createAnnotation(anchor: unknown, opts: { color: string; note?: string }): Promise<Ann> };
  };
  __ctx: Record<string, Record<number, { paperId: string; fileHash: string; text: { normalized: { text: string } } }>>;
  __paperlensViewer: { textGeometry: { textRangeToPdfRects(c: unknown, s: number, e: number): Rect[] } };
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await boot(page);
  await page.waitForFunction(() => !!(window as unknown as CW).__paperlensCanvas && !!(window as unknown as CW).__paperlensAnnotation);
  await installCtxProbe(page);
});

const modKey = (page: Page) => page.evaluate(() => (/Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "Meta" : "Control"));
const setView = (page: Page, v: string) => page.evaluate((v) => (window as unknown as CW).__paperlens.useAppStore.getState().setView(v), v);
const view = (page: Page) => page.evaluate(() => (window as unknown as CW).__paperlens.useAppStore.getState().view);
const dbAll = <T>(page: Page, table: string) => page.evaluate((t) => (window as unknown as CW).__paperlens.db[t].toArray(), table) as Promise<T[]>;
const dbGet = <T>(page: Page, table: string, key: string) =>
  page.evaluate(({ t, k }) => (window as unknown as CW).__paperlens.db[t].get(k), { t: table, k: key }) as Promise<T | undefined>;
const activeBoard = (page: Page) => page.evaluate(() => (window as unknown as CW).__paperlensCanvas.useCanvasStore.getState().activeBoardId!);

const node = (page: Page, ref: string) => page.locator(`[data-ref="${ref}"]`);
const flowNode = (page: Page, ref: string) => page.locator(".react-flow__node", { has: node(page, ref) });
const pane = (page: Page) => page.locator(".react-flow__pane");
const inboxItem = (page: Page, ref: string) => page.locator(`[data-inbox-item="${ref}"]`);
const edgeLabel = (page: Page) => page.locator("[data-edge-label]");

/** 本页规范化文本中 needle 的锚点（PDF 矩形用字形映射算） */
async function anchorFor(page: Page, pageNumber: number, needle: string) {
  return page.evaluate(
    ({ pageNumber, needle }) => {
      const w = window as unknown as CW;
      const ctx = w.__ctx.left[pageNumber];
      const t = ctx.text.normalized.text;
      const i = t.indexOf(needle);
      if (i < 0) return null;
      const rects = w.__paperlensViewer.textGeometry.textRangeToPdfRects(ctx, i, i + needle.length);
      return {
        paperId: ctx.paperId,
        page: pageNumber,
        rects,
        quote: { exact: needle, prefix: t.slice(Math.max(0, i - 32), i), suffix: t.slice(i + needle.length, i + needle.length + 32) },
        fileHash: ctx.fileHash,
      };
    },
    { pageNumber, needle },
  );
}

async function createAnn(page: Page, anchor: unknown, color: string, note = "") {
  return page.evaluate(
    ({ anchor, color, note }) => (window as unknown as CW).__paperlensAnnotation.annotationService.createAnnotation(anchor, { color, note }),
    { anchor, color, note },
  );
}

/** 打开 simple.pdf，在第 1 页创建几条批注 */
async function seedSimple(page: Page, specs: { text: string; color: string; note?: string }[]) {
  const paperId = await addFixture(page, "simple.pdf");
  await store(page).open(paperId);
  await waitGlyphs(page, 1);
  const anns: Ann[] = [];
  for (const s of specs) {
    const anchor = await anchorFor(page, 1, s.text);
    expect(anchor, s.text).not.toBeNull();
    anns.push(await createAnn(page, anchor, s.color, s.note));
  }
  return { paperId, anns };
}

const SPECS = [
  { text: "Long Short-Term Memory baseline", color: "#fde68a", note: "LSTM 的定义" },
  { text: "trajectory prediction is a core function", color: "#bbf7d0", note: "" },
  { text: "decision support tools", color: "#bfdbfe", note: "决策支持" },
];

async function newBoardUI(page: Page, name: string) {
  if (await page.locator("[data-create-first-board]").isVisible()) {
    await page.locator("[data-create-first-board]").click();
  } else {
    await page.locator("[data-board-picker]").click();
    await page.locator("[data-new-board]").click();
  }
  const input = page.locator('[data-canvas-dialog="board-name"] input');
  await input.fill(name);
  await input.press("Enter");
  await expect(page.locator("[data-board-name]")).toHaveText(name);
  await expect(page.locator("[data-canvas-flow]")).toBeVisible();
}

async function newBoardApi(page: Page, name: string): Promise<string> {
  const id = await page.evaluate(async (name) => {
    const c = (window as unknown as CW).__paperlensCanvas;
    const b = await c.canvasService.createBoard(name);
    c.useCanvasStore.getState().openBoard(b.id);
    return b.id;
  }, name);
  await expect(page.locator("[data-board-name]")).toHaveText(name);
  return id;
}

async function placeApi(page: Page, boardId: string, ref: Ref, x: number, y: number) {
  return page.evaluate(({ boardId, ref, x, y }) => (window as unknown as CW).__paperlensCanvas.canvasService.addNodeToBoard(boardId, ref, { x, y }), {
    boardId,
    ref,
    x,
    y,
  });
}

/** 从 from 节点右侧的手柄拖到 to 节点中央，等关系选择浮层出现 */
async function connect(page: Page, from: string, to: string) {
  const src = flowNode(page, from);
  await src.hover();
  const h = (await src.locator(".react-flow__handle-right").boundingBox())!;
  const t = (await node(page, to).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('[data-relation-picker="create"]')).toBeVisible();
}

async function chooseRelation(page: Page, relation: string, label = "") {
  const picker = page.locator("[data-relation-picker]");
  await picker.getByRole("radio", { name: relation }).click();
  if (label) await picker.locator("[data-relation-label]").fill(label);
  await picker.getByRole("button", { name: /^(连线|保存)$/ }).click();
  await expect(picker).toHaveCount(0);
}

async function hoverClick(page: Page, ref: string, button: string) {
  const n = flowNode(page, ref);
  await n.hover();
  await n.getByRole("button", { name: button }).click();
}

const viewportTransform = (page: Page) => page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

// ---------------------------------------------------------------------------
// 基本流程
// ---------------------------------------------------------------------------

test("新建画布 → 从收件箱拖入批注 → 新建笔记 → 连线选关系 → 刷新后保留", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  await setView(page, "canvas");
  await expect(page.locator("[data-canvas-empty]")).toBeVisible();
  await newBoardUI(page, "方法对比");

  // 收件箱：三条批注，最近的在前
  await expect(page.locator("[data-inbox-item]")).toHaveCount(3);
  const a = `annotation:${anns[0].id}`;
  const b = `annotation:${anns[1].id}`;
  await inboxItem(page, a).dragTo(pane(page), { targetPosition: { x: 260, y: 220 } });
  await expect(node(page, a)).toBeVisible();
  await expect(node(page, a).locator("[data-quote]")).toContainText("Long Short-Term Memory baseline");
  await expect(node(page, a).locator("[data-source]")).toContainText("simple.pdf · 第 1 页");
  // 拖入后离开收件箱
  await expect(inboxItem(page, a)).toHaveCount(0);
  await expect(page.locator("[data-inbox-item]")).toHaveCount(2);

  // 同一条再拖一次：不重复，定位到已有节点
  await inboxItem(page, b).dragTo(pane(page), { targetPosition: { x: 620, y: 260 } });
  await expect(node(page, b)).toBeVisible();
  await page.getByRole("tab", { name: "搜索添加" }).click();
  await page.getByLabel("搜索要添加的条目").fill("trajectory prediction");
  const res = page.locator(`[data-search-result="${b}"]`);
  await expect(res).toContainText("trajectory prediction");
  await res.dragTo(pane(page), { targetPosition: { x: 500, y: 500 } });
  await expect(page.locator("[data-canvas-node]")).toHaveCount(2);
  await expect(page.locator("[data-annotation-toast]")).toContainText("已在这块画布上");
  await page.getByRole("tab", { name: "未整理" }).click();

  // 新建自由笔记：自动进入编辑
  await page.locator("[data-new-note]").click();
  const editor = page.locator("[data-node-editor] .cm-content");
  await expect(editor).toBeFocused();
  await page.keyboard.type("我的想法：**门控**很关键");
  await page.keyboard.press(`${await modKey(page)}+Enter`);
  await expect(page.locator("[data-node-editor]")).toHaveCount(0);
  await expect.poll(async () => (await dbAll<{ text: string }>(page, "notes")).map((n) => n.text)).toEqual(["我的想法：**门控**很关键"]);
  const notes = await dbAll<{ id: string; text: string }>(page, "notes");
  const n = `note:${notes[0].id}`;
  await expect(node(page, n).locator(".md-content strong")).toHaveText("门控");

  // 拖动笔记，位置在拖动结束时写入
  const nb = (await node(page, n).boundingBox())!;
  await page.mouse.move(nb.x + 40, nb.y + 8);
  await page.mouse.down();
  await page.mouse.move(nb.x + 40, nb.y + 220, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await dbAll<{ ref: Ref; y: number }>(page, "boardNodes")).find((x) => x.ref.id === notes[0].id)!.y)
    .toBeGreaterThan(150);

  // 选中后拖右下角调整大小，松手时写入
  await node(page, n).click();
  const corner = flowNode(page, n).locator(".react-flow__resize-control.handle.bottom.right");
  const cb = (await corner.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + 80, cb.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const r = (await dbAll<{ ref: Ref; w: number; h: number }>(page, "boardNodes")).find((x) => x.ref.id === notes[0].id)!;
      // 手柄中心与角点差几个像素
      return Math.abs(r.w - (240 + 80)) < 6 && Math.abs(r.h - (130 + 60)) < 6;
    })
    .toBe(true);
  await pane(page).click({ position: { x: 20, y: 20 } });

  // 连线：批注 A → 笔记（支持）、批注 B → 批注 A（自定义）
  await connect(page, a, n);
  await expect(page.locator("[data-relation-picker]")).toContainText("Long Short-Term Memory");
  await chooseRelation(page, "支持");
  await expect(edgeLabel(page)).toHaveText(["支持"]);
  await connect(page, b, a);
  // 自定义关系必须填文字
  const picker = page.locator("[data-relation-picker]");
  await picker.getByRole("radio", { name: "自定义" }).click();
  await picker.getByRole("button", { name: "连线" }).click();
  await expect(picker).toContainText("自定义关系需要填写文字");
  await picker.locator("[data-relation-label]").fill("应用场景");
  await picker.locator("[data-relation-label]").press("Enter");
  await expect(edgeLabel(page)).toHaveCount(2);
  await expect(page.locator('[data-edge-label][data-relation="custom"]')).toHaveText("应用场景");
  const links = await dbAll<{ from: Ref; to: Ref; relation: string; label?: string }>(page, "links");
  expect(links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ from: { kind: "annotation", id: anns[0].id }, to: { kind: "note", id: notes[0].id }, relation: "supports" }),
      expect.objectContaining({ from: { kind: "annotation", id: anns[1].id }, to: { kind: "annotation", id: anns[0].id }, relation: "custom", label: "应用场景" }),
    ]),
  );

  // 点击连线文字修改关系
  await page.locator('[data-edge-label][data-relation="supports"]').click();
  await expect(page.locator('[data-relation-picker="edit"]')).toBeVisible();
  await chooseRelation(page, "扩展", "门控机制");
  await expect(page.locator('[data-edge-label][data-relation="extends"]')).toHaveText("扩展 · 门控机制");

  // 刷新后仍在
  const before = await viewportTransform(page);
  await page.waitForTimeout(600); // 视口防抖保存
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as CW).__paperlensCanvas);
  await setView(page, "canvas");
  await expect(page.locator("[data-board-name]")).toHaveText("方法对比");
  await expect(page.locator("[data-canvas-node]")).toHaveCount(3);
  await expect(edgeLabel(page)).toHaveCount(2);
  await expect(page.locator('[data-edge-label][data-relation="extends"]')).toHaveText("扩展 · 门控机制");
  expect(await viewportTransform(page)).toBe(before);
});

// ---------------------------------------------------------------------------
// 与 PDF 的双向同步、跳转
// ---------------------------------------------------------------------------

test("画布上编辑批注笔记，PDF 角注同步更新；反之亦然", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  const a = anns[0];
  const card = page.locator(`[data-margin-card="${a.id}"]`);
  await expect(card).toContainText("LSTM 的定义");

  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "同步");
  await placeApi(page, boardId, { kind: "annotation", id: a.id }, 0, 0);
  const ref = `annotation:${a.id}`;
  await expect(node(page, ref)).toContainText("LSTM 的定义");

  await hoverClick(page, ref, "编辑笔记");
  const editor = node(page, ref).locator("[data-node-editor] .cm-content");
  await expect(editor).toBeFocused();
  await page.keyboard.press(`${await modKey(page)}+End`);
  await page.keyboard.type("，带**遗忘门**");
  await page.keyboard.press(`${await modKey(page)}+Enter`);
  await expect(node(page, ref).locator(".md-content strong")).toHaveText("遗忘门");
  expect((await dbGet<Ann>(page, "annotations", a.id))!.note).toBe("LSTM 的定义，带**遗忘门**");

  // 阅读器里的角注已经是新内容
  await setView(page, "reader");
  await expect(card.locator(".md-content strong")).toHaveText("遗忘门");

  // 失焦也保存
  await setView(page, "canvas");
  await hoverClick(page, ref, "编辑笔记");
  await page.keyboard.press(`${await modKey(page)}+End`);
  await page.keyboard.type(" OK");
  await pane(page).click({ position: { x: 600, y: 600 } });
  await expect.poll(async () => (await dbGet<Ann>(page, "annotations", a.id))!.note).toBe("LSTM 的定义，带**遗忘门** OK");

  // 反向：在角注里改，画布立即更新
  await setView(page, "reader");
  await card.locator("[data-note]").click();
  await page.keyboard.press(`${await modKey(page)}+a`);
  await page.keyboard.type("在角注里改的");
  await page.keyboard.press(`${await modKey(page)}+Enter`);
  await setView(page, "canvas");
  await expect(node(page, ref).locator("[data-note]")).toHaveText("在角注里改的");
});

test("双击批注节点跳回原文并闪烁；角注显示连线数，点击回到画布定位节点", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  const [a, b] = anns;
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "跳转");
  await placeApi(page, boardId, { kind: "annotation", id: a.id }, 0, 0);
  await placeApi(page, boardId, { kind: "annotation", id: b.id }, 400, 0);
  const ra = `annotation:${a.id}`;
  await expect(node(page, ra)).toBeVisible();

  // 双击 → 阅读器，原文高亮闪烁
  await node(page, ra).locator("[data-quote]").dblclick();
  await expect.poll(() => view(page)).toBe("reader");
  await expect(page.locator(`.pl-hl[data-annotation-id="${a.id}"][data-flash]`).first()).toBeVisible();

  // 在画布上但没有连线：角注上只显示画布数
  const card = page.locator(`[data-margin-card="${a.id}"]`);
  const badge = card.locator("[data-canvas-badge]");
  await expect(card).toBeVisible();
  await expect(badge.locator("[data-badge-boards]")).toHaveText("1");
  await expect(badge.locator("[data-badge-links]")).toHaveCount(0);

  await page.evaluate(
    ({ a, b }) =>
      (window as unknown as CW).__paperlensCanvas.linkService.createLink({ from: { kind: "annotation", id: a }, to: { kind: "annotation", id: b }, relation: "supports" }),
    { a: a.id, b: b.id },
  );
  await expect(badge.locator("[data-badge-links]")).toHaveText("1");

  // 把画布移远，确认点击后会重新定位
  await setView(page, "canvas");
  await page.locator(".react-flow__controls-zoomout").click();
  await pane(page).click({ position: { x: 50, y: 50 } });
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 400);
  await expect(node(page, ra)).toHaveCount(0); // 移出视口后不渲染
  await setView(page, "reader");

  await badge.click();
  await expect.poll(() => view(page)).toBe("canvas");
  await expect(node(page, ra)).toHaveAttribute("data-selected", "true");
  await expect(node(page, ra)).toHaveAttribute("data-flash", "true");
  // 节点中心移到画布可视区域中央（平移动画结束后）
  const fb = (await page.locator("[data-canvas-flow]").boundingBox())!;
  await expect
    .poll(async () => {
      const nb = (await node(page, ra).boundingBox())!;
      return Math.max(Math.abs(nb.x + nb.width / 2 - (fb.x + fb.width / 2)), Math.abs(nb.y + nb.height / 2 - (fb.y + fb.height / 2)));
    })
    .toBeLessThan(20);

  // 放在两块画布上时让用户选
  const board2 = await newBoardApi(page, "第二块");
  await placeApi(page, board2, { kind: "annotation", id: a.id }, 100, 100);
  await setView(page, "reader");
  await badge.click();
  await expect(page.locator(`[data-badge-board="${board2}"]`)).toBeVisible();
  await page.locator(`[data-badge-board="${boardId}"]`).click();
  await expect.poll(() => view(page)).toBe("canvas");
  await expect(page.locator("[data-board-name]")).toHaveText("跳转");
  await expect(node(page, ra)).toHaveAttribute("data-selected", "true");
});

test("术语弹窗里添加的连线出现在画布上；双击术语节点打开术语编辑器", async ({ page }) => {
  const now = Date.now();
  await page.evaluate(
    (now) =>
      (window as unknown as CW).__paperlens.db.terms.bulkPut([
        { id: "t-lstm", name: "Long Short-Term Memory", aliases: ["LSTM"], matchMode: "auto", scope: { kind: "global" }, note: "门控 RNN", createdAt: now, updatedAt: now },
      ]),
    now,
  );
  const { anns } = await seedSimple(page, [SPECS[1]]);
  const a = anns[0];
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "术语");
  await placeApi(page, boardId, { kind: "term", id: "t-lstm" }, 0, 0);
  await placeApi(page, boardId, { kind: "annotation", id: a.id }, 420, 40);
  await expect(node(page, "term:t-lstm")).toContainText("Long Short-Term Memory");
  await expect(edgeLabel(page)).toHaveCount(0);

  // 在阅读器里点术语下划线 → 弹窗 → 相关笔记 → 添加连线
  await setView(page, "reader");
  const ul = page.locator('[data-pane="left"] .pl-page[data-page-number="1"] [data-term-ul][data-term-ids~="t-lstm"][data-seg="0"]').first();
  await expect(ul).toBeAttached({ timeout: 20_000 });
  const ub = (await ul.boundingBox())!;
  await page.mouse.click(ub.x + ub.width / 2, ub.y + ub.height / 2);
  const related = page.locator("[data-term-popover] [data-term-related]");
  await related.getByRole("button", { name: "添加连线" }).click();
  await related.locator("[data-link-search]").fill("core function");
  await related.locator(`[data-link-result="annotation:${a.id}"]`).click();
  await related.getByRole("radio", { name: "对比" }).click();
  await related.getByRole("button", { name: "添加连线" }).click();
  await expect(related.locator("[data-link-id]")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await setView(page, "canvas");
  await expect(page.locator('[data-edge-label][data-relation="compares"]')).toHaveText("对比");

  // 双击术语节点 → 术语编辑器
  await node(page, "term:t-lstm").locator("[data-term-name]").dblclick();
  await expect(page.getByRole("dialog")).toContainText("Long Short-Term Memory");
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

test("删除连线是全局的（有提示）；移出节点只删画布节点；删除笔记级联删除连线", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  const [a, b] = anns;
  await setView(page, "canvas");
  const board1 = await newBoardApi(page, "一");
  const noteId = await page.evaluate(() => (window as unknown as CW).__paperlensCanvas.noteService.createNote("自由笔记 X"));
  const nid = (noteId as unknown as { id: string }).id;
  await placeApi(page, board1, { kind: "annotation", id: a.id }, 0, 0);
  await placeApi(page, board1, { kind: "annotation", id: b.id }, 400, 0);
  await placeApi(page, board1, { kind: "note", id: nid }, 200, 260);
  const ra = `annotation:${a.id}`;
  const rb = `annotation:${b.id}`;
  const rn = `note:${nid}`;
  await expect(page.locator("[data-canvas-node]")).toHaveCount(3);
  await connect(page, ra, rb);
  await chooseRelation(page, "反驳");
  await connect(page, rn, ra);
  await chooseRelation(page, "属于");
  await expect(edgeLabel(page)).toHaveCount(2);

  // 删除连线：提示全局删除
  await page.locator('[data-edge-label][data-relation="contradicts"]').click();
  await page.locator('[data-relation-picker="edit"]').getByRole("button", { name: "删除连线…" }).click();
  const confirm = page.locator("[data-confirm-delete-link]");
  await expect(confirm).toContainText("所有画布");
  await expect(confirm).toContainText("相关笔记");
  await confirm.getByRole("button", { name: "删除连线" }).click();
  await expect(edgeLabel(page)).toHaveCount(1);
  expect((await dbAll<{ relation: string }>(page, "links")).map((l) => l.relation)).toEqual(["partOf"]);

  // 移出节点：只删 boardNode，批注和连线都在，回到收件箱；可撤销
  await hoverClick(page, ra, "移出画布");
  await expect(node(page, ra)).toHaveCount(0);
  await expect(edgeLabel(page)).toHaveCount(0);
  expect(await dbGet(page, "annotations", a.id)).toBeTruthy();
  expect(await dbAll(page, "links")).toHaveLength(1);
  await expect(inboxItem(page, ra)).toBeVisible();
  await page.locator("[data-annotation-toast]", { hasText: "已移出画布" }).getByRole("button", { name: "撤销" }).click();
  await expect(node(page, ra)).toBeVisible();
  await expect(edgeLabel(page)).toHaveCount(1);

  // 键盘删除选中节点：同样只是移出
  await node(page, rb).locator("[data-quote]").click();
  await page.keyboard.press("Delete");
  await expect(node(page, rb)).toHaveCount(0);
  expect(await dbGet(page, "annotations", b.id)).toBeTruthy();

  // 删除自由笔记：确认后删除笔记、它的连线和所有画布上的节点
  const board2 = await newBoardApi(page, "二");
  await placeApi(page, board2, { kind: "note", id: nid }, 0, 0);
  await page.locator("[data-board-picker]").click();
  await page.locator(`[data-board-item="${board1}"]`).click();
  await expect(node(page, rn)).toBeVisible();
  await hoverClick(page, rn, "删除笔记");
  const dlg = page.locator('[data-canvas-dialog="delete-note"]');
  await expect(dlg).toContainText("1 条连线");
  await dlg.getByRole("button", { name: "删除笔记" }).click();
  await expect(node(page, rn)).toHaveCount(0);
  expect(await dbAll(page, "notes")).toHaveLength(0);
  expect(await dbAll(page, "links")).toHaveLength(0);
  expect((await dbAll<{ ref: Ref }>(page, "boardNodes")).filter((x) => x.ref.kind === "note")).toHaveLength(0);
});

test("删除画布：只删节点；只在本画布上且没有连线的笔记可选保留（回到未整理）或一并删除", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  await setView(page, "canvas");
  const make = async (name: string) => {
    const id = await newBoardApi(page, name);
    const n1 = (await page.evaluate(() => (window as unknown as CW).__paperlensCanvas.noteService.createNote("孤立笔记"))) as { id: string };
    const n2 = (await page.evaluate(() => (window as unknown as CW).__paperlensCanvas.noteService.createNote("有连线的笔记"))) as { id: string };
    await placeApi(page, id, { kind: "note", id: n1.id }, 0, 0);
    await placeApi(page, id, { kind: "note", id: n2.id }, 300, 0);
    await placeApi(page, id, { kind: "annotation", id: anns[0].id }, 0, 300);
    await page.evaluate(
      ({ n2, a }) =>
        (window as unknown as CW).__paperlensCanvas.linkService.createLink({ from: { kind: "note", id: n2 }, to: { kind: "annotation", id: a }, relation: "supports" }),
      { n2: n2.id, a: anns[0].id },
    );
    await expect(page.locator("[data-canvas-node]")).toHaveCount(3);
    return { id, n1: n1.id, n2: n2.id };
  };
  const del = async (keep: boolean) => {
    await page.locator("[data-board-more]").click();
    await page.locator("[data-delete-board]").click();
    const dlg = page.locator('[data-canvas-dialog="delete-board"]');
    await expect(dlg).toContainText("3 个节点");
    await expect(dlg.locator('[data-orphan-notes="1"]')).toBeVisible();
    if (!keep) await dlg.getByLabel("一并删除这些笔记").check();
    await dlg.getByRole("button", { name: "删除画布" }).click();
    await expect(dlg).toHaveCount(0);
  };

  const x = await make("保留");
  await del(true);
  // 只剩空状态；孤立笔记回到收件箱
  await expect(page.locator("[data-canvas-empty]")).toBeVisible();
  expect(await dbGet(page, "notes", x.n1)).toBeTruthy();
  expect(await dbGet(page, "annotations", anns[0].id)).toBeTruthy();
  expect(await dbAll(page, "links")).toHaveLength(1);

  const y = await make("删除");
  await expect(inboxItem(page, `note:${x.n1}`)).toBeVisible();
  await del(false);
  expect(await dbGet(page, "notes", y.n1)).toBeUndefined();
  expect(await dbGet(page, "notes", y.n2)).toBeTruthy(); // 有连线的保留
  expect(await dbGet(page, "notes", x.n1)).toBeTruthy(); // 不在这块画布上的不受影响
  expect(await dbAll(page, "boards")).toHaveLength(0);
  expect(await dbAll(page, "boardNodes")).toHaveLength(0);
});

test("引用的条目不存在时显示占位，可移出；角注连线数：批注还没放到画布上时可选画布放入", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  const [a, b] = anns;
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "占位");
  // 直接写一个指向不存在批注的节点（例如导入的旧数据）
  await page.evaluate(
    (boardId) =>
      (window as unknown as CW).__paperlens.db.boardNodes.put({ id: "ghost", boardId, ref: { kind: "annotation", id: "ghost-ann" }, x: 0, y: 0, w: 200, h: 60 }),
    boardId,
  );
  const ghost = node(page, "annotation:ghost-ann");
  await expect(ghost.locator("[data-missing]")).toContainText("已删除的批注");
  await ghost.getByRole("button", { name: "移出画布" }).click();
  await expect(ghost).toHaveCount(0);

  // a、b 之间有连线，但都不在任何画布上
  await page.evaluate(
    ({ a, b }) =>
      (window as unknown as CW).__paperlensCanvas.linkService.createLink({ from: { kind: "annotation", id: a }, to: { kind: "annotation", id: b }, relation: "extends" }),
    { a: a.id, b: b.id },
  );
  await setView(page, "reader");
  const badge = page.locator(`[data-margin-card="${a.id}"] [data-canvas-badge]`);
  await expect(badge.locator("[data-badge-links]")).toHaveText("1");
  await expect(badge.locator("[data-badge-boards]")).toHaveCount(0);
  await badge.click();
  await page.locator(`[data-badge-board="${boardId}"]`).click();
  await expect.poll(() => view(page)).toBe("canvas");
  await expect(node(page, `annotation:${a.id}`)).toHaveAttribute("data-selected", "true");
  expect((await dbAll<{ ref: Ref }>(page, "boardNodes")).map((n) => n.ref.id)).toEqual([a.id]);
});

// ---------------------------------------------------------------------------
// 导出、多画布、视口
// ---------------------------------------------------------------------------

test("导出 .canvas：JSON Canvas 1.0 节点与边", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  await page.evaluate(() =>
    (window as unknown as CW).__paperlens.db.terms.put({
      id: "t1",
      name: "LSTM",
      aliases: ["Long Short-Term Memory"],
      matchMode: "auto",
      scope: { kind: "global" },
      note: "门控",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "导出/测试");
  const na = await placeApi(page, boardId, { kind: "annotation", id: anns[0].id }, 10, 20);
  const nt = await placeApi(page, boardId, { kind: "term", id: "t1" }, 400, 20);
  await page.evaluate(
    (a) =>
      (window as unknown as CW).__paperlensCanvas.linkService.createLink({ from: { kind: "annotation", id: a }, to: { kind: "term", id: "t1" }, relation: "partOf" }),
    anns[0].id,
  );
  await expect(edgeLabel(page)).toHaveText(["属于"]);

  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("[data-export-canvas]").click()]);
  expect(download.suggestedFilename()).toBe("导出 测试.canvas");
  const json = JSON.parse(readFileSync((await download.path())!, "utf8")) as {
    nodes: { id: string; type: string; x: number; y: number; width: number; height: number; text: string; color?: string }[];
    edges: { id: string; fromNode: string; toNode: string; label: string; fromSide: string; toSide: string }[];
  };
  expect(json.nodes).toHaveLength(2);
  const an = json.nodes.find((n) => n.id === na.node.id)!;
  expect(an).toMatchObject({ type: "text", x: 10, y: 20, width: 260, height: 150, color: "#fde68a" });
  expect(an.text).toContain("> Long Short-Term Memory baseline");
  expect(an.text).toContain("LSTM 的定义");
  expect(an.text).toContain("《[[papers/simple.pdf|simple.pdf]]》第 1 页"); // 指向 data/markdown/papers/ 的双链
  expect(json.nodes.find((n) => n.id === nt.node.id)!.text).toContain("### [[terms/LSTM|LSTM]]");
  expect(json.edges).toEqual([expect.objectContaining({ fromNode: na.node.id, toNode: nt.node.id, label: "属于", fromSide: "right", toSide: "left" })]);

  // 存储模块镜像到 data/canvas/ 的生成函数
  const files = await page.evaluate(() => (window as unknown as CW).__paperlensCanvas.produceCanvasFiles());
  expect(files.map((f) => f.name)).toEqual(["导出 测试.canvas"]);
  expect(JSON.parse(files[0].content)).toEqual(json);
});

test("多块画布互相独立；连线在两端都在的画布上都显示；视口按画布保存", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  const [a, b] = anns;
  await setView(page, "canvas");
  const b1 = await newBoardApi(page, "按方法");
  await placeApi(page, b1, { kind: "annotation", id: a.id }, 0, 0);
  await placeApi(page, b1, { kind: "annotation", id: b.id }, 400, 0);
  await connect(page, `annotation:${a.id}`, `annotation:${b.id}`);
  await chooseRelation(page, "扩展");
  // 画布 1 的视口：缩小、平移
  await page.locator(".react-flow__controls-zoomout").click();
  await pane(page).hover();
  await page.mouse.wheel(120, 80);
  await page.waitForTimeout(700);
  const vp1 = await viewportTransform(page);

  const b2 = await newBoardApi(page, "按数据集");
  await expect(page.locator("[data-canvas-node]")).toHaveCount(0);
  await placeApi(page, b2, { kind: "annotation", id: a.id }, 50, 300);
  await expect(page.locator("[data-canvas-node]")).toHaveCount(1);
  await expect(edgeLabel(page)).toHaveCount(0); // 另一端不在这块画布上
  await placeApi(page, b2, { kind: "annotation", id: b.id }, 500, 300);
  await expect(page.locator('[data-edge-label][data-relation="extends"]')).toHaveText("扩展"); // 连线全局有效
  // 在画布 2 上移出 a，不影响画布 1
  await hoverClick(page, `annotation:${a.id}`, "移出画布");
  await expect(page.locator("[data-canvas-node]")).toHaveCount(1);
  const vp2 = await viewportTransform(page);

  await page.locator("[data-board-picker]").click();
  await page.locator(`[data-board-item="${b1}"]`).click();
  await expect(page.locator("[data-board-name]")).toHaveText("按方法");
  await expect(page.locator("[data-canvas-node]")).toHaveCount(2);
  await expect(edgeLabel(page)).toHaveCount(1);
  expect(await viewportTransform(page)).toBe(vp1);
  const pos = (await dbAll<{ boardId: string; ref: Ref; x: number; y: number }>(page, "boardNodes")).filter((n) => n.boardId === b1);
  expect(pos.find((n) => n.ref.id === a.id)).toMatchObject({ x: 0, y: 0 });

  await page.locator("[data-board-picker]").click();
  await page.locator(`[data-board-item="${b2}"]`).click();
  await expect(page.locator("[data-board-name]")).toHaveText("按数据集");
  expect(await viewportTransform(page)).toBe(vp2);
  // 收件箱：a 仍在画布 1 上，不出现
  await expect(inboxItem(page, `annotation:${a.id}`)).toHaveCount(0);
});

test("收件箱按论文/领域/颜色筛选；论文可从文库侧栏拖入画布", async ({ page }) => {
  const { paperId, anns } = await seedSimple(page, SPECS);
  await page.evaluate(
    async (paperId) => {
      const { db } = (window as unknown as CW).__paperlens;
      await db.domains.bulkPut([{ id: "d1", name: "轨迹预测", parentId: null, color: "#3b82f6", order: 0 }]);
      await db.papers.update(paperId, { domainIds: ["d1"] });
    },
    paperId,
  );
  await addPaper(page, Buffer.from("%PDF-1.4\n%%EOF"), "p-other", "Other Paper");
  await setView(page, "canvas");
  await newBoardApi(page, "筛选");
  await expect(page.locator("[data-inbox-item]")).toHaveCount(3);
  await page.locator('[data-inbox-color="#bbf7d0"]').click();
  await expect(page.locator("[data-inbox-item]")).toHaveCount(1);
  await expect(inboxItem(page, `annotation:${anns[1].id}`)).toBeVisible();
  await page.locator('[data-inbox-color="#bbf7d0"]').click();
  await page.locator("[data-inbox-paper]").selectOption(paperId);
  await expect(page.locator("[data-inbox-item]")).toHaveCount(3);
  await page.locator("[data-inbox-domain]").selectOption("d1");
  await expect(page.locator("[data-inbox-item]")).toHaveCount(3);
  await page.evaluate((paperId) => (window as unknown as CW).__paperlens.db.papers.update(paperId, { domainIds: [] }), paperId);
  await expect(page.locator("[data-inbox-item]")).toHaveCount(0);

  // 文库侧栏的论文行拖到画布上 → 论文节点；双击打开论文
  const row = page.locator('[data-testid="library-sidebar"]').getByText("Other Paper");
  await row.dragTo(pane(page), { targetPosition: { x: 300, y: 300 } });
  await expect(node(page, "paper:p-other")).toContainText("Other Paper");
});

test("领域笔记：收件箱里标明所属领域；从领域树拖到画布上成为可连线的笔记节点；在画布上改内容，列表跟着变", async ({ page }) => {
  await page.evaluate(async () => {
    const { db } = (window as unknown as CW).__paperlens;
    await db.domains.put({ id: "d-f", name: "强化学习", parentId: null, color: "#3b82f6", order: 0 });
    await db.notes.put({ id: "fn1", text: "强化学习小结", domainId: "d-f", createdAt: 1, updatedAt: 1 });
  });
  await page.evaluate(() => (window as any).__paperlens.useLibraryStore.getState().setExpanded("d-f", true));
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "领域笔记");
  await expect(inboxItem(page, "note:fn1")).toContainText("领域笔记 · 强化学习");

  const treeRow = page.locator('[data-testid="library-sidebar"] [data-note-id="fn1"]');
  await treeRow.dragTo(pane(page), { targetPosition: { x: 320, y: 260 } });
  await expect(node(page, "note:fn1")).toContainText("领域笔记 · 强化学习");
  await expect(node(page, "note:fn1")).toContainText("强化学习小结");
  // 有连接点，可以连线
  await expect(flowNode(page, "note:fn1").locator(".react-flow__handle").first()).toBeAttached();
  expect((await dbAll<{ ref: Ref; boardId: string }>(page, "boardNodes")).some((n) => n.boardId === boardId && n.ref.id === "fn1")).toBe(true);
  await expect(inboxItem(page, "note:fn1")).toHaveCount(0);

  // 在画布上编辑，领域树里的名字跟着变
  await page.evaluate(() => (window as unknown as CW).__paperlens.db.notes.update("fn1", { text: "改过的小结" }));
  await expect(treeRow).toHaveText("改过的小结");
  await expect(node(page, "note:fn1")).toContainText("改过的小结");
});

// ---------------------------------------------------------------------------
// 评审修复
// ---------------------------------------------------------------------------

const LSTM_TERM = { id: "t-lstm", name: "Long Short-Term Memory", aliases: ["LSTM"], matchMode: "auto", scope: { kind: "global" }, note: "门控 RNN" };

async function seedTerm(page: Page, t: Record<string, unknown> = LSTM_TERM) {
  await page.evaluate((t) => (window as unknown as CW).__paperlens.db.terms.put({ createdAt: Date.now(), updatedAt: Date.now(), ...t }), t);
}

/** 在阅读器第 1 页点术语下划线，打开术语弹窗 */
async function openTermPopover(page: Page, termId: string) {
  const ul = page.locator(`[data-pane="left"] .pl-page[data-page-number="1"] [data-term-ul][data-term-ids~="${termId}"][data-seg="0"]`).first();
  await expect(ul).toBeAttached({ timeout: 20_000 });
  const ub = (await ul.boundingBox())!;
  await page.mouse.click(ub.x + ub.width / 2, ub.y + ub.height / 2);
  const pop = page.locator("[data-term-popover]");
  await expect(pop).toBeVisible();
  return pop;
}

const createLinkApi = (page: Page, from: Ref, to: Ref, relation = "supports") =>
  page.evaluate(({ from, to, relation }) => (window as unknown as CW).__paperlensCanvas.linkService.createLink({ from, to, relation }), { from, to, relation });

test("删除键：焦点在连线浮层、对话框、侧栏、术语编辑器里时不会移除选中的节点", async ({ page }) => {
  await seedTerm(page);
  const { anns } = await seedSimple(page, SPECS);
  const [a, b] = anns;
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "删除键");
  await placeApi(page, boardId, { kind: "annotation", id: a.id }, 0, 0);
  await placeApi(page, boardId, { kind: "annotation", id: b.id }, 420, 0);
  await placeApi(page, boardId, { kind: "term", id: "t-lstm" }, 200, 260);
  await createLinkApi(page, { kind: "annotation", id: a.id }, { kind: "annotation", id: b.id });
  const ra = `annotation:${a.id}`;
  await expect(edgeLabel(page)).toHaveCount(1);

  // 选中 A，再点连线文字打开编辑浮层（焦点落在关系单选上），按 Delete
  await node(page, ra).locator("[data-quote]").click();
  await expect(node(page, ra)).toHaveAttribute("data-selected", "true");
  await edgeLabel(page).click();
  await expect(page.locator('[data-relation-picker="edit"]')).toBeVisible();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await expect(node(page, ra)).toBeVisible();
  await page.keyboard.press("Escape");

  // 新建连线的浮层里按 Backspace
  await connect(page, `annotation:${b.id}`, "term:t-lstm");
  await page.locator("[data-relation-picker]").getByRole("radio", { name: "扩展" }).focus();
  await page.keyboard.press("Backspace");
  await expect(page.locator("[data-canvas-node]")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // 焦点在侧栏按钮上
  await node(page, ra).locator("[data-quote]").click();
  await page.getByRole("tab", { name: "未整理" }).focus();
  await page.keyboard.press("Delete");
  await expect(node(page, ra)).toBeVisible();

  // 双击术语节点打开术语编辑器，焦点在对话框里
  await node(page, "term:t-lstm").locator("[data-term-name]").dblclick();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-canvas-node]")).toHaveCount(3);

  // 对照：焦点在画布里时 Delete 仍然有效（只移出画布）
  await node(page, ra).locator("[data-quote]").click();
  await page.keyboard.press("Delete");
  await expect(node(page, ra)).toHaveCount(0);
  expect(await dbGet(page, "annotations", a.id)).toBeTruthy();
});

test("撤销删除连线按原 id 恢复（术语弹窗与画布）；另一端已删除时不恢复", async ({ page }) => {
  await seedTerm(page);
  const { anns } = await seedSimple(page, SPECS);
  const a = anns[0];
  const T: Ref = { kind: "term", id: "t-lstm" };
  const A: Ref = { kind: "annotation", id: a.id };
  const l1 = (await createLinkApi(page, T, A, "partOf")) as { id: string };

  // 术语弹窗：删除即生效，提示里有"撤销"
  const pop = await openTermPopover(page, "t-lstm");
  const row = pop.locator(`[data-link-id="${l1.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: "删除连线" }).click();
  await expect(pop.locator("[data-link-id]")).toHaveCount(0);
  const toast = page.locator("[data-annotation-toast]", { hasText: "已删除连线" });
  await expect(toast).toContainText("所有画布");
  await toast.getByRole("button", { name: "撤销" }).click();
  await expect.poll(async () => (await dbAll<{ id: string }>(page, "links")).map((l) => l.id)).toEqual([l1.id]);
  await page.keyboard.press("Escape");
  const again = await openTermPopover(page, "t-lstm");
  await expect(again.locator(`[data-link-id="${l1.id}"]`)).toHaveCount(1);
  await page.keyboard.press("Escape");

  // 画布：删除笔记连线 → 删掉笔记 → 撤销连线：不恢复指向已删除笔记的连线
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "撤销");
  const note = (await page.evaluate(() => (window as unknown as CW).__paperlensCanvas.noteService.createNote("一条笔记"))) as { id: string };
  const N: Ref = { kind: "note", id: note.id };
  await placeApi(page, boardId, A, 0, 0);
  await placeApi(page, boardId, N, 420, 0);
  await placeApi(page, boardId, T, 200, 260);
  const l2 = (await createLinkApi(page, N, A, "contradicts")) as { id: string };
  await expect(edgeLabel(page)).toHaveCount(2);

  // 先删再撤销：原 id
  const del = async (relation: string) => {
    await page.locator(`[data-edge-label][data-relation="${relation}"]`).click();
    await page.locator('[data-relation-picker="edit"]').getByRole("button", { name: "删除连线…" }).click();
    await page.locator("[data-confirm-delete-link]").getByRole("button", { name: "删除连线" }).click();
  };
  await del("partOf");
  await expect(edgeLabel(page)).toHaveCount(1);
  await page.locator("[data-annotation-toast]", { hasText: "已删除连线" }).last().getByRole("button", { name: "撤销" }).click();
  await expect(page.locator('[data-edge-label][data-relation="partOf"]')).toHaveCount(1);
  expect((await dbAll<{ id: string }>(page, "links")).map((l) => l.id).sort()).toEqual([l1.id, l2.id].sort());

  await del("contradicts");
  await hoverClick(page, `note:${note.id}`, "删除笔记");
  await page.locator('[data-canvas-dialog="delete-note"]').getByRole("button", { name: "删除笔记" }).click();
  await expect(node(page, `note:${note.id}`)).toHaveCount(0);
  await page.locator("[data-annotation-toast]", { hasText: "已删除连线" }).last().getByRole("button", { name: "撤销" }).click();
  await expect(page.locator("[data-annotation-toast]", { hasText: "无法恢复" })).toBeVisible();
  expect((await dbAll<{ id: string }>(page, "links")).map((l) => l.id)).toEqual([l1.id]);
});

test("重复连线提示并选中；编辑时可调换方向，改成与已有连线相同时合并", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  const [a, b] = anns;
  const ra = `annotation:${a.id}`;
  const rb = `annotation:${b.id}`;
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "重复");
  await placeApi(page, boardId, { kind: "annotation", id: a.id }, 0, 0);
  await placeApi(page, boardId, { kind: "annotation", id: b.id }, 420, 0);
  await connect(page, ra, rb);
  await chooseRelation(page, "支持");
  await pane(page).click({ position: { x: 600, y: 600 } });
  await connect(page, ra, rb);
  await chooseRelation(page, "支持");
  await expect(page.locator("[data-annotation-toast]", { hasText: "这条连线已存在" })).toBeVisible();
  await expect(edgeLabel(page)).toHaveCount(1);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);

  // 调换方向
  await edgeLabel(page).click();
  const picker = page.locator('[data-relation-picker="edit"]');
  await picker.getByRole("button", { name: "调换方向" }).click();
  await expect(picker.locator("[data-link-ends]")).toContainText("trajectory prediction");
  await chooseRelation(page, "支持");
  const [l] = await dbAll<{ id: string; from: Ref; to: Ref }>(page, "links");
  expect(l.from.id).toBe(b.id);
  expect(l.to.id).toBe(a.id);

  // 再建一条 A→B 反驳，然后把它改成 B→A 支持：与第一条相同，合并
  await connect(page, ra, rb);
  await chooseRelation(page, "反驳");
  await expect(edgeLabel(page)).toHaveCount(2);
  await page.locator('[data-edge-label][data-relation="contradicts"]').click();
  await page.locator('[data-relation-picker="edit"]').getByRole("button", { name: "调换方向" }).click();
  await chooseRelation(page, "支持");
  await expect(page.locator("[data-annotation-toast]", { hasText: "已合并" })).toBeVisible();
  await expect(edgeLabel(page)).toHaveCount(1);
  expect((await dbAll<{ id: string }>(page, "links")).map((x) => x.id)).toEqual([l.id]);
});

test("收件箱“不在本画布上”；论文节点放入全部批注；节点角上的 +k 把另一端放进来", async ({ page }) => {
  const { paperId, anns } = await seedSimple(page, SPECS);
  const [a, b, c] = anns;
  await setView(page, "canvas");
  const b1 = await newBoardApi(page, "第一块");
  await placeApi(page, b1, { kind: "annotation", id: a.id }, 0, 0);
  const b2 = await newBoardApi(page, "第二块");
  // 默认范围：a 已在第一块上，不出现
  await expect(inboxItem(page, `annotation:${a.id}`)).toHaveCount(0);
  await page.locator('[data-inbox-scope="board"]').click();
  await expect(inboxItem(page, `annotation:${a.id}`)).toBeVisible();
  await expect(page.locator("[data-inbox-count]")).toContainText("3 条不在本画布上");
  await inboxItem(page, `annotation:${a.id}`).dragTo(pane(page), { targetPosition: { x: 200, y: 200 } });
  await expect(node(page, `annotation:${a.id}`)).toBeVisible();
  await expect(inboxItem(page, `annotation:${a.id}`)).toHaveCount(0);
  await page.locator('[data-inbox-scope="anywhere"]').click();

  // 论文节点：放入这篇论文的全部批注（a 已在，补 b、c）
  await placeApi(page, b2, { kind: "paper", id: paperId }, 420, 0);
  await hoverClick(page, `paper:${paperId}`, "放入这篇论文的全部批注");
  await expect(page.locator("[data-annotation-toast]", { hasText: "已放入 2 条批注" })).toBeVisible();
  expect((await dbAll<{ boardId: string; ref: Ref }>(page, "boardNodes")).filter((n) => n.boardId === b2 && n.ref.kind === "annotation")).toHaveLength(3);
  await hoverClick(page, `paper:${paperId}`, "放入这篇论文的全部批注");
  await expect(page.locator("[data-annotation-toast]", { hasText: "都已在这块画布上" })).toBeVisible();

  // +k：c → 术语（不在画布上）
  await seedTerm(page);
  await hoverClick(page, `annotation:${c.id}`, "移出画布");
  await createLinkApi(page, { kind: "annotation", id: a.id }, { kind: "term", id: "t-lstm" }, "extends");
  await createLinkApi(page, { kind: "annotation", id: c.id }, { kind: "annotation", id: a.id }, "compares");
  const ext = node(page, `annotation:${a.id}`).locator("[data-external-links]");
  await expect(ext).toHaveText("+2");
  await ext.click();
  const popover = page.locator("[data-external-popover]");
  await expect(popover.locator("[data-external-item]")).toHaveCount(2);
  await expect(popover.locator('[data-external-item="term:t-lstm"]')).toContainText("→ 扩展");
  await expect(popover.locator(`[data-external-item="annotation:${c.id}"]`)).toContainText("← 对比");
  await popover.locator('[data-external-item="term:t-lstm"]').getByRole("button", { name: "放到画布" }).click();
  await expect(node(page, "term:t-lstm")).toBeVisible();
  await expect(page.locator('[data-edge-label][data-relation="extends"]')).toHaveCount(1);
  await expect(ext).toHaveText("+1");
});

test("角注：在画布上但没有笔记的批注，色条上有小点，点开后可回到画布", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  const b = anns[1]; // 没有笔记
  await expect(page.locator(`[data-margin-marker="${b.id}"] [data-canvas-dot]`)).toHaveCount(0);
  const boardId = await page.evaluate(async () => (await (window as unknown as CW).__paperlensCanvas.canvasService.createBoard("角注")).id);
  await placeApi(page, boardId, { kind: "annotation", id: b.id }, 0, 0);
  const marker = page.locator(`[data-margin-marker="${b.id}"]`);
  await expect(marker.locator("[data-canvas-dot]")).toHaveCount(1);
  await marker.click();
  const badge = page.locator(`[data-margin-card="${b.id}"] [data-canvas-badge]`);
  await expect(badge.locator("[data-badge-boards]")).toHaveText("1");
  await badge.click();
  await expect.poll(() => view(page)).toBe("canvas");
  await expect(node(page, `annotation:${b.id}`)).toHaveAttribute("data-selected", "true");
});

test("视口只存在本浏览器（localStorage），平移画布不写 boards 表", async ({ page }) => {
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "视口");
  const before = (await dbGet<{ updatedAt: number; viewport?: unknown }>(page, "boards", boardId))!;
  await pane(page).hover();
  await page.mouse.wheel(200, 120);
  await page.locator(".react-flow__controls-zoomout").click();
  await page.waitForTimeout(600);
  const after = (await dbGet<{ updatedAt: number; viewport?: unknown }>(page, "boards", boardId))!;
  expect(after).toEqual(before);
  expect(after.viewport).toBeUndefined();
  const stored = await page.evaluate((id) => JSON.parse(localStorage.getItem(`paperlens.canvas.viewport.${id}`) ?? "null"), boardId);
  expect(stored).toMatchObject({ zoom: expect.any(Number) });
  expect(stored.zoom).toBeLessThan(1);
});

test("术语弹窗里的笔记可点击跳到画布；搜索能找到笔记；空搜索列出最近术语；结果实时更新", async ({ page }) => {
  await seedTerm(page);
  const { anns } = await seedSimple(page, [SPECS[1]]);
  const note = (await page.evaluate(() => (window as unknown as CW).__paperlensCanvas.noteService.createNote("门控机制的思考"))) as { id: string };
  const boardId = await page.evaluate(async () => (await (window as unknown as CW).__paperlensCanvas.canvasService.createBoard("笔记")).id);
  await placeApi(page, boardId, { kind: "note", id: note.id }, 0, 0);

  // 术语弹窗：搜索笔记并连线，点击笔记条目 → 画布定位
  const pop = await openTermPopover(page, "t-lstm");
  const related = pop.locator("[data-term-related]");
  await related.getByRole("button", { name: "添加连线" }).click();
  await related.locator("[data-link-search]").fill("门控机制");
  await related.locator(`[data-link-result="note:${note.id}"]`).click();
  await related.getByRole("button", { name: "添加连线" }).click();
  await related.locator(`[data-link-id]`).getByRole("button").first().click();
  await expect.poll(() => view(page)).toBe("canvas");
  await expect(node(page, `note:${note.id}`)).toHaveAttribute("data-selected", "true");

  // 搜索页：空查询列出最近术语
  await page.getByRole("tab", { name: "搜索添加" }).click();
  await expect(page.locator('[data-search-group="term"]')).toContainText("最近的术语");
  await expect(page.locator('[data-search-result="term:t-lstm"]')).toBeVisible();
  // 结果实时更新：批注在别处被删除后从结果里消失
  await page.getByLabel("搜索要添加的条目").fill("core function");
  const r = page.locator(`[data-search-result="annotation:${anns[0].id}"]`);
  await expect(r).toBeVisible();
  await page.evaluate((id) => (window as unknown as CW & { __paperlensAnnotation: { annotationService: { deleteAnnotation(id: string): Promise<unknown> } } }).__paperlensAnnotation.annotationService.deleteAnnotation(id), anns[0].id);
  await expect(r).toHaveCount(0);
});

test("关联了领域的画布上，回到“未整理”的自由笔记不会被领域筛选藏起来；论文/颜色筛选时提示隐藏数", async ({ page }) => {
  await page.evaluate(() => (window as unknown as CW).__paperlens.db.domains.bulkPut([{ id: "d1", name: "轨迹预测", parentId: null, color: "#3b82f6", order: 0 }]));
  await seedSimple(page, [SPECS[0]]);
  const note = (await page.evaluate(() => (window as unknown as CW).__paperlensCanvas.noteService.createNote("保留下来的笔记"))) as { id: string };
  await setView(page, "canvas");
  const boardId = await page.evaluate(async () => {
    const c = (window as unknown as CW).__paperlensCanvas;
    const b = await c.canvasService.createBoard("有领域", ["d1"]);
    c.useCanvasStore.getState().openBoard(b.id);
    return b.id;
  });
  void boardId;
  await expect(page.locator("[data-inbox-domain]")).toHaveValue("board");
  await expect(inboxItem(page, `note:${note.id}`)).toBeVisible();
  await page.locator('[data-inbox-color="#bbf7d0"]').click();
  await expect(inboxItem(page, `note:${note.id}`)).toHaveCount(0);
  await expect(page.locator("[data-hidden-notes]")).toHaveText("另有 1 条自由笔记被论文/颜色筛选隐藏");
});

test("连线手柄热区：从边缘中点以外的位置也能拖出连线；未定位的批注节点有标记", async ({ page }) => {
  const { anns } = await seedSimple(page, SPECS);
  const [a, b] = anns;
  // 换文件后找不到原文的批注：矩形为空、状态 orphaned
  await page.evaluate((id) => (window as unknown as CW).__paperlens.db.annotations.update(id, { anchorStatus: "orphaned", rects: [] }), b.id);
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "手柄");
  await placeApi(page, boardId, { kind: "annotation", id: a.id }, 0, 0);
  await placeApi(page, boardId, { kind: "annotation", id: b.id }, 420, 0);
  await expect(node(page, `annotation:${b.id}`).locator("[data-orphaned]")).toHaveText("未定位");
  await expect(node(page, `annotation:${a.id}`).locator("[data-orphaned]")).toHaveCount(0);

  const src = node(page, `annotation:${a.id}`);
  const box = (await src.boundingBox())!;
  const t = (await node(page, `annotation:${b.id}`).boundingBox())!;
  // 右边缘、离中点 15% 高度、边框外 4px 处按下
  await src.hover();
  await page.mouse.move(box.x + box.width + 4, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('[data-relation-picker="create"]')).toBeVisible();
});

test("术语删除确认列出连线数和所在画布数", async ({ page }) => {
  await seedTerm(page);
  const { anns } = await seedSimple(page, SPECS);
  const T: Ref = { kind: "term", id: "t-lstm" };
  await createLinkApi(page, T, { kind: "annotation", id: anns[0].id });
  await createLinkApi(page, { kind: "annotation", id: anns[1].id }, T, "extends");
  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "术语删除");
  await placeApi(page, boardId, T, 0, 0);
  await node(page, "term:t-lstm").locator("[data-term-name]").dblclick();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: "删除术语" }).click();
  await expect(dlg.locator("[data-term-delete-confirm]")).toContainText("将同时删除 2 条连线和 1 块画布上的节点");
  await page.keyboard.press("Escape");

  // 术语表的删除对话框
  await setView(page, "glossary");
  await page.getByRole("option", { name: /^Long Short-Term Memory/ }).click();
  await page.getByRole("complementary", { name: "术语详情" }).getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("将同时删除 2 条连线和 1 块画布上的节点");
});

// ---------------------------------------------------------------------------
// 性能：600 个节点 + 800 条连线
// ---------------------------------------------------------------------------

test("性能：600 节点 + 800 连线", async ({ page }) => {
  test.setTimeout(120_000);
  const boardId = await page.evaluate(async () => {
    const { db } = (window as unknown as CW).__paperlens;
    const now = Date.now();
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const papers = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, fileHash: `h${i}`, title: `Paper ${i} on trajectory prediction with recurrent networks`, authors: ["A. Author", "B. Author"], year: 2000 + (i % 25), domainIds: [], pageCount: 10, addedAt: now }));
    const anns = Array.from({ length: 250 }, (_, i) => ({
      id: `a${i}`,
      paperId: `p${i % 50}`,
      page: 1 + (i % 9),
      rects: [[72, 600, 300, 612]],
      quote: { exact: `Annotation ${i}: Long Short-Term Memory networks capture long-range dependencies in sequential data.`, prefix: "", suffix: "" },
      fileHash: `h${i % 50}`,
      color: ["#fde68a", "#bbf7d0", "#bfdbfe", "#fbcfe8", "#ddd6fe"][i % 5],
      note: i % 3 ? `笔记 ${i}：**门控**机制与 $\\sigma(x)$ 的关系\n\n- 要点一\n- 要点二` : "",
      createdAt: now,
      updatedAt: now,
    }));
    const terms = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: `Term ${i}`, aliases: [`T${i}`], matchMode: "auto", scope: { kind: "global" }, note: `术语 ${i} 的说明，含公式 $e^{i\\pi}+1=0$`, createdAt: now, updatedAt: now }));
    const notes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, text: `## 想法 ${i}\n自由笔记内容 **${i}**`, createdAt: now, updatedAt: now }));
    const refs = [
      ...anns.map((a) => ({ kind: "annotation", id: a.id })),
      ...terms.map((t) => ({ kind: "term", id: t.id })),
      ...papers.map((p) => ({ kind: "paper", id: p.id })),
      ...notes.map((n) => ({ kind: "note", id: n.id })),
    ];
    const boardId = "perf-board";
    const nodes = refs.map((ref, i) => ({ id: `bn${i}`, boardId, ref, x: (i % 30) * 320, y: Math.floor(i / 30) * 220, w: 260, h: 150 }));
    const links = Array.from({ length: 800 }, (_, i) => {
      const s = Math.floor(rnd() * refs.length);
      let t = s + 1 + Math.floor(rnd() * 40);
      if (t >= refs.length) t = s - 1 - Math.floor(rnd() * 40);
      return { id: `l${i}`, from: refs[s], to: refs[t], relation: ["supports", "contradicts", "extends", "compares", "partOf", "custom"][i % 6], label: i % 6 === 5 ? "相关" : undefined, createdAt: now + i };
    });
    await db.papers.bulkPut(papers);
    await db.annotations.bulkPut(anns);
    await db.terms.bulkPut(terms);
    await db.notes.bulkPut(notes);
    await db.boards.put({ id: boardId, name: "性能", domainIds: [], createdAt: now, updatedAt: now, viewport: { x: 0, y: 0, zoom: 1 } });
    await db.boardNodes.bulkPut(nodes);
    await db.links.bulkPut(links);
    return boardId;
  });

  // 帧时间记录
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rec: boolean };
    w.__frames = [];
    w.__rec = false;
    let last = 0;
    const tick = (t: number) => {
      if (w.__rec) w.__frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const record = async (fn: () => Promise<void>) => {
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __rec: boolean };
      w.__frames = [];
      w.__rec = true;
    });
    await fn();
    const frames = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __rec: boolean };
      w.__rec = false;
      return w.__frames.slice(1);
    });
    const s = [...frames].sort((x, y) => x - y);
    const q = (r: number) => s[Math.min(s.length - 1, Math.floor(r * s.length))] ?? NaN;
    return { n: s.length, median: q(0.5), p95: q(0.95), max: s.at(-1) ?? NaN };
  };
  const fmt = (r: { n: number; median: number; p95: number; max: number }) => `帧数 ${r.n}，中位 ${r.median.toFixed(1)}ms，p95 ${r.p95.toFixed(1)}ms，最长 ${r.max.toFixed(1)}ms`;

  const t0 = Date.now();
  await page.evaluate((id) => (window as unknown as CW).__paperlensCanvas.useCanvasStore.getState().openBoard(id), boardId);
  await expect(page.locator("[data-canvas-node]").first()).toBeVisible({ timeout: 20_000 });
  await expect(edgeLabel(page).first()).toBeVisible();
  const openMs = Date.now() - t0;
  const visible1 = await page.locator("[data-canvas-node]").count();

  // 视口内拖动平移
  const box = (await page.locator("[data-canvas-flow]").boundingBox())!;
  const panAt100 = await record(async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(30, 20);
  });

  // 显示全部（600 个节点同时在视口内）
  const fitStart = Date.now();
  const fit = await record(async () => {
    await page.locator("[data-fit-view]").click();
    await page.waitForTimeout(600);
  });
  const fitMs = Date.now() - fitStart;
  const visibleAll = await page.locator("[data-canvas-node]").count();
  const edgesAll = await page.locator(".react-flow__edge").count();
  const panAll = await record(async () => {
    for (let i = 0; i < 40; i++) await page.mouse.wheel(10, 6);
  });

  // 放大到能看清 Markdown 的缩放（约 50%），平移并拖动一个节点
  for (let i = 0; i < 11; i++) await page.locator(".react-flow__controls-zoomin").click();
  await page.waitForTimeout(600);
  const zoomMid = await page.locator(".react-flow__viewport").evaluate((el) => Number(/scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1]));
  const panMid = await record(async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(-25, -15);
  });
  const visibleMid = await page.locator("[data-canvas-node]").count();
  const target = page.locator("[data-canvas-node]").first();
  const tb = (await target.boundingBox())!;
  const drag = await record(async () => {
    await page.mouse.move(tb.x + 30, tb.y + 8);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(tb.x + 30 + i * 6, tb.y + 8 + i * 3);
    await page.mouse.up();
  });

  const summary = [
    `打开画布（600 节点 / 800 连线，100% 缩放）：${openMs}ms，渲染节点 ${visible1} 个`,
    `100% 缩放平移：${fmt(panAt100)}`,
    `显示全部：${fitMs}ms，渲染节点 ${visibleAll} 个、连线 ${edgesAll} 条；动画 ${fmt(fit)}`,
    `全部可见时平移：${fmt(panAll)}`,
    `缩放 ${(zoomMid * 100).toFixed(0)}% 时平移（渲染节点 ${visibleMid} 个，Markdown 延迟渲染）：${fmt(panMid)}`,
    `拖动节点（同一缩放）：${fmt(drag)}`,
  ].join("\n");
  console.log(`[canvas-perf]\n${summary}`);
  test.info().annotations.push({ type: "perf", description: summary });

  expect(visible1).toBeLessThan(120); // 只渲染视口内的节点
  expect(visibleAll).toBe(600);
  expect(openMs).toBeLessThan(5000);
  expect(panAt100.median).toBeLessThan(50);
  expect(panMid.median).toBeLessThan(50);
  expect(drag.median).toBeLessThan(50);
});

// ---------------------------------------------------------------------------
// 真实论文截图（需要 PAPERLENS_LITERATURE_DIR 和 PAPERLENS_SHOTS_DIR）
// ---------------------------------------------------------------------------

test("真实论文：RoFormer 的批注与术语整理成网络（截图）", async ({ page }) => {
  test.skip(!LIT || !SHOTS, "未设置 PAPERLENS_LITERATURE_DIR / PAPERLENS_SHOTS_DIR");
  test.setTimeout(120_000);
  const file = realPaper("roformer");
  test.skip(!file, "real-papers.local.json 里没有 roformer");
  // 只在浏览器内存（IndexedDB）里读取，不复制进仓库
  const paperId = await addPaper(page, readFileSync(file!), "roformer", "RoFormer: Enhanced Transformer with Rotary Position Embedding");
  await page.evaluate(() =>
    (window as unknown as CW).__paperlens.db.papers.update("roformer", { authors: ["Jianlin Su", "Yu Lu", "Shengfeng Pan", "Ahmed Murtadha", "Bo Wen", "Yunfeng Liu"], year: 2021 }),
  );
  const now = Date.now();
  await page.evaluate(
    (now) =>
      (window as unknown as CW).__paperlens.db.terms.bulkPut([
        { id: "t-rope", name: "Rotary Position Embedding", aliases: ["RoPE"], matchMode: "auto", scope: { kind: "global" }, note: "用**旋转矩阵**编码绝对位置，使注意力内积只依赖相对位置 $m-n$。", createdAt: now, updatedAt: now },
        { id: "t-sa", name: "self-attention", aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "$\\mathrm{softmax}(QK^\\top/\\sqrt{d})V$", createdAt: now, updatedAt: now },
        { id: "t-tf", name: "Transformer", aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: now, updatedAt: now },
      ]),
    now,
  );
  await store(page).open(paperId);
  await waitGlyphs(page, 1);
  const wanted = [
    { text: "Rotary Position Embedding(RoPE)", color: "#fde68a", note: "核心贡献：**旋转**位置编码" },
    { text: "Rotary Position Embedding (RoPE)", color: "#fde68a", note: "核心贡献：**旋转**位置编码" },
    { text: "encodes the absolute position with a rotation matrix", color: "#bbf7d0", note: "绝对位置 → 旋转矩阵 $R_{\\Theta,m}$" },
    { text: "explicit relative position dependency in self-attention formulation", color: "#bbf7d0", note: "相对位置在内积里自然出现" },
    { text: "the flexibility of sequence length", color: "#bfdbfe", note: "可外推到更长序列？" },
    { text: "decaying inter-token dependency with increasing relative distances", color: "#fbcfe8", note: "远距离 token 的依赖随距离衰减" },
    { text: "equipping the linear self-attention with relative position encoding", color: "#ddd6fe", note: "兼容线性注意力" },
  ];
  const anns: Ann[] = [];
  const seen = new Set<string>();
  for (const w of wanted) {
    const key = w.note;
    if (seen.has(key)) continue;
    const anchor = await anchorFor(page, 1, w.text);
    if (!anchor) continue;
    seen.add(key);
    anns.push(await createAnn(page, anchor, w.color, w.note));
  }
  expect(anns.length).toBeGreaterThanOrEqual(4);

  await setView(page, "canvas");
  const boardId = await newBoardApi(page, "RoFormer 方法梳理");
  const A = anns.map((a) => ({ kind: "annotation" as const, id: a.id }));
  const note1 = (await page.evaluate(() =>
    (window as unknown as CW).__paperlensCanvas.noteService.createNote("**问题**：RoPE 的长度外推能力不如 ALiBi？\n\n需要对照 *Press et al. 2022*"),
  )) as { id: string };
  const N = { kind: "note" as const, id: note1.id };
  const layout: [Ref, number, number, number?, number?][] = [
    [{ kind: "paper", id: "roformer" }, 380, -260, 300, 96],
    [{ kind: "term", id: "t-rope" }, 400, -80, 260, 130],
    [A[0], 40, 120, 270, 150],
    [A[1], 380, 140, 270, 150],
    [A[2], 720, 120, 270, 150],
    [{ kind: "term", id: "t-sa" }, 760, -100, 230, 110],
    [A[3] ?? N, 40, 360, 270, 150],
    [N, 720, 360, 270, 140],
    [{ kind: "term", id: "t-tf" }, 60, -100, 200, 80],
  ];
  for (const [ref, x, y, w, h] of layout) {
    await page.evaluate(
      ({ boardId, ref, x, y, w, h }) => (window as unknown as CW).__paperlensCanvas.canvasService.addNodeToBoard(boardId, ref, { x, y }, w && h ? { w, h } : undefined),
      { boardId, ref, x, y, w, h },
    );
  }
  const link = (from: Ref, to: Ref, relation: string, label?: string) =>
    page.evaluate((i) => (window as unknown as CW).__paperlensCanvas.linkService.createLink(i), { from, to, relation, label });
  await link({ kind: "term", id: "t-rope" }, { kind: "paper", id: "roformer" }, "partOf");
  await link(A[0], { kind: "term", id: "t-rope" }, "supports", "定义");
  await link(A[1], { kind: "term", id: "t-rope" }, "extends");
  await link(A[2], { kind: "term", id: "t-sa" }, "custom", "作用于");
  await link({ kind: "term", id: "t-tf" }, { kind: "term", id: "t-rope" }, "compares", "绝对 vs 旋转");
  if (A[3]) await link(A[3], A[0], "supports");
  await link(N, A[2], "contradicts", "存疑");
  await page.locator("[data-fit-view]").click();
  await expect(page.locator("[data-canvas-node]")).toHaveCount(9);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SHOTS!, "canvas-network.png") });

  // 选中一个批注节点并打开连线编辑浮层
  await node(page, `annotation:${A[0].id}`).locator("[data-quote]").click();
  await page.locator('[data-edge-label][data-relation="supports"]').first().click();
  await expect(page.locator('[data-relation-picker="edit"]')).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS!, "canvas-edit.png") });
  await page.keyboard.press("Escape");

  // 阅读器：角注上的连线数
  await node(page, `annotation:${A[0].id}`).locator("[data-quote]").dblclick();
  await expect.poll(() => view(page)).toBe("reader");
  await expect(page.locator(`[data-margin-card="${A[0].id}"] [data-badge-links]`)).toHaveText(A[3] ? "2" : "1");
  await page.waitForTimeout(2200); // 等闪烁结束
  await page.screenshot({ path: join(SHOTS!, "canvas-margin.png") });
});

