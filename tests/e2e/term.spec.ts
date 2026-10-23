/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 术语前台 e2e：下划线（精度、嵌套）、点击/悬停弹窗、多候选、↑/↓ 导航、出现位置跳转、编辑器、
// 显示开关、作用范围、与批注点击的协调、相关笔记。
// npx playwright test -c tests/e2e/term.config.ts
import { expect, test, type Page } from "@playwright/test";
import { addFixture, boot, installCtxProbe, pageEl, store, waitGlyphs, type PaneId } from "./viewerHelpers";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

interface TermSeed {
  id: string;
  name: string;
  aliases?: string[];
  matchMode?: "auto" | "caseSensitive" | "caseInsensitive";
  scope?: { kind: "global" } | { kind: "domains"; domainIds: string[] };
  note?: string;
  sourceAnnotationId?: string;
}

interface Table {
  bulkPut(rows: unknown[]): Promise<unknown>;
  get(k: unknown): Promise<unknown>;
  toArray(): Promise<unknown[]>;
  update(k: unknown, c: unknown): Promise<unknown>;
  count(): Promise<number>;
}
type Win = Window & {
  __paperlens: {
    db: Record<string, Table>;
    useTermUiStore: { getState(): Record<string, (...a: never[]) => unknown> & { popover: unknown; editor: unknown } };
  };
  __ctx: Record<string, Record<number, { text: { normalized: { text: string } } }>>;
};

async function dbPut(page: Page, table: string, rows: unknown[]) {
  await page.evaluate(({ table, rows }) => (window as unknown as Win).__paperlens.db[table].bulkPut(rows), { table, rows });
}
async function dbGet<T>(page: Page, table: string, key: unknown): Promise<T> {
  return page.evaluate(({ table, key }) => (window as unknown as Win).__paperlens.db[table].get(key), { table, key }) as Promise<T>;
}
async function dbAll<T>(page: Page, table: string): Promise<T[]> {
  return page.evaluate((table) => (window as unknown as Win).__paperlens.db[table].toArray(), table) as Promise<T[]>;
}
async function dbUpdate(page: Page, table: string, key: unknown, changes: unknown) {
  await page.evaluate(({ table, key, changes }) => (window as unknown as Win).__paperlens.db[table].update(key, changes), { table, key, changes });
}

async function seedTerms(page: Page, terms: TermSeed[]) {
  const now = Date.now();
  await dbPut(
    page,
    "terms",
    terms.map((t) => ({ aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: now, updatedAt: now, ...t })),
  );
}

interface Ul {
  ids: string[];
  start: number;
  end: number;
  seg: number;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 某页上画出的下划线段（client 坐标），带命中的文字（需 installCtxProbe） */
async function underlines(page: Page, n: number, paneId: PaneId = "left"): Promise<Ul[]> {
  return page.evaluate(
    ([paneId, n]) => {
      const w = window as unknown as Win;
      const t = w.__ctx[paneId as string]?.[n as number]?.text?.normalized.text ?? "";
      const root = document.querySelector(`[data-pane="${paneId}"] .pl-page[data-page-number="${n}"]`);
      if (!root) return [];
      return [...root.querySelectorAll<HTMLElement>("[data-term-ul]")].map((el) => {
        const r = el.getBoundingClientRect();
        const start = Number(el.dataset.start);
        const end = Number(el.dataset.end);
        return {
          ids: el.dataset.termIds!.split(" "),
          start,
          end,
          seg: Number(el.dataset.seg),
          text: t.slice(start, end),
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
        };
      });
    },
    [paneId, n] as const,
  );
}

const firstSegs = (uls: Ul[]) => uls.filter((u) => u.seg === 0);

async function waitUnderlines(page: Page, n: number, pred: (uls: Ul[]) => boolean = (u) => u.length > 0, paneId: PaneId = "left") {
  await expect.poll(async () => pred(await underlines(page, n, paneId)), { timeout: 20_000 }).toBe(true);
}

const popover = (page: Page) => page.locator("[data-term-popover]");

async function clickAt(page: Page, u: Pick<Ul, "left" | "top" | "width" | "height">) {
  await page.mouse.click(u.left + u.width / 2, u.top + u.height / 2);
}

/** 找到某页上某个术语的第 k 处下划线（第一段） */
async function findUl(page: Page, n: number, termId: string, k = 0, paneId: PaneId = "left"): Promise<Ul> {
  const list = firstSegs(await underlines(page, n, paneId)).filter((u) => u.ids.includes(termId));
  expect(list.length, `第 ${n} 页 ${termId} 的下划线`).toBeGreaterThan(k);
  return list[k];
}

const BASE_TERMS: TermSeed[] = [
  { id: "t-lstm", name: "Long Short-Term Memory", aliases: ["LSTM"], note: "一种**门控**循环网络" },
  { id: "t-tf", name: "Transformer" },
  { id: "t-mem", name: "memory" },
];

async function openFixture(page: Page, file: string, terms: TermSeed[] | null = BASE_TERMS) {
  if (terms) await seedTerms(page, terms);
  const id = await addFixture(page, file);
  await store(page).open(id);
  await waitGlyphs(page, 1);
  return id;
}

async function openSimple(page: Page, terms: TermSeed[] | null = BASE_TERMS) {
  const id = await openFixture(page, "simple.pdf", terms);
  if (terms?.length) await waitUnderlines(page, 1);
  return id;
}

/** 下划线与 canvas 墨迹的误差（em）。只量单段、两侧是空格的匹配；竖向检查下划线在基线下方 0–0.45 em */
function measureUnderlineInk(args: { paneId: string; page: number; ids: string[] }) {
  type Ctx = {
    pageEl: HTMLElement;
    viewport: { scale: number };
    text: { items: { transform: number[] }[]; normalized: { text: string; itemIndex: Int32Array } };
  };
  const ctx = (window as unknown as { __ctx: Record<string, Record<number, Ctx>> }).__ctx[args.paneId][args.page];
  const canvas = ctx.pageEl.querySelector("canvas")!;
  const W = canvas.width;
  const H = canvas.height;
  const data = canvas.getContext("2d")!.getImageData(0, 0, W, H).data;
  const pr = ctx.pageEl.getBoundingClientRect();
  const k = W / pr.width;
  const dark = (x: number, y: number) => {
    const px = Math.round(x * k);
    const py = Math.round(y * k);
    if (px < 0 || py < 0 || px >= W || py >= H) return false;
    const o = (py * W + px) * 4;
    return data[o] * 0.3 + data[o + 1] * 0.59 + data[o + 2] * 0.11 < 140;
  };
  const t = ctx.text.normalized.text;
  const out: { word: string; l: number; r: number; below: number | null }[] = [];
  const els = [...ctx.pageEl.querySelectorAll<HTMLElement>("[data-term-ul]")];
  for (const el of els) {
    const ids = el.dataset.termIds!.split(" ");
    if (!ids.some((id) => args.ids.includes(id))) continue;
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    if (els.filter((e) => e.dataset.start === el.dataset.start).length !== 1) continue;
    if ((start > 0 && t[start - 1] !== " ") || (end < t.length && t[end] !== " ")) continue;
    const item = ctx.text.items[ctx.text.normalized.itemIndex[start]];
    const em = Math.hypot(item.transform[2], item.transform[3]) * ctx.viewport.scale;
    const r = el.getBoundingClientRect();
    const L = r.left - pr.left;
    const R = r.right - pr.left;
    const T = r.top - pr.top;
    const B = r.bottom - pr.top;
    const step = 1 / k;
    // 列墨迹剖面（含基线附近，避免 L 的横笔被切掉），按 < 0.2 em 的间隙合并成词，取与下划线重叠的词
    const x0s = L - 0.8 * em;
    const cols: boolean[] = [];
    for (let x = x0s; x <= R + 0.8 * em; x += step) {
      let any = false;
      for (let y = T + 0.05 * (B - T); y <= B - 0.12 * (B - T) && !any; y += step) any = dark(x, y);
      cols.push(any);
    }
    const runs: [number, number][] = [];
    for (let i = 0; i < cols.length; i++) {
      if (!cols[i]) continue;
      let j = i;
      while (j + 1 < cols.length && cols[j + 1]) j++;
      const a = x0s + i * step;
      const b = x0s + (j + 1) * step;
      const last = runs[runs.length - 1];
      if (last && a - last[1] < 0.2 * em) last[1] = b;
      else runs.push([a, b]);
      i = j;
    }
    const hitRuns = runs.filter(([a, b]) => b > L && a < R);
    if (!hitRuns.length) continue;
    const x0 = Math.min(...hitRuns.map((r) => r[0]));
    const x1 = Math.max(...hitRuns.map((r) => r[1]));
    let below: number | null = null;
    const word = t.slice(start, end);
    if (!/[gjpqy,;]/.test(word)) {
      let inkBottom = -Infinity;
      for (let x = x0; x <= x1; x += step) for (let y = T; y <= B + 0.2 * em; y += step) if (dark(x, y)) inkBottom = Math.max(inkBottom, y);
      below = (B - inkBottom) / em;
    }
    out.push({ word, l: Math.abs(x0 - L) / em, r: Math.abs(x1 - R) / em, below });
  }
  return out;
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await installCtxProbe(page);
});

// ---------------------------------------------------------------------------
// 下划线
// ---------------------------------------------------------------------------

test.describe("下划线", () => {
  test.use({ deviceScaleFactor: 2 });

  test("出现、贴合字形（以 canvas 墨迹为真值）、缩放后仍贴合", async ({ page }) => {
    await openSimple(page);
    const texts = firstSegs(await underlines(page, 1)).map((u) => u.text);
    console.log("[term] p1 命中：", texts.join(" | "));
    expect(texts).toContain("LSTM");
    expect(texts).toContain("Transformer");

    const check = async (label: string) => {
      const ms = (await page.evaluate(measureUnderlineInk, { paneId: "left", page: 1, ids: ["t-lstm", "t-tf"] })) as {
        word: string;
        l: number;
        r: number;
        below: number | null;
      }[];
      const errs = ms.flatMap((m) => [m.l, m.r]).sort((a, b) => a - b);
      const p95 = errs[Math.floor(errs.length * 0.95)] ?? 0;
      console.log(`[term] ${label}：${ms.length} 处，左右边缘误差 中位 ${errs[errs.length >> 1]?.toFixed(3)} / p95 ${p95.toFixed(3)} / 最大 ${errs.at(-1)?.toFixed(3)} em；基线下方 ${ms.map((m) => m.below?.toFixed(2)).join(",")}`);
      expect(ms.length).toBeGreaterThanOrEqual(3);
      for (const m of ms) {
        expect.soft(m.l, `${label} "${m.word}" 左`).toBeLessThan(0.1);
        expect.soft(m.r, `${label} "${m.word}" 右`).toBeLessThan(0.1);
        if (m.below !== null) {
          expect.soft(m.below, `${label} "${m.word}" 下划线在基线下方`).toBeGreaterThan(0);
          expect.soft(m.below, `${label} "${m.word}" 下划线离基线不远`).toBeLessThan(0.45);
        }
      }
    };
    await check("100%");
    await page.getByRole("button", { name: "放大（Ctrl/⌘ +）" }).click();
    await page.getByRole("button", { name: "放大（Ctrl/⌘ +）" }).click();
    // 缩放后 canvas 延迟重绘，等新尺寸的 canvas 出现
    await expect.poll(() => page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-pane="left"] .pl-page[data-page-number="1"]')!;
      const c = el.querySelector("canvas")!;
      return Math.abs(c.width / devicePixelRatio - el.getBoundingClientRect().width) < 2;
    }), { timeout: 10_000 }).toBe(true);
    await check("放大后");
  });

  test("嵌套术语不拆开；跨行术语分段", async ({ page }) => {
    await openSimple(page, [
      ...BASE_TERMS,
      { id: "t-short", name: "Short-Term" },
      { id: "t-gate", name: "forget gate" },
      // 第 1 页第一段里 "combine" 在行尾、"physical models" 在下一行行首
      { id: "t-cross", name: "combine physical models" },
    ]);
    const uls = await underlines(page, 1);
    const long = firstSegs(uls).filter((u) => u.ids.includes("t-lstm") && u.text.includes("Memory"));
    expect(long.length).toBeGreaterThan(0);
    for (const u of uls) {
      // "Long Short-Term Memory" 内部的 Memory / Short-Term 不单独标注
      if (u.ids.includes("t-mem") || u.ids.includes("t-short")) {
        for (const l of long) expect(u.start >= l.end || u.end <= l.start).toBe(true);
      }
    }
    // 每一处匹配的各段属于同一区间，段号连续
    const byStart = new Map<number, Ul[]>();
    for (const u of uls) byStart.set(u.start, [...(byStart.get(u.start) ?? []), u]);
    for (const segs of byStart.values()) expect(segs.map((s) => s.seg).sort()).toEqual(segs.map((_, i) => i));
    // 跨行的匹配分成两段，分别在两行上
    const cross = [...byStart.values()].find((s) => s[0].ids.includes("t-cross"));
    expect(cross, "跨行术语").toBeTruthy();
    expect(cross!.length).toBe(2);
    const [a, b] = cross!.sort((x, y) => x.seg - y.seg);
    expect(b.top - a.top).toBeGreaterThan(a.height * 0.8);
    expect(b.left).toBeLessThan(a.left);
  });
});

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

test("点击 → 弹窗 → 编辑笔记 → 持久化", async ({ page }) => {
  await openSimple(page);
  await clickAt(page, await findUl(page, 1, "t-lstm"));
  const pop = popover(page);
  await expect(pop).toHaveAttribute("data-term-popover", "edit");
  await expect(pop.locator("[data-term-name]")).toHaveText("Long Short-Term Memory");
  await expect(pop.locator("[data-term-aliases]")).toContainText("LSTM");
  await expect(pop.locator("[data-term-note]")).toContainText("门控");
  // 锚点下划线高亮
  await expect(pageEl(page, 1).locator("[data-term-ul][data-active]").first()).toBeAttached();

  await pop.locator("[data-term-note]").click();
  const editor = pop.locator("[data-term-note-editor] .cm-content");
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("LSTM 用遗忘门控制记忆");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(pop.locator("[data-term-note]")).toContainText("遗忘门");
  await expect.poll(async () => (await dbGet<{ note: string }>(page, "terms", "t-lstm")).note).toBe("LSTM 用遗忘门控制记忆");

  // 失焦也保存：再改一次，点到弹窗外
  await pop.locator("[data-term-note]").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("第二版笔记");
  await page.mouse.click(5, 300);
  await expect(pop).toHaveCount(0);
  await expect.poll(async () => (await dbGet<{ note: string }>(page, "terms", "t-lstm")).note).toBe("第二版笔记");

  // Esc 关闭
  await clickAt(page, await findUl(page, 1, "t-lstm"));
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});

test("弹窗：复制这条术语的 acro 代码；悬停预览里没有复制按钮", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSimple(page);
  await clickAt(page, await findUl(page, 1, "t-lstm"));
  const pop = popover(page);
  await expect(pop).toHaveAttribute("data-term-popover", "edit");
  await pop.locator("[data-copy-acro]").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("\\DeclareAcronym{lstm}{\n  short = {LSTM} ,\n  long  = {Long Short-Term Memory} ,\n}");
  await expect(page.getByRole("status").filter({ hasText: "\\ac{lstm}" })).toBeVisible();
  // 弹窗仍然开着，焦点没被抢走到别处
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);

  await page.mouse.move(5, 300);
  const ul = await findUl(page, 1, "t-lstm");
  await page.mouse.move(ul.left + ul.width / 2, ul.top + ul.height / 2);
  await expect(pop).toHaveAttribute("data-term-popover", "preview");
  await expect(pop.locator("[data-copy-acro]")).toHaveCount(0);
});

test("悬停 400 ms 显示只读预览，移开收起；点击预览进入可编辑", async ({ page }) => {
  await openSimple(page);
  const u = await findUl(page, 1, "t-tf");
  await page.mouse.move(u.left + u.width / 2, u.top + u.height / 2);
  await page.waitForTimeout(200);
  await expect(popover(page)).toHaveCount(0);
  await expect(popover(page)).toHaveAttribute("data-term-popover", "preview", { timeout: 2000 });
  await expect(popover(page).locator("[data-term-name]")).toHaveText("Transformer");
  // 预览没有编辑按钮、没有导航
  await expect(popover(page).locator("[data-term-edit]")).toHaveCount(0);
  await expect(popover(page).locator("[data-term-nav]")).toHaveCount(0);
  // 移进预览卡片不收起
  const box = (await popover(page).boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20, { steps: 5 });
  await page.waitForTimeout(500);
  await expect(popover(page)).toHaveCount(1);
  // 点击卡片 → 可编辑
  await page.mouse.click(box.x + 20, box.y + 20);
  await expect(popover(page)).toHaveAttribute("data-term-popover", "edit");
  await page.keyboard.press("Escape");
  // 悬停后移开
  await page.mouse.move(u.left + u.width / 2, u.top + u.height / 2);
  await expect(popover(page)).toHaveAttribute("data-term-popover", "preview", { timeout: 2000 });
  await page.mouse.move(u.left + u.width / 2, u.top + 200, { steps: 3 });
  await expect(popover(page)).toHaveCount(0, { timeout: 2000 });
});

test("多候选：同一缩写在两个术语里，弹窗列出全部候选并可切换", async ({ page }) => {
  await openSimple(page, [
    { id: "t-atm1", name: "Air Traffic Management", aliases: ["ATM"], note: "空管" },
    { id: "t-atm2", name: "Automated Teller Machine", aliases: ["ATM"], note: "取款机" },
  ]);
  const u = firstSegs(await underlines(page, 1)).find((x) => x.text === "ATM")!;
  expect(u.ids.sort()).toEqual(["t-atm1", "t-atm2"]);
  await clickAt(page, u);
  const pop = popover(page);
  await expect(pop.locator("[data-candidate]")).toHaveCount(2);
  await expect(pop.locator("[data-term-name]")).toHaveText("Air Traffic Management");
  await pop.locator('[data-candidate="t-atm2"]').click();
  await expect(pop.locator("[data-term-name]")).toHaveText("Automated Teller Machine");
  await expect(pop.locator("[data-term-note]")).toContainText("取款机");
  await expect(pop.locator('[data-candidate="t-atm2"]')).toHaveAttribute("aria-pressed", "true");
});

test("↑/↓ 在本文中逐处跳转；跳到未渲染的页先翻页再定位", async ({ page }) => {
  const paperId = await openSimple(page);
  const first = await findUl(page, 1, "t-tf");
  await clickAt(page, first);
  const pop = popover(page);
  const label = pop.locator("[data-term-nav-label]");
  await expect(label).toHaveText(/本文第 1 \/ \d+ 处/, { timeout: 15_000 });
  const total = Number((await label.textContent())!.match(/\/ (\d+)/)![1]);
  // 与逐页统计一致：pageTexts 全文 + 同一匹配器
  const all = await page.evaluate(async (paperId) => {
    const t = (window as unknown as { __paperlensTerm: { getPaperOccurrenceIndex(id: string): Promise<Map<string, { page: number }[]>> } }).__paperlensTerm;
    return (await t.getPaperOccurrenceIndex(paperId)).get("t-tf")!;
  }, paperId);
  expect(total).toBe(all.length);
  expect(total).toBeGreaterThan(3);
  const lastPage = all[all.length - 1].page;
  // 最后一处所在页此时不在渲染范围内
  expect(lastPage).toBeGreaterThan(5);
  await expect(page.locator(`[data-pane="left"] .pl-page[data-page-number="${lastPage}"] canvas`)).toHaveCount(0);

  await page.keyboard.press("ArrowDown");
  await expect(label).toHaveText(`本文第 2 / ${total} 处`);
  await expect(page.locator("[data-term-flash]")).toHaveCount(1);
  await page.keyboard.press("ArrowUp");
  await expect(label).toHaveText(`本文第 1 / ${total} 处`);
  // 从第一处往上：首尾相接，跳到最后一页（未渲染）
  await page.keyboard.press("ArrowUp");
  await expect(label).toHaveText(`本文第 ${total} / ${total} 处`, { timeout: 15_000 });
  await expect(pop).toBeVisible();
  const anchor = (await page.evaluate(() => (window as unknown as Win).__paperlens.useTermUiStore.getState().popover)) as {
    anchor: { page: number };
  };
  expect(anchor.anchor.page).toBe(lastPage);
  // 目标处在视口内，弹窗贴着它
  const target = firstSegs(await underlines(page, lastPage)).filter((u) => u.ids.includes("t-tf")).at(-1)!;
  const flash = page.locator(`.pl-page[data-page-number="${lastPage}"] [data-term-flash]`);
  await expect(flash).toHaveCount(1);
  const vp = page.viewportSize()!;
  expect(target.top).toBeGreaterThan(0);
  expect(target.top).toBeLessThan(vp.height);
  const pb = (await pop.boundingBox())!;
  expect(Math.abs(pb.y - (target.top + target.height)) < 30 || Math.abs(pb.y + pb.height - target.top) < 30).toBe(true);
});

test("跨页导航后焦点留在弹窗，再按 ↑/↓ 继续导航而不是滚动阅读器；连按不丢步", async ({ page }) => {
  await openSimple(page);
  await clickAt(page, await findUl(page, 1, "t-tf"));
  const pop = popover(page);
  const label = pop.locator("[data-term-nav-label]");
  await expect(label).toHaveText(/本文第 1 \/ \d+ 处/, { timeout: 15_000 });
  const total = Number((await label.textContent())!.match(/\/ (\d+)/)![1]);
  const focusInPopover = () =>
    page.evaluate(() => !!document.activeElement?.closest("[data-term-popover]"));
  const scrollTop = () => page.evaluate(() => document.querySelector<HTMLElement>('[data-pane="left"] [data-viewer-scroll]')!.scrollTop);

  // 0. 锚点被滚出可视区：弹窗变透明但不丢焦点，滚回来恢复
  const setScroll = (y: number) =>
    page.evaluate((y) => {
      document.querySelector<HTMLElement>('[data-pane="left"] [data-viewer-scroll]')!.scrollTop = y;
    }, y);
  const top0 = await scrollTop();
  await setScroll(top0 + 1500);
  await expect(pop).toHaveAttribute("data-detached");
  expect(await focusInPopover()).toBe(true);
  await setScroll(top0);
  await expect(pop).not.toHaveAttribute("data-detached");

  // 1. 跨页（首尾相接到最后一页），落定后焦点仍在弹窗
  await page.keyboard.press("ArrowUp");
  await expect(label).toHaveText(`本文第 ${total} / ${total} 处`, { timeout: 15_000 });
  await expect.poll(focusInPopover).toBe(true);
  // 再按：导航到上一处（同页或附近），而不是让阅读器按方向键滚动一行
  const before = await scrollTop();
  await page.keyboard.press("ArrowUp");
  await expect(label).toHaveText(`本文第 ${total - 1} / ${total} 处`, { timeout: 15_000 });
  const moved = Math.abs((await scrollTop()) - before);
  expect(moved === 0 || moved > 60, `阅读器滚动了 ${moved}px`).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect(label).toHaveText(`本文第 ${total} / ${total} 处`, { timeout: 15_000 });

  // 2. 在最后一处快速连按两次 ↓：跨页导航未落定时第二次从它的目标算起 → 第 2 处
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(label).toHaveText(`本文第 2 / ${total} 处`, { timeout: 15_000 });
  await page.keyboard.press("ArrowUp");
  await expect(label).toHaveText(`本文第 1 / ${total} 处`, { timeout: 15_000 });
  await expect.poll(focusInPopover).toBe(true);

  // 3. 在第 1 处快速连按三次 ↑ → 倒数第 3 处
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(label).toHaveText(`本文第 ${total - 2} / ${total} 处`, { timeout: 15_000 });
  // 落定后锚点滚到了可视区内（弹窗没有因"锚点滚出可视区"而透明）
  await expect(pop).not.toHaveAttribute("data-detached");
  const inView = await page.evaluate(() => {
    const st = (window as unknown as Win).__paperlens.useTermUiStore.getState() as unknown as { popover: { anchor: { page: number; start: number } } };
    const a = st.popover.anchor;
    const ul = document.querySelector(`[data-pane="left"] .pl-page[data-page-number="${a.page}"] [data-term-ul][data-start="${a.start}"]`)!.getBoundingClientRect();
    const box = document.querySelector('[data-pane="left"] [data-viewer-scroll]')!.getBoundingClientRect();
    return ul.top >= box.top && ul.bottom <= box.bottom;
  });
  expect(inView).toBe(true);
  await expect.poll(focusInPopover).toBe(true);
});

test("出现在哪些论文：按领域分组，点击打开另一篇并闪烁定位", async ({ page }) => {
  await dbPut(page, "domains", [{ id: "d-ml", name: "机器学习", parentId: null, color: "#3b82f6", order: 0 }]);
  const simpleId = await openSimple(page);
  const twoId = await addFixture(page, "two-column.pdf", "Two Column Study");
  await dbUpdate(page, "papers", twoId, { domainIds: ["d-ml"] });
  await dbPut(page, "occurrences", [
    { termId: "t-lstm", paperId: simpleId, pages: [1, 2, 3], count: 30, engineVersion: 1 },
    { termId: "t-lstm", paperId: twoId, pages: [1], count: 1, engineVersion: 1 },
  ]);
  await clickAt(page, await findUl(page, 1, "t-lstm"));
  const pop = popover(page);
  const item = pop.locator(`[data-occ-paper="${twoId}"]`);
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(pop.locator("[data-term-papers]")).toContainText("机器学习");
  await item.click();
  await expect(pop).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __paperlens: { useReaderStore: { getState(): { panes: { activePaperId: string }[] } } } }).__paperlens.useReaderStore.getState().panes[0].activePaperId)).toBe(twoId);
  await waitGlyphs(page, 1);
  const flash = page.locator('[data-pane="left"] .pl-page[data-page-number="1"] [data-term-flash]');
  await expect(flash).toHaveCount(1, { timeout: 15_000 });
  // 闪烁的位置就是 "Long Short-Term Memory"
  const fb = (await flash.locator(".pl-term-flash").first().boundingBox())!;
  const ul = firstSegs(await underlines(page, 1)).find((u) => u.ids.includes("t-lstm"))!;
  expect(Math.abs(fb.x - ul.left)).toBeLessThan(3);
  expect(Math.abs(fb.y - ul.top)).toBeLessThan(3);
});

test("首次定义处：跳到出处批注", async ({ page }) => {
  const id = await openSimple(page, null);
  await dbPut(page, "annotations", [
    {
      id: "a-src",
      paperId: id,
      page: 3,
      rects: [[72, 600, 200, 612]],
      quote: { exact: "Long Short-Term Memory", prefix: "", suffix: "" },
      fileHash: "x",
      color: "#fde68a",
      note: "",
      termId: "t-lstm",
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  await seedTerms(page, [{ ...BASE_TERMS[0], sourceAnnotationId: "a-src" }]);
  await waitUnderlines(page, 1);
  await clickAt(page, await findUl(page, 1, "t-lstm"));
  const src = popover(page).locator("[data-term-source]");
  await expect(src).toContainText("第 3 页");
  await src.getByRole("button").click();
  await expect.poll(() =>
    page.evaluate(() => (window as unknown as { __paperlens: { useReaderStore: { getState(): { jumpRequest: { page: number; annotationId?: string } | null } } } }).__paperlens.useReaderStore.getState().jumpRequest),
  ).toMatchObject({ page: 3, annotationId: "a-src" });
});

test("点击落在高亮区域上的术语：打开弹窗且 defaultPrevented 为 true", async ({ page }) => {
  const id = await openSimple(page);
  const u = await findUl(page, 1, "t-lstm");
  // 一条覆盖该术语的高亮批注（批注模块会画出来）
  const rect = await page.evaluate(
    ({ u }) => {
      const ctx = (window as unknown as { __ctx: Record<string, Record<number, { pageEl: HTMLElement; viewport: { convertToPdfPoint(x: number, y: number): number[] } }>> }).__ctx.left[1];
      const o = ctx.pageEl.getBoundingClientRect();
      const a = ctx.viewport.convertToPdfPoint(u.left - o.left - 4, u.top - o.top);
      const b = ctx.viewport.convertToPdfPoint(u.left - o.left + u.width + 4, u.top - o.top + u.height);
      return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    },
    { u },
  );
  const fileHash = ((await dbGet<{ fileHash: string }>(page, "papers", id)) as { fileHash: string }).fileHash;
  await dbPut(page, "annotations", [
    {
      id: "a-hl",
      paperId: id,
      page: 1,
      rects: [rect],
      quote: { exact: u.text, prefix: "", suffix: "" },
      fileHash,
      color: "#fde68a",
      note: "高亮笔记",
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const w = window as unknown as { __clicks: boolean[] };
    w.__clicks = [];
    window.addEventListener("click", (e) => w.__clicks.push(e.defaultPrevented));
  });
  await clickAt(page, u);
  await expect(popover(page)).toHaveAttribute("data-term-popover", "edit");
  expect(await page.evaluate(() => (window as unknown as { __clicks: boolean[] }).__clicks)).toEqual([true]);
  // 不是术语的地方：不拦截
  await page.keyboard.press("Escape");
  await page.mouse.click(u.left - 60, u.top + u.height / 2);
  expect(await page.evaluate(() => (window as unknown as { __clicks: boolean[] }).__clicks)).toEqual([true, false]);
  await expect(popover(page)).toHaveCount(0);
});

test("拖选结束时不打开弹窗", async ({ page }) => {
  await openSimple(page);
  const u = await findUl(page, 1, "t-tf");
  await page.mouse.move(u.left - 80, u.top + u.height / 2);
  await page.mouse.down();
  await page.mouse.move(u.left + u.width / 2, u.top + u.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await expect(popover(page)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 编辑器
// ---------------------------------------------------------------------------

const editor = (page: Page) => page.locator("[data-term-editor]");

test("编辑器：新建时按各词首字母建议缩写，一键加为别名；已有缩写或忽略后不再提示", async ({ page }) => {
  await openSimple(page, []);
  await page.evaluate(() => (window as unknown as Win).__paperlens.useTermUiStore.getState().openTermEditor({} as never));
  const ed = editor(page);
  const name = ed.locator('[data-term-field="name"]');
  const hint = ed.locator('[data-term-suggestion="initials"]');
  await name.fill("Transformer");
  await expect(hint).toHaveCount(0); // 一个词不推断
  await name.fill("Long Short-Term Memory");
  await expect(hint).toContainText("LSTM");
  await hint.getByRole("button", { name: "添加为别名" }).click();
  await expect(ed.locator('[data-alias="LSTM"]')).toBeVisible();
  await expect(hint).toHaveCount(0);
  // 改名后重新推断；忽略后同一个缩写不再提示
  await ed.locator('[data-alias="LSTM"]').getByRole("button").click();
  await name.fill("Generative Pre-trained Transformer");
  await expect(hint).toContainText("GPT");
  await hint.getByRole("button", { name: "忽略建议" }).click();
  await expect(hint).toHaveCount(0);
  // 已有别名是缩写时不提示
  await name.fill("air traffic management");
  await expect(hint).toContainText("ATM");
  await ed.locator('[data-term-field="alias"]').fill("A.T.M");
  await page.keyboard.press("Enter");
  await ed.locator('[data-term-field="alias"]').fill("AirTM");
  await page.keyboard.press("Enter");
  await expect(hint).toHaveCount(0);
});

test("编辑器：新建后下划线立即出现；冲突提示；编辑；删除", async ({ page }) => {
  await openSimple(page, [{ id: "t-lstm", name: "Long Short-Term Memory", aliases: ["LSTM"] }]);
  expect(firstSegs(await underlines(page, 1)).some((u) => /trajectory prediction/i.test(u.text))).toBe(false);

  // 新建
  await page.evaluate(() => (window as unknown as Win).__paperlens.useTermUiStore.getState().openTermEditor({} as never));
  const ed = editor(page);
  await expect(ed).toHaveAttribute("data-term-editor", "new");
  await ed.locator('[data-term-field="name"]').fill("trajectory prediction");
  await ed.locator('[data-term-field="alias"]').fill("TP");
  await page.keyboard.press("Enter");
  await expect(ed.locator('[data-alias="TP"]')).toBeVisible();
  // 表面形式预览：复数、大小写标记
  await expect(ed.locator('[data-form="trajectory predictions"]')).toBeVisible();
  await expect(ed.locator('[data-form="TP"]')).toContainText("Aa");
  await expect(ed.locator("[data-term-conflicts]")).toHaveCount(0);
  const t0 = Date.now();
  await ed.locator("[data-term-save]").click();
  await expect(ed).toHaveCount(0);
  await waitUnderlines(page, 1, (uls) => uls.some((u) => /^trajectory prediction$/i.test(u.text)));
  console.log(`[term] 保存新术语到下划线出现 ${Date.now() - t0} ms（含轮询）`);
  expect(Date.now() - t0).toBeLessThan(1500);
  const created = (await dbAll<{ id: string; name: string; aliases: string[] }>(page, "terms")).find((t) => t.name === "trajectory prediction")!;
  expect(created.aliases).toEqual(["TP"]);

  // 冲突：别名 LSTM 与已有术语重复
  await page.evaluate(() => (window as unknown as Win).__paperlens.useTermUiStore.getState().openTermEditor({} as never));
  await ed.locator('[data-term-field="name"]').fill("LSTM network");
  await ed.locator('[data-term-field="alias"]').fill("LSTM");
  await page.keyboard.press("Enter");
  await expect(ed.locator("[data-term-conflicts]")).toContainText("Long Short-Term Memory");
  await expect(ed.locator('[data-conflict="t-lstm"]')).toContainText("LSTM");
  // 过短 / 不含字母数字的形式：提示但不阻止
  await expect(ed.locator("[data-term-weak-forms]")).toHaveCount(0);
  await ed.locator('[data-term-field="alias"]').fill("a");
  await page.keyboard.press("Enter");
  await ed.locator('[data-term-field="alias"]').fill("-");
  await page.keyboard.press("Enter");
  await expect(ed.locator("[data-term-weak-forms]")).toContainText("“a”");
  await expect(ed.locator("[data-term-weak-forms]")).toContainText("“-” 不含字母或数字");
  // 限定到一个领域后，与全局术语仍然重叠
  await page.keyboard.press("Escape");
  await expect(ed).toHaveCount(0);

  // 编辑：从弹窗进入
  await clickAt(page, await findUl(page, 1, "t-lstm"));
  await popover(page).locator("[data-term-edit]").click();
  await expect(popover(page)).toHaveCount(0);
  await expect(ed).toHaveAttribute("data-term-editor", "edit");
  await expect(ed.locator('[data-term-field="name"]')).toHaveValue("Long Short-Term Memory");
  await ed.locator('[data-term-field="alias"]').fill("stacked LSTM");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(ed).toHaveCount(0);
  await expect.poll(async () => (await dbGet<{ aliases: string[] }>(page, "terms", "t-lstm")).aliases).toEqual(["LSTM", "stacked LSTM"]);
  await waitUnderlines(page, 1, (uls) => uls.some((u) => u.text === "stacked LSTM"));

  // 删除
  await page.evaluate(() => (window as unknown as Win).__paperlens.useTermUiStore.getState().openTermEditor({ termId: "t-lstm" } as never));
  await ed.getByRole("button", { name: "删除术语" }).click();
  await ed.locator("[data-term-delete-confirm]").getByRole("button", { name: "确认删除" }).click();
  await expect(ed).toHaveCount(0);
  await waitUnderlines(page, 1, (uls) => uls.length > 0 && !uls.some((u) => u.ids.includes("t-lstm")));
  expect(await dbGet(page, "terms", "t-lstm")).toBeUndefined();
});

test("编辑器：从选区创建，识别缩写和定义句式，并创建出处批注", async ({ page }) => {
  const id = await openSimple(page, []);
  const fileHash = ((await dbGet<{ fileHash: string }>(page, "papers", id)) as { fileHash: string }).fileHash;
  // 模拟批注模块的"设为术语"：选中第 1 页 "(LSTM)" 里的 LSTM（该页不含定义时用整页全文查找）
  const source = {
    paperId: id,
    page: 1,
    rects: [[100, 500, 130, 512]],
    quote: { exact: "LSTM", prefix: "uation. Long Short-Term Memory (", suffix: ") networks are a class of recurre" },
    fileHash,
  };
  await page.evaluate((source) => (window as unknown as Win).__paperlens.useTermUiStore.getState().openTermEditor({ initialName: "LSTM", source } as never), source);
  const ed = editor(page);
  await expect(ed.locator('[data-term-field="name"]')).toHaveValue("LSTM");
  const sug = ed.locator('[data-term-suggestion="definition"]');
  await expect(sug).toContainText("Long Short-Term Memory");
  await sug.getByRole("button", { name: "采用" }).click();
  await expect(ed.locator('[data-term-field="name"]')).toHaveValue("Long Short-Term Memory");
  await expect(ed.locator('[data-alias="LSTM"]')).toBeVisible();
  await expect(sug).toHaveCount(0);
  await ed.locator("[data-term-save]").click();
  await expect(ed).toHaveCount(0);
  const term = (await dbAll<{ id: string; name: string; sourceAnnotationId?: string }>(page, "terms")).find((t) => t.name === "Long Short-Term Memory")!;
  expect(term.sourceAnnotationId).toBeTruthy();
  const ann = await dbGet<{ termId: string; page: number }>(page, "annotations", term.sourceAnnotationId);
  expect(ann).toMatchObject({ termId: term.id, page: 1 });

  // 只是缩写、没有定义：建议移到别名
  await page.evaluate(
    (source) =>
      (window as unknown as Win).__paperlens.useTermUiStore.getState().openTermEditor({
        initialName: "GRU",
        source: { ...source, quote: { exact: "GRU", prefix: "a ", suffix: " cell" } },
      } as never),
    source,
  );
  const abbr = ed.locator('[data-term-suggestion="abbreviation"]');
  await expect(abbr).toBeVisible();
  await abbr.getByRole("button", { name: "移到别名" }).click();
  await expect(ed.locator('[data-alias="GRU"]')).toBeVisible();
  await expect(ed.locator('[data-term-field="name"]')).toHaveValue("");
  await expect(ed.locator('[data-term-field="name"]')).toBeFocused();
  // 名称为空不能保存
  await ed.locator("[data-term-save]").click();
  await expect(ed.getByRole("alert")).toContainText("名称");
});

// ---------------------------------------------------------------------------
// 显示开关、作用范围
// ---------------------------------------------------------------------------

test("工具栏开关：每页只标第一次、隐藏全部（持久化）", async ({ page }) => {
  const id = await openSimple(page);
  const before = firstSegs(await underlines(page, 1));
  const count = (uls: Ul[], id: string) => firstSegs(uls).filter((u) => u.ids.includes(id)).length;
  expect(count(before, "t-lstm")).toBeGreaterThan(1);

  await page.locator("[data-term-display-menu]").click();
  await page.locator("[data-term-first-only]").click();
  await page.keyboard.press("Escape");
  await waitUnderlines(page, 1, (uls) => count(uls, "t-lstm") === 1 && count(uls, "t-tf") === 1);
  // 保留的是第一次出现
  const firstLstm = before.filter((u) => u.ids.includes("t-lstm")).sort((a, b) => a.start - b.start)[0];
  expect(firstSegs(await underlines(page, 1)).find((u) => u.ids.includes("t-lstm"))!.start).toBe(firstLstm.start);

  await page.locator("[data-term-display-menu]").click();
  await page.locator("[data-term-hide-all]").click();
  await page.keyboard.press("Escape");
  await waitUnderlines(page, 1, (uls) => uls.length === 0);
  await expect(page.locator("[data-term-display-menu]")).toContainText("已隐藏");
  // 隐藏时点击术语位置不弹窗
  await clickAt(page, before[0]);
  await expect(popover(page)).toHaveCount(0);
  expect(await dbGet<{ value: unknown }>(page, "kv", "termDisplay")).toMatchObject({ value: { firstOnly: true, hidden: true } });

  // 刷新后保持
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __paperlens?: unknown }).__paperlens);
  await store(page).open(id);
  await expect(page.locator("[data-term-display-menu]")).toContainText("已隐藏", { timeout: 15_000 });
});

test("作用范围：只在所属领域（含子领域）的论文中标注，领域变化立即生效", async ({ page }) => {
  await dbPut(page, "domains", [
    { id: "d-atm", name: "空管", parentId: null, color: "#3b82f6", order: 0 },
    { id: "d-traj", name: "轨迹预测", parentId: "d-atm", color: "#10b981", order: 0 },
    { id: "d-nlp", name: "NLP", parentId: null, color: "#f59e0b", order: 1 },
  ]);
  const scoped: TermSeed[] = [
    { id: "t-ap", name: "aircraft positions", scope: { kind: "domains", domainIds: ["d-atm"] } },
    { id: "t-tf", name: "Transformer" },
  ];
  await seedTerms(page, scoped);
  const simpleId = await addFixture(page, "simple.pdf");
  await dbUpdate(page, "papers", simpleId, { domainIds: ["d-nlp"] });
  await store(page).open(simpleId);
  await waitGlyphs(page, 1);
  await waitUnderlines(page, 1, (uls) => uls.some((u) => u.ids.includes("t-tf")));
  expect((await underlines(page, 1)).some((u) => u.ids.includes("t-ap"))).toBe(false);
  // 把论文放进子领域：继承上级领域的术语
  await dbUpdate(page, "papers", simpleId, { domainIds: ["d-nlp", "d-traj"] });
  await waitUnderlines(page, 1, (uls) => uls.some((u) => u.ids.includes("t-ap")));
  // 改术语作用范围到 NLP 以外的领域：消失
  await dbUpdate(page, "terms", "t-ap", { scope: { kind: "domains", domainIds: [] } });
  await waitUnderlines(page, 1, (uls) => !uls.some((u) => u.ids.includes("t-ap")) && uls.length > 0);
});

// ---------------------------------------------------------------------------
// 相关笔记
// ---------------------------------------------------------------------------

test("相关笔记：搜索并添加连线，点击跳转，删除", async ({ page }) => {
  const id = await openSimple(page);
  await clickAt(page, await findUl(page, 1, "t-lstm"));
  const pop = popover(page);
  const related = pop.locator("[data-term-related]");
  await expect(related).toContainText("还没有连线");
  await related.getByRole("button", { name: "添加连线" }).click();
  await related.locator("[data-link-search]").fill("Transformer");
  await related.locator('[data-link-result="term:t-tf"]').click();
  await related.getByRole("radio", { name: "对比" }).click();
  await related.getByRole("button", { name: "添加连线" }).click();
  await expect(related.locator("[data-link-id]")).toHaveCount(1);
  await expect(related.locator("[data-link-id]")).toContainText("对比");
  const links = await dbAll<{ from: { id: string }; to: { id: string }; relation: string }>(page, "links");
  expect(links).toMatchObject([{ from: { id: "t-lstm" }, to: { id: "t-tf" }, relation: "compares" }]);

  // 再连一篇论文
  await related.getByRole("button", { name: "添加连线" }).click();
  await related.locator("[data-link-search]").fill("simple");
  await related.locator(`[data-link-result="paper:${id}"]`).click();
  await related.getByRole("button", { name: "添加连线" }).click();
  await expect(related.locator("[data-link-id]")).toHaveCount(2);

  // 点击术语连线：弹窗切到该术语，可返回
  await related.locator("[data-link-id]").first().getByRole("button").first().click();
  await expect(pop.locator("[data-term-name]")).toHaveText("Transformer");
  await expect(pop.locator("[data-term-related] [data-link-id]")).toContainText("←");
  await pop.getByRole("button", { name: "返回" }).click();
  await expect(pop.locator("[data-term-name]")).toHaveText("Long Short-Term Memory");

  // 删除
  const row = related.locator("[data-link-id]").first();
  await row.hover();
  await row.getByRole("button", { name: "删除连线" }).click();
  await expect(related.locator("[data-link-id]")).toHaveCount(1);
});
