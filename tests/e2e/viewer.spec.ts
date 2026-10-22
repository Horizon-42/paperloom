/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 阅读器 e2e：通过开发模式的 window.__paperlens 直接写入 fixture PDF 并打开。
// 单独运行：npx playwright test -c tests/e2e/viewer.config.ts
// 设置 PAPERLENS_LITERATURE_DIR 时额外用真实论文检查渲染耗时（只在浏览器内读取，不复制进仓库）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  LIT,
  addFixture,
  addPaper,
  boot,
  pane,
  pageEl,
  shot,
  store,
  waitRendered,
  type PageRenderTiming,
  type W,
} from "./viewerHelpers";

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test("渲染 canvas 与文本层", async ({ page }) => {
  const id = await addFixture(page, "simple.pdf", "Simple");
  await store(page).open(id);
  await waitRendered(page, 1);

  const info = await pageEl(page, 1).evaluate((el) => {
    const c = el.querySelector("canvas")!;
    return {
      cssW: el.getBoundingClientRect().width,
      canvasW: c.width,
      dpr: window.devicePixelRatio,
      spans: el.querySelectorAll(".textLayer span").length,
      text: el.querySelector(".textLayer")!.textContent,
    };
  });
  expect(info.spans).toBeGreaterThan(5);
  expect(info.text).toContain("LSTM");
  expect(info.text).toContain("Long Short-Term Memory");
  expect(Math.abs(info.canvasW - info.cssW * info.dpr)).toBeLessThanOrEqual(2);

  // 标签标题来自 db.papers
  await expect(pane(page).locator('[role="tab"]')).toHaveText(/Simple/);
  await expect(page.locator("[data-page-count]")).toHaveText("/ 10");
  await shot(page, "single");
});

test("懒加载：只渲染可视区域前后 2 页，滚走的页释放 canvas", async ({ page }) => {
  const id = await addFixture(page, "long.pdf", "Long");
  await store(page).open(id);
  await waitRendered(page, 1);

  const rendered = () => pane(page).locator(".pl-page canvas").count();
  expect(await pane(page).locator(".pl-page").count()).toBe(50);
  expect(await rendered()).toBeLessThanOrEqual(5);
  await expect(pageEl(page, 10).locator("canvas")).toHaveCount(0);

  await page.locator("[data-viewer-scroll]").evaluate((el) => {
    const target = el.querySelector<HTMLElement>('.pl-page[data-page-number="30"]')!;
    el.scrollTop = target.parentElement!.offsetTop - 20;
  });
  await waitRendered(page, 30);
  await expect(pageEl(page, 1).locator("canvas")).toHaveCount(0);
  await expect(pageEl(page, 1).locator(".textLayer")).toHaveCount(0);
  expect(await rendered()).toBeLessThanOrEqual(6);
  await expect(page.getByLabel("页码")).toHaveValue(/^(29|30|31)$/);
});

test("缩放后 canvas 与文本层尺寸一致，视口中心不跳", async ({ page }) => {
  const id = await addFixture(page, "simple.pdf", "Simple");
  await store(page).open(id);
  await waitRendered(page, 1);
  const scroll = page.locator("[data-viewer-scroll]");
  await scroll.evaluate((el) => (el.scrollTop = 1500));
  await waitRendered(page, 2);

  // 视口中心对应的页码与页内比例
  const centerAnchor = () =>
    scroll.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      for (const p of el.querySelectorAll<HTMLElement>(".pl-page")) {
        const b = p.getBoundingClientRect();
        if (cy >= b.top && cy <= b.bottom) return { page: Number(p.dataset.pageNumber), frac: (cy - b.top) / b.height };
      }
      return null;
    });
  const before = await centerAnchor();
  const label = page.locator("[data-zoom-label]");
  const zoomBefore = await label.textContent();

  await page.getByRole("button", { name: /放大/ }).click();
  await page.getByRole("button", { name: /放大/ }).click();
  await expect(label).not.toHaveText(zoomBefore!);
  const after = await centerAnchor();
  expect(after!.page).toBe(before!.page);
  expect(Math.abs(after!.frac - before!.frac)).toBeLessThan(0.02);

  // 等重绘完成：canvas 位图宽度 ≈ 页面 CSS 宽度 × dpr
  const n = after!.page;
  await expect
    .poll(
      () =>
        pageEl(page, n).evaluate((el) => {
          const c = el.querySelector("canvas");
          return c ? Math.abs(c.width - el.getBoundingClientRect().width * window.devicePixelRatio) : 999;
        }),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(2);
  const sizes = await pageEl(page, n).evaluate((el) => {
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    };
    return { page: box(el), canvas: box(el.querySelector("canvas")!), text: box(el.querySelector(".textLayer")!) };
  });
  expect(sizes.canvas).toEqual(sizes.page);
  expect(sizes.text).toEqual(sizes.page);

  // Ctrl+0 回到 100%，Ctrl+- 缩小一档
  await scroll.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+0");
  await expect(label).toHaveText("100%");
  await page.keyboard.press("Control+-");
  await expect(label).toHaveText("90%");
  // Ctrl+滚轮
  await scroll.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(label).toHaveText("100%");
  await page.getByRole("button", { name: "适合宽度" }).click();
  await expect(page.getByRole("button", { name: "适合宽度" })).toHaveAttribute("aria-pressed", "true");
});

test("分屏打开两篇；同一论文两栏共享一个文档，最后关闭时销毁", async ({ page }) => {
  const a = await addFixture(page, "simple.pdf", "Simple");
  const b = await addFixture(page, "two-column.pdf", "Two Column");
  await store(page).open(a);
  await waitRendered(page, 1, "left");
  await page.locator('[data-pane="left"] [data-split-toggle]').click();
  await store(page).open(b); // 分屏后聚焦右栏
  await waitRendered(page, 1, "right");
  await waitRendered(page, 1, "left");
  await expect(pane(page, "right").locator('[role="tab"]')).toHaveText(/Two Column/);
  const boxes = await page.evaluate(() =>
    ["left", "right"].map((id) => document.querySelector(`[data-pane="${id}"]`)!.getBoundingClientRect().width),
  );
  expect(Math.abs(boxes[0] - boxes[1])).toBeLessThan(10);
  await shot(page, "split");

  // 拖动分隔条
  const divider = page.locator("[data-split-divider]");
  const d = (await divider.boundingBox())!;
  await page.mouse.move(d.x + d.width / 2, d.y + 200);
  await page.mouse.down();
  await page.mouse.move(d.x - 200, d.y + 200, { steps: 5 });
  await page.mouse.up();
  const leftW = await pane(page, "left").evaluate((el) => el.getBoundingClientRect().width);
  expect(leftW).toBeLessThan(boxes[0] - 150);

  // 同一篇在两栏打开
  await store(page).open(a, "right");
  await waitRendered(page, 1, "right");
  const stats = () => page.evaluate(() => (window as unknown as W).__paperlensPdfDocs.stats());
  let s = await stats();
  expect(s.entries.find((e) => e.paperId === a)?.refs).toBeGreaterThanOrEqual(2);
  const loadsBefore = s.loads;
  await store(page).close("right", a);
  await page.waitForTimeout(100);
  s = await stats();
  expect(s.entries.find((e) => e.paperId === a)).toBeTruthy(); // 左栏仍在用
  expect(s.loads).toBe(loadsBefore);
  await store(page).close("left", a);
  await expect.poll(async () => (await stats()).entries.find((e) => e.paperId === a)).toBeUndefined();
  expect((await stats()).destroys).toBeGreaterThanOrEqual(1);
});

test("jumpTo 跳到指定页并派发 paperlens:jumped", async ({ page }) => {
  const id = await addFixture(page, "long.pdf", "Long");
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__jumped = [];
    window.addEventListener("paperlens:jumped", (e) => w.__jumped!.push((e as CustomEvent).detail));
  });
  // 论文未打开时 jumpTo 会先打开
  await store(page).jump({ paperId: id, page: 37, pdfPoint: [0, 400] });
  await waitRendered(page, 37);
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__jumped!.length)).toBe(1);
  const detail = await page.evaluate(() => (window as unknown as W).__jumped![0] as { page: number; seq: number });
  expect(detail.page).toBe(37);
  // pdfPoint y=400 的位置在视口内
  const visible = await page.locator("[data-viewer-scroll]").evaluate((el) => {
    const p = el.querySelector<HTMLElement>('.pl-page[data-page-number="37"]')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const y = p.top + (1 - 400 / 792) * p.height;
    return y > r.top && y < r.bottom;
  });
  expect(visible).toBe(true);
  await expect(page.getByLabel("页码")).toHaveValue("37");

  // 已打开时再次跳转
  await store(page).jump({ paperId: id, page: 5 });
  await waitRendered(page, 5);
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__jumped!.length)).toBe(2);
  await expect(page.getByLabel("页码")).toHaveValue("5");

  // 页码输入框跳页
  await page.getByLabel("页码").fill("12");
  await page.getByLabel("页码").press("Enter");
  await waitRendered(page, 12);
  await expect(page.getByLabel("页码")).toHaveValue("12");
});

test("切换标签后恢复滚动位置和缩放；隐藏阅读器再显示保持位置", async ({ page }) => {
  const a = await addFixture(page, "long.pdf", "Long");
  const b = await addFixture(page, "simple.pdf", "Simple");
  await store(page).open(a);
  await waitRendered(page, 1);
  await page.getByRole("button", { name: /放大/ }).click();
  await store(page).jump({ paperId: a, page: 20 });
  await waitRendered(page, 20);
  const zoom = await page.locator("[data-zoom-label]").textContent();

  await store(page).open(b);
  await waitRendered(page, 1);
  await expect(page.getByLabel("页码")).toHaveValue("1");
  await pane(page).locator(`[data-tab="${a}"]`).click();
  await waitRendered(page, 20);
  await expect(page.getByLabel("页码")).toHaveValue("20");
  await expect(page.locator("[data-zoom-label]")).toHaveText(zoom!);

  // 切到其他视图（阅读器 display: none）再回来
  await page.evaluate(() => (window as unknown as W).__paperlens.useAppStore.getState().setView("glossary"));
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as unknown as W).__paperlens.useAppStore.getState().setView("reader"));
  await expect(page.getByLabel("页码")).toHaveValue("20");
  await expect(pageEl(page, 20).locator("canvas")).toHaveCount(1);

  // 中键关闭标签
  await pane(page).locator(`[data-tab="${b}"]`).click({ button: "middle" });
  await expect(pane(page).locator('[role="tab"]')).toHaveCount(1);
});

test("跨行拖选文字", async ({ page }) => {
  const id = await addFixture(page, "two-column.pdf", "Two Column");
  await store(page).open(id);
  await waitRendered(page, 1);
  const spans = pageEl(page, 1).locator(".textLayer > span, .textLayer .markedContent > span");
  const first = (await spans.nth(1).boundingBox())!;
  const later = (await spans.nth(4).boundingBox())!;
  await page.mouse.move(first.x + 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(later.x + later.width * 0.6, later.y + later.height / 2, { steps: 10 });
  await page.mouse.up();
  const sel = await page.evaluate(() => window.getSelection()!.toString());
  expect(sel).toContain("networks in many sequence");
  expect(sel.split("\n").length).toBeGreaterThanOrEqual(3);
  await shot(page, "selection");
});

test("覆盖层按 slot 渲染，ctx.text 在文本层完成后提供", async ({ page }) => {
  const id = await addFixture(page, "simple.pdf", "Simple");
  // 组件直接返回字符串，不需要在页面里拿到 React
  await page.evaluate(() => {
    type Ctx = {
      pageNumber: number;
      pageEl: HTMLElement;
      viewport: { width: number };
      text: { items: { str: string }[]; divs: HTMLElement[]; layerEl: HTMLElement; normalized: { text: string } } | null;
    };
    const describe = (slot: string) => ({ ctx }: { ctx: Ctx }) => {
      const t = ctx.text;
      const info = t
        ? `items=${t.items.length};divs=${t.divs.length};lstm=${t.normalized.text.includes("LSTM")};layer=${t.layerEl.classList.contains("textLayer")}`
        : "pending";
      return `${slot}|p${ctx.pageNumber}|w${Math.round(ctx.viewport.width)}|${info}`;
    };
    const reg = (window as unknown as { __paperlensViewer: { pageOverlays: unknown[] } }).__paperlensViewer.pageOverlays;
    for (const slot of ["under-text", "over-text", "margin"]) reg.push({ key: `test-${slot}`, slot, Component: describe(slot) });
  });
  await store(page).open(id);
  await waitRendered(page, 1);
  const p1 = pageEl(page, 1);
  await expect(p1.locator(".pl-layer-under")).toContainText(/under-text\|p1\|w\d+\|items=\d+;divs=\d+;lstm=true;layer=true/);
  await expect(p1.locator(".pl-layer-over")).toContainText("over-text|p1");
  const margin = pane(page).locator('[data-page-margin="1"]');
  await expect(margin).toContainText("margin|p1");
  const t = (await p1.locator(".pl-layer-under").textContent())!;
  const [, items, divs] = /items=(\d+);divs=(\d+)/.exec(t)!;
  expect(items).toBe(divs);
  // 页边栏在页面右侧，与页面同高，宽度为 MARGIN_WIDTH
  const geo = await page.evaluate(() => {
    const pageBox = document.querySelector('.pl-page[data-page-number="1"]')!.getBoundingClientRect();
    const m = document.querySelector('[data-page-margin="1"]')!;
    const mb = m.getBoundingClientRect();
    const w = (window as unknown as { __paperlensViewer: { MARGIN_WIDTH: number } }).__paperlensViewer.MARGIN_WIDTH;
    return { adjacent: Math.round(mb.left - pageBox.right), sameHeight: Math.round(mb.height - pageBox.height), width: Math.round(mb.width), expected: w, position: getComputedStyle(m).position };
  });
  expect(geo).toMatchObject({ adjacent: 0, sameHeight: 0, width: geo.expected, position: "relative" });
  // 层叠顺序：canvas < under-text < 文本层 < over-text
  const z = await p1.evaluate((el) =>
    [".pl-canvas-host", ".pl-layer-under", ".pl-text-host", ".pl-layer-over"].map((s) => getComputedStyle(el.querySelector(s)!).zIndex),
  );
  expect(z).toEqual(["auto", "1", "2", "3"]);
  // 离开渲染范围的页不挂载覆盖层
  await expect(pageEl(page, 9).locator(".pl-layer-under")).toHaveText("");
});

test("连字 PDF 的文本层保留 ﬁ，复制时规范化", async ({ page }) => {
  const id = await addFixture(page, "ligature.pdf", "Ligature");
  await store(page).open(id);
  await waitRendered(page, 1);
  const text = await pageEl(page, 1).locator(".textLayer").textContent();
  expect(text).toContain("ﬁ");
  expect(text).toContain("ﬂ");
  // 选中含 ﬁ 的 span 后复制：剪贴板里是 fi
  const copied = await pageEl(page, 1).evaluate((el) => {
    const span = [...el.querySelectorAll(".textLayer span")].find((s) => s.textContent!.includes("ﬁ"))!;
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    span.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    return { selected: sel.toString(), copied: dt.getData("text/plain") };
  });
  expect(copied.selected).toContain("ﬁ");
  expect(copied.copied).not.toContain("ﬁ");
  expect(copied.copied).toContain("fi");
  await shot(page, "ligature");
});

test("渲染耗时（fixture）", async ({ page }) => {
  const id = await addFixture(page, "long.pdf", "Long");
  await store(page).open(id);
  await waitRendered(page, 1);
  // 连续滚动整篇
  const scroll = page.locator("[data-viewer-scroll]");
  const total = await scroll.evaluate((el) => el.scrollHeight);
  for (let y = 0; y < total; y += 400) {
    await scroll.evaluate((el, y) => (el.scrollTop = y), y);
    await page.waitForTimeout(16);
  }
  await waitRendered(page, 50);
  const perf = await page.evaluate(() => (window as unknown as W).__paperlensPerf ?? []);
  const initial = perf.filter((p) => p.kind === "initial");
  const sorted = initial.map((p) => p.totalMs).sort((a, b) => a - b);
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(`[perf] long.pdf: ${initial.length} 次首次渲染，中位 ${pct(0.5).toFixed(0)} ms，p90 ${pct(0.9).toFixed(0)} ms，最大 ${sorted.at(-1)!.toFixed(0)} ms`);
  expect(pct(0.5)).toBeLessThan(200);
});

const REAL = [
  "transformer/PatchTST_Nie2023_time_series_is_worth_64_words.pdf",
  "roll_rate_and_turn_response/papers/NASA_TN_D-5957_Holleman_1970_roll_requirements_transports.pdf",
];

test.describe("真实论文", () => {
  test.skip(!LIT, "设置 PAPERLENS_LITERATURE_DIR 后运行");
  // PAPERLENS_DPR=2 模拟 Retina 屏
  test.use({ deviceScaleFactor: Number(process.env.PAPERLENS_DPR ?? 1) });
  for (const rel of REAL) {
    test(`渲染与懒加载：${rel}`, async ({ page }) => {
      const file = join(LIT!, rel);
      test.skip(!existsSync(file), "文件不存在");
      const id = await addPaper(page, readFileSync(file), `real-${rel}`, rel.split("/").at(-1)!);
      // 在页面内计时：从 openPaper 到第 1 页 canvas 和文本层都出现
      const firstPageMs = await page.evaluate(async (id) => {
        const t0 = performance.now();
        (window as unknown as W).__paperlens.useReaderStore.getState().openPaper(id);
        const done = () => {
          const el = document.querySelector('.pl-page[data-page-number="1"]');
          return !!el?.querySelector("canvas") && !!el.querySelector(".textLayer span");
        };
        while (!done()) await new Promise(requestAnimationFrame);
        return Math.round(performance.now() - t0);
      }, id);
      await waitRendered(page, 1);
      const count = await pane(page).locator(".pl-page").count();
      const stats = (list: PageRenderTiming[]) => {
        const init = list.filter((p) => p.kind === "initial");
        const pick = (k: "totalMs" | "glyphMs" | "fixMs") => {
          const xs = init.map((p) => p[k]).sort((a, b) => a - b);
          return (r: number) => xs[Math.min(xs.length - 1, Math.floor(r * xs.length))]?.toFixed(k === "totalMs" ? 0 : 1);
        };
        const [t, g, f] = [pick("totalMs"), pick("glyphMs"), pick("fixMs")];
        return `${init.length} 页，总耗时中位 ${t(0.5)} ms，p90 ${t(0.9)} ms，最大 ${t(1)} ms（其中字形映射中位 ${g(0.5)} / 最大 ${g(1)} ms，词级校正中位 ${f(0.5)} / 最大 ${f(1)} ms）`;
      };
      const takePerf = () =>
        page.evaluate(() => {
          const w = window as unknown as W;
          const out = w.__paperlensPerf ?? [];
          w.__paperlensPerf = [];
          return out;
        });
      await takePerf();

      // 1) 逐页阅读：每次往下翻一页，新进入渲染范围的只有一页
      for (let n = 2; n <= count; n++) {
        await page.getByLabel("页码").fill(String(n));
        await page.getByLabel("页码").press("Enter");
        await waitRendered(page, Math.min(count, n + 2));
      }
      await page.waitForTimeout(300);
      const stepPerf = await takePerf();

      // 2) 快速滚动：每帧滚 300px，回到顶部后从头滚到底，记录帧间隔
      await page.locator("[data-viewer-scroll]").evaluate((el) => (el.scrollTop = 0));
      await waitRendered(page, 1);
      await takePerf();
      const total = await page.locator("[data-viewer-scroll]").evaluate((el) => el.scrollHeight);
      const frames = await page.evaluate(async (total) => {
        const el = document.querySelector<HTMLElement>("[data-viewer-scroll]")!;
        const gaps: number[] = [];
        let last = performance.now();
        for (let y = 0; y < total; y += 300) {
          el.scrollTop = y;
          await new Promise(requestAnimationFrame);
          const now = performance.now();
          gaps.push(now - last);
          last = now;
        }
        gaps.sort((a, b) => a - b);
        return { n: gaps.length, p50: gaps[gaps.length >> 1], p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps.at(-1)! };
      }, total);
      await waitRendered(page, count);
      await page.waitForTimeout(300);
      const scrollPerf = await takePerf();
      const live = await pane(page).locator(".pl-page canvas").count();
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      const zoom = await page.locator("[data-zoom-label]").textContent();
      console.log(
        `[perf] ${rel} (dpr ${dpr}, ${zoom}): ${count} 页；打开到首页渲染 ${firstPageMs} ms\n` +
          `  逐页阅读：${stats(stepPerf)}\n` +
          `  快速滚动：${stats(scrollPerf)}；${frames.n} 帧，帧间隔 p50 ${frames.p50.toFixed(0)} / p95 ${frames.p95.toFixed(0)} / 最大 ${frames.max.toFixed(0)} ms；滚到底后存活 canvas ${live} 个`,
      );
      for (const p of stepPerf.filter((p) => p.kind === "initial" && p.totalMs > 150))
        console.log(`  逐页慢页 p${p.page}: canvas ${p.canvasMs.toFixed(0)} ms，文本层 ${p.textMs.toFixed(0)} ms`);
      expect(live).toBeLessThanOrEqual(6);
      await shot(page, `real-${rel.split("/")[0]}`);
    });
  }
});
