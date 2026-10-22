/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 字形映射、词级校正、textGeometry、文档级覆盖层、文档 LRU 的 e2e。
// 词框精度以 canvas 墨迹为真值（见 viewerHelpers.measureWordsInBrowser）。
// 设置 PAPERLENS_LITERATURE_DIR 时额外在真实论文上做同样的断言，并输出 glyph-*.png 截图到 PAPERLENS_SHOTS_DIR。
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  LIT,
  SHOTS,
  realPaper,
  type RealPaperKey,
  crossLineOverlapInBrowser,
  dragWords,
  type DragResult,
  addFixture,
  addPaper,
  boot,
  fileHashOf,
  fixtureBytes,
  fmt,
  installCtxProbe,
  measureWordsInBrowser,
  pageEl,
  pdfStats,
  store,
  summarize,
  waitGlyphs,
  waitRendered,
  type W,
  type WordErr,
} from "./viewerHelpers";

// DPR 2：1 个 canvas 像素约 0.025 em（14pt 字），墨迹真值足够细
test.use({ deviceScaleFactor: 2 });

test.beforeEach(async ({ page }) => {
  await boot(page);
  await installCtxProbe(page);
});

/**
 * 打开论文，第 1 页一进入渲染范围（文本层尚未生成）就在同一任务里连点 4 次放大，再连切两次分屏。
 * 每次点击都是独立的离散事件，React 会分别提交，页面在 getTextContent 返回前收到多次 viewport 变化。
 */
async function burstWhileLoading(paperId: string) {
  const w = window as unknown as W;
  w.__paperlens.useReaderStore.getState().openPaper(paperId);
  const btn = () => document.querySelector<HTMLButtonElement>('[data-pane="left"] button[aria-label^="放大"]');
  // 第 1 页已进入渲染范围（测试覆盖层已挂载）但文本层还没好
  const started = () => {
    const ctx = w.__ctx?.left?.[1] as { text: unknown } | undefined;
    return !!ctx && ctx.text === null;
  };
  while (!btn() || btn()!.disabled || !started()) await new Promise(requestAnimationFrame);
  for (let k = 0; k < 4; k++) btn()!.click();
  w.__paperlens.useReaderStore.getState().toggleSplit();
  w.__paperlens.useReaderStore.getState().toggleSplit();
}

const fmtDrag = (r: DragResult) =>
  `紧贴字母拖选 ${r.total} 次：空选区 ${r.empty}（兜底恢复 ${r.recovered}）；非空 ${r.total - r.empty} 次中原生恰好 ${r.native}，校正后恰好 ${r.refined}` +
  (r.misses.length ? `；${r.misses.slice(0, 6).join("，")}` : "");

/** 允许的原生失误数：5%，样本少时至少 1 次 */
const allowance = (n: number) => Math.max(1, Math.floor(0.05 * n));

/** 非空选区校正后必须 100% 恰好；原生失误、空选区各不超过 5%（至少容许 1 次），空选区都能由指针兜底恢复 */
function expectDrag(r: DragResult) {
  const nonEmpty = r.total - r.empty;
  expect(r.empty).toBeLessThanOrEqual(allowance(r.total));
  expect(r.recovered).toBe(r.empty);
  expect(nonEmpty - r.native).toBeLessThanOrEqual(allowance(nonEmpty));
  expect(r.refined).toBe(nonEmpty);
}

/** 打开论文，逐页跳转并测量词框误差 */
async function measurePages(page: Page, paperId: string, pages: number[]) {
  const all: (WordErr & { page: number })[] = [];
  let skipped = 0;
  for (const n of pages) {
    await store(page).jump({ paperId, page: n });
    await waitGlyphs(page, n);
    const r = await page.evaluate(measureWordsInBrowser, { paneId: "left", pageNumber: n });
    all.push(...r.words.map((w) => ({ ...w, page: n })));
    skipped += r.skipped;
  }
  return { words: all, skipped };
}

function report(label: string, words: WordErr[], skipped: number) {
  const glyph = summarize(words.flatMap((w) => [w.glyphL, w.glyphR]));
  const dom = summarize(words.filter((w) => !w.rotated && w.domL !== null).flatMap((w) => [w.domL!, w.domR!]));
  console.log(`[glyph] ${label}：${words.length} 词（跳过 ${skipped}）\n  字形映射 ${fmt(glyph)}\n  校正后文本层 ${fmt(dom)}`);
  if (process.env.PAPERLENS_DEBUG) {
    const worst = (k: "glyph" | "dom") =>
      [...words]
        .map((w) => ({ w: w.word, e: k === "glyph" ? Math.max(w.glyphL, w.glyphR) : Math.max(w.domL ?? 0, w.domR ?? 0), l: k === "glyph" ? w.glyphL : w.domL, r: k === "glyph" ? w.glyphR : w.domR }))
        .sort((a, b) => b.e - a.e)
        .slice(0, 6)
        .map((x) => `${x.w}(${x.l?.toFixed(2)}/${x.r?.toFixed(2)})`)
        .join(" ");
    console.log(`  最差 字形：${worst("glyph")}\n  最差 文本层：${worst("dom")}`);
  }
  return { glyph, dom };
}

const FIXTURE_PAGES: [string, number[]][] = [
  ["glyph-ops.pdf", [1, 2, 3, 5, 6]],
  ["simple.pdf", [1, 2]],
  ["two-column.pdf", [1, 2]],
  ["ligature.pdf", [1]],
];

test("字形映射：fixtures 上词框边缘误差 < 0.1 em", async ({ page }) => {
  test.setTimeout(120_000);
  const all: WordErr[] = [];
  let skipped = 0;
  for (const [file, pages] of FIXTURE_PAGES) {
    const id = await addFixture(page, file);
    await store(page).open(id);
    const r = await measurePages(page, id, pages);
    report(file, r.words, r.skipped);
    for (const w of r.words) {
      expect.soft(w.glyphL, `${file} p${w.page} "${w.word}" 左`).toBeLessThan(0.1);
      expect.soft(w.glyphR, `${file} p${w.page} "${w.word}" 右`).toBeLessThan(0.1);
    }
    all.push(...r.words);
    skipped += r.skipped;
  }
  const { dom } = report("fixtures 合计", all, skipped);
  expect(all.length).toBeGreaterThan(300);
  // 词级校正后的文本层（浏览器原生选区用它）也应贴合字形
  expect(dom.p95).toBeLessThan(0.1);
});

test("紧贴字母拖选：refineRangeByPointer 校正后恰好选中该词", async ({ page }) => {
  test.setTimeout(120_000);
  const id = await addFixture(page, "simple.pdf");
  await store(page).open(id);
  await waitGlyphs(page, 1);
  const { words } = await page.evaluate(measureWordsInBrowser, { paneId: "left", pageNumber: 1 });
  const picks = words.filter((w) => w.word.length >= 3).filter((_, k) => k % 2 === 0).slice(0, 40);
  expect(picks.length).toBeGreaterThanOrEqual(30);
  const fwd = await dragWords(page, 1, picks);
  const rev = await dragWords(page, 1, picks.slice(0, 15), { reverse: true });
  for (const [label, r] of [["正向", fwd], ["反向", rev]] as const) {
    console.log(`[glyph] simple.pdf ${label}${fmtDrag(r)}`);
    expectDrag(r);
  }
});

test("文本层不重复：加载过程中连续缩放、切换分屏", async ({ page }) => {
  const id = await addFixture(page, "long.pdf");
  // 降低 CPU 速度，让 getTextContent 返回前就发生多次 viewport 变化
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await page.evaluate(burstWhileLoading, id);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await waitRendered(page, 1);
  await page.waitForTimeout(800);
  const counts = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".pl-page")].map((p) => p.querySelectorAll(".textLayer").length),
  );
  console.log(`[glyph] 每页文本层数：${counts.slice(0, 6).join(",")}（最大 ${Math.max(...counts)}）`);
  expect(Math.max(...counts)).toBe(1);
});

test("扫描件判定；charBoxes 到达后 ctx.text 更新", async ({ page }) => {
  const id = await addFixture(page, "glyph-ops.pdf");
  await store(page).open(id);
  await waitGlyphs(page, 1);
  await store(page).jump({ paperId: id, page: 4 });
  await waitGlyphs(page, 4);
  const info = await page.evaluate(() => {
    const ctx = (window as unknown as W).__ctx!.left as Record<number, { text: { scanned: boolean; charBoxes: Float32Array[]; items: unknown[] } }>;
    return {
      p1: ctx[1].text.scanned,
      p4: ctx[4].text.scanned,
      p4Boxes: ctx[4].text.charBoxes.length === ctx[4].text.items.length,
    };
  });
  expect(info).toEqual({ p1: false, p4: true, p4Boxes: true });
  // 扫描件上选区端点吸附到最近的词边界：从 "Sc|anned" 选到 "pag|e" → "Scanned page"
  const r = await page.evaluate(() => {
    const ctx = (window as unknown as W).__ctx!.left[4] as { text: { divs: HTMLElement[]; normalized: { text: string } } };
    // 词级校正后 span 内有多个文本节点，按累计偏移定位
    const at = (off: number): [Text, number] => {
      const walker = document.createTreeWalker(ctx.text.divs[0], NodeFilter.SHOW_TEXT);
      let acc = 0;
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        if (off <= acc + n.data.length) return [n, off - acc];
        acc += n.data.length;
      }
      throw new Error("offset");
    };
    const range = document.createRange();
    range.setStart(...at(2)); // "Sc|anned"
    range.setEnd(...at(11)); // "pag|e"
    const tg = (window as unknown as W).__paperlensViewer.textGeometry as unknown as {
      domRangeToTextRange(ctx: unknown, r: Range): { start: number; end: number } | null;
    };
    const m = tg.domRangeToTextRange(ctx, range)!;
    return ctx.text.normalized.text.slice(m.start, m.end);
  });
  expect(r).toBe("Scanned page");
  // 页角提示：扫描件、无文字层（第 10 页是纯图片）；普通页没有
  await expect(pageEl(page, 4).locator("[data-page-badge]")).toHaveAttribute("title", "扫描件：标注精度取决于 OCR");
  await expect(pageEl(page, 1).locator("[data-page-badge]")).toHaveCount(0);
  await store(page).jump({ paperId: id, page: 10 });
  await expect(pageEl(page, 10).locator("canvas")).toHaveCount(1, { timeout: 20_000 });
  await expect(pageEl(page, 10).locator("[data-page-badge]")).toHaveAttribute("title", "此页无文字层，无法选字");

});

test("负字号与 180° 文字：字形框两端与墨迹一致", async ({ page }) => {
  const id = await addFixture(page, "glyph-ops.pdf");
  await store(page).open(id);
  await waitRendered(page, 1);
  await store(page).jump({ paperId: id, page: 7 });
  await waitGlyphs(page, 7);
  const res = await page.evaluate(() => {
    type Ctx = {
      viewport: { scale: number; width: number; convertToViewportPoint(x: number, y: number): number[] };
      pageEl: HTMLElement;
      text: { items: { str: string; transform: number[]; width: number }[]; charBoxes: Float32Array[] };
    };
    const ctx = (window as unknown as W).__ctx!.left[7] as Ctx;
    const canvas = ctx.pageEl.querySelector("canvas")!;
    const W = canvas.width;
    const data = canvas.getContext("2d")!.getImageData(0, 0, W, canvas.height).data;
    const ppx = W / ctx.viewport.width;
    const dark = (x: number, y: number) => {
      const o = (Math.round(y * ppx) * W + Math.round(x * ppx)) * 4;
      return data[o] * 0.3 + data[o + 1] * 0.59 + data[o + 2] * 0.11 < 140;
    };
    return ctx.text.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.transform[0] < 0 && it.str.trim())
      .map(({ it, i }) => {
        const t = it.transform;
        const size = Math.abs(t[3]);
        // 沿基线方向（t[0] < 0：向左）扫过整行，不依赖 pdf.js 给的 width
        const step = 1 / (ctx.viewport.scale * ppx);
        let first = Infinity;
        let last = -Infinity;
        for (let s = -size; s < 600; s += step) {
          for (let u = -0.02 * size; u <= 0.75 * size; u += step) {
            const [vx, vy] = ctx.viewport.convertToViewportPoint(t[4] - s, t[5] - u); // 倒置：字形在基线下方
            if (vx < 0 || vy < 0 || vx >= ctx.viewport.width) continue;
            if (dark(vx, vy)) {
              first = Math.min(first, s);
              last = Math.max(last, s);
              break;
            }
          }
        }
        const b = ctx.text.charBoxes[i];
        const n = it.str.length - 1;
        const glyphFirst = t[4] - b[2]; // 首字右缘到起点的距离
        const glyphLast = t[4] - b[n * 4]; // 末字左缘到起点的距离
        return {
          str: it.str,
          errFirst: Math.abs(glyphFirst - first) / size,
          errLast: Math.abs(glyphLast - last) / size,
          pdfjsLast: Math.abs(it.width - last) / size,
        };
      });
  });
  console.log(`[glyph] 180° 文字墨迹两端误差：${res.map((r) => `${r.str} 首 ${r.errFirst.toFixed(3)} / 末 ${r.errLast.toFixed(3)} em（pdf.js width 末端 ${r.pdfjsLast.toFixed(3)} em）`).join("；")}`);
  expect(res).toHaveLength(2);
  for (const r of res) {
    // 首字是 N/R，左右留白本身约 0.08 em
    expect(r.errFirst, r.str).toBeLessThan(0.12);
    expect(r.errLast, r.str).toBeLessThan(0.1);
  }
});

test("旋转页：jumpTo 的 pdfPoint 按完整坐标换算", async ({ page }) => {
  const id = await addFixture(page, "glyph-ops.pdf");
  await store(page).open(id);
  await waitRendered(page, 1);
  // 第 5 页 /Rotate 90，"Body line…" 写在 PDF (72, 400)
  await store(page).jump({ paperId: id, page: 5, pdfPoint: [72, 400] });
  await waitGlyphs(page, 5);
  const vis = await page.evaluate(() => {
    const ctx = (window as unknown as W).__ctx!.left[5] as {
      pageEl: HTMLElement;
      viewport: { rotation: number; convertToViewportPoint(x: number, y: number): number[] };
    };
    const scroll = document.querySelector<HTMLElement>("[data-viewer-scroll]")!.getBoundingClientRect();
    const r = ctx.pageEl.getBoundingClientRect();
    const [x, y] = ctx.viewport.convertToViewportPoint(72, 400);
    const px = r.left + x;
    const py = r.top + y;
    return { rotation: ctx.viewport.rotation, inside: px >= scroll.left && px <= scroll.right && py >= scroll.top && py <= scroll.bottom };
  });
  expect(vis).toEqual({ rotation: 90, inside: true });
  // 旋转页上字形映射的词框同样贴合墨迹
  const { words } = await page.evaluate(measureWordsInBrowser, { paneId: "left", pageNumber: 5 });
  expect(words.length).toBeGreaterThan(5);
  for (const w of words) expect(Math.max(w.glyphL, w.glyphR), w.word).toBeLessThan(0.1);
});

test("文档级覆盖层：覆盖整篇页边栏，坐标与页面布局一致", async ({ page }) => {
  const id = await addFixture(page, "simple.pdf");
  await page.evaluate(() => {
    const w = window as unknown as W & { __docCtx?: unknown };
    w.__paperlensViewer.docOverlays.push({
      key: "test-doc",
      slot: "margin",
      Component: ({ ctx }: { ctx: { renderedRange: [number, number]; paneId: string } }) => {
        w.__docCtx = ctx;
        return `doc ${ctx.paneId} ${ctx.renderedRange.join("-")}`;
      },
    });
  });
  await store(page).open(id);
  await waitRendered(page, 1);
  const container = page.locator("[data-doc-overlay]");
  await expect(container).toContainText(/doc left 1-\d/);
  const check = await page.evaluate(() => {
    const ctx = (window as unknown as { __docCtx: {
      pages: { pageNumber: number; top: number; left: number; width: number; height: number }[];
      marginLeft: number;
      marginWidth: number;
      scrollEl: HTMLElement;
    } }).__docCtx;
    const el = document.querySelector<HTMLElement>("[data-doc-overlay]")!;
    const origin = el.getBoundingClientRect();
    const errs = ctx.pages.map((p) => {
      const r = document.querySelector(`.pl-page[data-page-number="${p.pageNumber}"]`)!.getBoundingClientRect();
      return Math.max(Math.abs(r.top - origin.top - p.top), Math.abs(r.left - origin.left - p.left), Math.abs(r.width - p.width), Math.abs(r.height - p.height));
    });
    const content = el.parentElement!;
    return {
      pages: ctx.pages.length,
      maxErr: Math.max(...errs),
      height: Math.round(el.getBoundingClientRect().height - content.getBoundingClientRect().height),
      width: Math.round(origin.width - (ctx.marginLeft + ctx.marginWidth)),
      pointer: getComputedStyle(el).pointerEvents,
      scrollEl: ctx.scrollEl.hasAttribute("data-viewer-scroll"),
      marginAtPageRight: Math.abs(ctx.marginLeft - (ctx.pages[0].left + ctx.pages[0].width)),
    };
  });
  expect(check).toEqual({ pages: 10, maxErr: 0, height: 0, width: 0, pointer: "none", scrollEl: true, marginAtPageRight: 0 });
});

test("后台标签最多保留 3 个文档，切回时重新加载并恢复位置", async ({ page }) => {
  const files = ["simple.pdf", "two-column.pdf", "ligature.pdf", "glyph-ops.pdf", "long.pdf"];
  const ids: string[] = [];
  for (const f of files) ids.push(await addFixture(page, f));
  await store(page).open(ids[0]);
  await waitRendered(page, 1);
  await store(page).jump({ paperId: ids[0], page: 6 });
  await waitRendered(page, 6);
  for (const id of ids.slice(1)) {
    await store(page).open(id);
    await waitRendered(page, 1);
  }
  // 前台 1 篇 + 后台最近的 3 篇；最早的 simple.pdf 已释放
  await expect.poll(async () => (await pdfStats(page)).entries.map((e) => e.paperId).sort()).toEqual(ids.slice(1).sort());
  const loads = (await pdfStats(page)).loads;
  await page.locator(`[data-tab="${ids[0]}"]`).click();
  await waitRendered(page, 6);
  await expect(page.getByLabel("页码")).toHaveValue("6");
  expect((await pdfStats(page)).loads).toBe(loads + 1);
  // 切回仍在后台保留的文档不需要重新加载
  await page.locator(`[data-tab="${ids[3]}"]`).click();
  await waitRendered(page, 1);
  expect((await pdfStats(page)).loads).toBe(loads + 1);
});

test("论文换了 PDF 文件后加载新文档", async ({ page }) => {
  const id = await addFixture(page, "simple.pdf");
  const other = fixtureBytes("two-column.pdf");
  const newHash = fileHashOf(other);
  // 只写入 files 表（fileHash 在 papers 上是唯一索引）
  await page.evaluate(
    async ({ b64, hash }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await (window as unknown as W).__paperlens.db.files.put({ hash, blob: new Blob([bin]), size: bin.length });
    },
    { b64: other.toString("base64"), hash: newHash },
  );
  await store(page).open(id);
  await waitRendered(page, 1);
  await expect(page.locator("[data-page-count]")).toHaveText("/ 10");
  await page.evaluate(
    ([id, hash]) => (window as unknown as W).__paperlens.db.papers.update(id, { fileHash: hash }),
    [id, newHash] as const,
  );
  await expect(page.locator("[data-page-count]")).toHaveText("/ 2");
  await waitRendered(page, 1);
  await expect.poll(async () => (await pdfStats(page)).entries.map((e) => e.fileHash)).toEqual([newHash]);
});

// ---- 真实论文 ----

const REAL: { key: RealPaperKey; pages: number[]; shotPage: number }[] = [
  { key: "roformer", pages: [1, 3, 6], shotPage: 3 },
  { key: "patchtst", pages: [2, 5], shotPage: 5 },
  { key: "elsevier", pages: [2, 6], shotPage: 2 },
  { key: "scanned", pages: [20, 40], shotPage: 20 },
];

test.describe("真实论文", () => {
  test.skip(!LIT, "设置 PAPERLENS_LITERATURE_DIR 后运行");
  for (const { key, pages, shotPage } of REAL) {
    test(`词框精度：${key}`, async ({ page }) => {
      test.setTimeout(120_000);
      const file = realPaper(key);
      test.skip(!file, "real-papers.local.json 里没有这篇");
      const id = await addPaper(page, readFileSync(file!), `real-${key}`, basename(file!));
      await store(page).open(id);
      const { words, skipped } = await measurePages(page, id, pages);
      const scanned = await page.evaluate(
        (n) => ((window as unknown as W).__ctx!.left[n] as { text: { scanned: boolean } }).text.scanned,
        pages[0],
      );
      // 真值失败（两种方法都偏离 >1 em，多为图表、公式与文字相接）剔除
      const valid = words.filter((w) => Math.max(w.glyphL, w.glyphR) < 1 || Math.max(w.domL ?? 0, w.domR ?? 0) < 1);
      const { glyph } = report(`${key}${scanned ? "（扫描件）" : ""}`, valid, skipped + words.length - valid.length);
      expect(valid.length).toBeGreaterThan(100);
      // 扫描件只能复现 OCR 文字层的位置，OCR 词与墨迹不一致（漏字、粘连）时真值本身有偏差
      expect(glyph.p95).toBeLessThan(scanned ? 0.15 : 0.1);
      expect(glyph.over025).toBeLessThan(scanned ? 0.02 : 0.005);
      // 紧贴字母拖选（第一页上的词，正向）
      const picks = words.filter((w) => w.page === pages[0] && !w.rotated && w.word.length >= 3);
      const sample = picks.filter((_, k) => k % Math.max(1, Math.floor(picks.length / 30)) === 0).slice(0, 30);
      await store(page).jump({ paperId: id, page: pages[0] });
      await waitGlyphs(page, pages[0]);
      const drag = await dragWords(page, pages[0], sample);
      console.log(`  ${fmtDrag(drag)}`);
      expectDrag(drag);
      if (SHOTS) await drawWordBoxes(page, id, shotPage, join(SHOTS, `glyph-${key}`));
    });
  }
});

const OVERLAP: { key: RealPaperKey; pages: number[] }[] = [
  { key: "roformer", pages: [1, 3] },
  { key: "elsevier", pages: [2, 6] },
  { key: "chinese", pages: [2, 4] },
];

test.describe("真实论文：跨行高亮", () => {
  test.skip(!LIT, "设置 PAPERLENS_LITERATURE_DIR 后运行");
  for (const { key, pages } of OVERLAP) {
    test(`跨行高亮两段不重叠：${key}`, async ({ page }) => {
      const file = realPaper(key);
      test.skip(!file, "real-papers.local.json 里没有这篇");
      const id = await addPaper(page, readFileSync(file!), `real-${key}`, basename(file!));
      await store(page).open(id);
      const all: number[] = [];
      for (const n of pages) {
        await store(page).jump({ paperId: id, page: n });
        await waitGlyphs(page, n);
        all.push(...(await page.evaluate(crossLineOverlapInBrowser, { paneId: "left", pageNumber: n })));
      }
      const s = summarize(all);
      console.log(`[glyph] 跨行高亮重叠 ${key}：${s.n} 处，中位 ${s.median.toFixed(3)} / p95 ${s.p95.toFixed(3)} / 最大 ${s.max.toFixed(3)} em`);
      expect(s.n).toBeGreaterThan(20);
      expect(s.p95).toBeLessThan(0.05);
    });
  }

  test("文本层不重复：Elsevier 论文加载中连续放大", async ({ page }) => {
    const file = realPaper("elsevier");
    test.skip(!file, "real-papers.local.json 里没有这篇");
    const id = await addPaper(page, readFileSync(file!), "real-elsevier", "Elsevier");
    await page.evaluate(burstWhileLoading, id);
    await waitRendered(page, 1);
    await page.waitForTimeout(1500);
    const counts = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".pl-page")].map((p) => p.querySelectorAll(".textLayer").length),
    );
    console.log(`[glyph] Elsevier 每页文本层数：${counts.slice(0, 6).join(",")}（最大 ${Math.max(...counts)}）`);
    expect(Math.max(...counts)).toBe(1);
  });
});

/** 用 textRangeToPdfRects 给整页每个词画框，截整页和放大的局部 */
async function drawWordBoxes(page: Page, paperId: string, n: number, base: string) {
  // 加高视口，整页截图时页面完整处于可视范围内（宽度不变，缩放不变）
  await page.setViewportSize({ width: 1440, height: 2300 });
  await store(page).jump({ paperId, page: n });
  await waitGlyphs(page, n);
  const box = await page.evaluate((n) => {
    type Ctx = {
      pageEl: HTMLElement;
      viewport: { convertToViewportPoint(x: number, y: number): number[] };
      text: { items: { str: string }[] };
    };
    const w = window as unknown as W;
    const ctx = w.__ctx!.left[n] as Ctx;
    const tg = w.__paperlensViewer.textGeometry as unknown as {
      itemRangeToTextRange(c: Ctx, i: number, s: number, e: number): { start: number; end: number } | null;
      textRangeToPdfRects(c: Ctx, s: number, e: number): number[][];
    };
    const layer = document.createElement("div");
    layer.style.cssText = "position:absolute;inset:0;z-index:5;pointer-events:none";
    let first: DOMRect | null = null;
    ctx.text.items.forEach((it, i) => {
      for (const m of it.str.matchAll(/\S+/g)) {
        const r = tg.itemRangeToTextRange(ctx, i, m.index!, m.index! + m[0].length);
        if (!r) continue;
        for (const [x1, y1, x2, y2] of tg.textRangeToPdfRects(ctx, r.start, r.end)) {
          const [ax, ay] = ctx.viewport.convertToViewportPoint(x1, y1);
          const [bx, by] = ctx.viewport.convertToViewportPoint(x2, y2);
          const d = document.createElement("div");
          d.style.cssText = `position:absolute;left:${Math.min(ax, bx)}px;top:${Math.min(ay, by)}px;width:${Math.abs(bx - ax)}px;height:${Math.abs(by - ay)}px;border:1px solid rgba(220,0,0,.85);background:rgba(220,0,0,.08);box-sizing:border-box`;
          layer.append(d);
        }
      }
    });
    ctx.pageEl.append(layer);
    const r = ctx.pageEl.getBoundingClientRect();
    for (const d of layer.children) {
      const b = d.getBoundingClientRect();
      if (b.top > r.top + r.height * 0.25 && (!first || b.top < first.top)) first = b;
    }
    const f = first as DOMRect | null;
    return { x: r.left, y: r.top, w: r.width, h: r.height, fx: f ? f.left : r.left + 60, fy: f ? f.top : r.top + 200 };
  }, n);
  await pageEl(page, n).screenshot({ path: `${base}-page.png` });
  // 局部放大：从页面 1/4 高度处第一行文字开始的 460×260 区域（DPR 2 截图即 2 倍）
  await page.locator(`[data-pane="left"] .pl-page[data-page-number="${n}"]`).scrollIntoViewIfNeeded();
  const vp = page.viewportSize()!;
  const y = Math.max(0, Math.min(box.fy - 20, vp.height - 260));
  await page.screenshot({ path: `${base}-zoom.png`, clip: { x: Math.max(0, box.x + 40), y, width: 460, height: 260 } });
}

test("页面回收：另一分栏仍在显示的页不进入清理队列；文档销毁后清空", async ({ page }) => {
  const id = await addFixture(page, "simple.pdf");
  const cache = () => page.evaluate(() => (window as unknown as W).__paperlensViewer.pageCacheStats());
  await store(page).open(id);
  await waitRendered(page, 1);
  await store(page).open(id, "right");
  await waitRendered(page, 1, "right");
  // 左栏滚到最后：左栏释放第 1–3 页，但右栏还在显示，不能进入待清理队列
  await page.locator('[data-pane="left"] [data-viewer-scroll]').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await waitRendered(page, 10, "left");
  await expect(pageEl(page, 1, "left").locator("canvas")).toHaveCount(0);
  await expect.poll(cache).toMatchObject({ released: 0 });
  expect((await cache()).displayed).toBeGreaterThanOrEqual(5);
  // 关掉右栏：第 1–3 页无人显示，进入队列
  await store(page).close("right", id);
  await expect.poll(async () => (await cache()).released).toBeGreaterThanOrEqual(2);
  // 关掉最后一个标签：文档销毁，队列里属于它的页一并移除
  await store(page).close("left", id);
  await expect.poll(cache).toEqual({ displayed: 0, released: 0 });
});
