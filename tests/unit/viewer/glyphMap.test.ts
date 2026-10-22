// @vitest-environment node
// 字形映射回归测试：用 pdfjs-dist legacy 在 Node 下加载 fixtures，检查 extractGlyphs / alignGlyphs。
// 几何的独立参照是 pdf.js getTextContent 给出的片段起点（transform）和宽度（width）。
import { afterAll, describe, expect, it } from "vitest";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { alignGlyphs, buildPageGlyphMap, MAX_ASCENT, type PageGlyphMap, type RawGlyph } from "@/lib/glyphMap";

interface Item {
  str: string;
  transform: number[];
  width: number;
}

// app 的 tsconfig 不含 Node 类型，这里按需动态导入 fs
const nodeFs = "node:fs";
const readFixture = async (file: string): Promise<Uint8Array> => {
  const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(p: URL): Uint8Array };
  return new Uint8Array(fs.readFileSync(new URL(`../../../fixtures/${file}`, import.meta.url)));
};

const docs = new Map<string, Promise<PDFDocumentProxy>>();
function open(file: string) {
  let d = docs.get(file);
  if (!d) {
    d = readFixture(file).then((data) => getDocument({ data, verbosity: 0 }).promise);
    docs.set(file, d);
  }
  return d;
}
afterAll(async () => {
  for (const d of docs.values()) await (await d).loadingTask.destroy();
});

async function pageMap(file: string, pageNumber: number): Promise<{ items: Item[]; map: PageGlyphMap }> {
  const doc = await open(file);
  const page = await doc.getPage(pageNumber);
  const opList = await page.getOperatorList();
  // 与查看器一致：保留连字（disableNormalization），glyphMap 也不规范化
  const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
  const items = tc.items.filter((it) => "str" in it) as unknown as Item[];
  const map = buildPageGlyphMap(opList, page.commonObjs, items, { styles: tc.styles, view: page.view, normalize: false });
  return { items, map };
}

/** 横排、正向的片段：比较首字符左边与片段起点、末字符右边与起点 + 宽度 */
function edgeErrors(items: Item[], map: PageGlyphMap) {
  const errs: { str: string; left: number; right: number; baselineInside: boolean }[] = [];
  items.forEach((it, i) => {
    const t = it.transform;
    if (Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3 || t[0] <= 0 || !it.str.trim()) return;
    const box = map.charBoxes[i];
    const first = it.str.search(/\S/);
    const last = it.str.length - 1 - it.str.split("").reverse().join("").search(/\S/);
    const size = Math.hypot(t[2], t[3]);
    const x1 = box[first * 4];
    const x2 = box[last * 4 + 2];
    const trailingWs = last < it.str.length - 1;
    errs.push({
      str: it.str,
      left: Math.abs(x1 - t[4]) / size,
      // 末尾有空白时 width 包含空白，无法直接比较右边
      right: trailingWs ? 0 : Math.abs(x2 - (t[4] + it.width)) / size,
      baselineInside: box[first * 4 + 1] < t[5] && box[first * 4 + 3] > t[5],
    });
  });
  return errs;
}

const CASES: [string, number, string][] = [
  ["glyph-ops.pdf", 1, "TJ 字距、Tc/Tw/Tz/Ts/Tm"],
  ["glyph-ops.pdf", 2, "Form XObject"],
  ["glyph-ops.pdf", 3, "Tr 3 不可见副本"],
  ["glyph-ops.pdf", 4, "扫描件"],
  ["glyph-ops.pdf", 5, "/Rotate 90"],
  ["glyph-ops.pdf", 6, "连字字体 + Tc"],
  ["simple.pdf", 1, "普通单栏"],
  ["two-column.pdf", 2, "双栏交错写入"],
  ["ligature.pdf", 1, "连字"],
];

describe("buildPageGlyphMap", () => {
  it.each(CASES)("%s 第 %i 页（%s）：非空白字符全部对齐，边缘与 pdf.js 片段几何一致", async (file, pn) => {
    const { items, map } = await pageMap(file, pn);
    expect(map.align.chars).toBeGreaterThan(0);
    expect(map.align.mapped).toBe(map.align.chars);
    expect(map.align.resyncs).toBe(0);
    const errs = edgeErrors(items, map);
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) {
      expect(e.left, `${e.str} 左边`).toBeLessThan(0.02);
      expect(e.right, `${e.str} 右边`).toBeLessThan(0.1);
      expect(e.baselineInside, `${e.str} 基线`).toBe(true);
    }
  });

  it("Tc/Tz 改变字形宽度：Tz 70% 的片段明显变窄", async () => {
    const { items, map } = await pageMap("glyph-ops.pdf", 1);
    const width = (s: string) => {
      const i = items.findIndex((it) => it.str.startsWith(s));
      const b = map.charBoxes[i];
      return b[(items[i].str.trimEnd().length - 1) * 4 + 2] - b[0];
    };
    expect(width("Horizontal scaling seventy")).toBeLessThan(width("Horizontal scaling widened") * 0.75);
  });

  it("Ts 上标的字形框整体抬高", async () => {
    const { items, map } = await pageMap("glyph-ops.pdf", 1);
    const yOf = (s: string) => map.charBoxes[items.findIndex((it) => it.str.startsWith(s))][1];
    expect(yOf("raised") - yOf("Baseline")).toBeCloseTo(6, 0);
    expect(yOf("lowered") - yOf("Baseline")).toBeCloseTo(-4, 0);
  });

  it("不可见文字与扫描件判定", async () => {
    const dup = await pageMap("glyph-ops.pdf", 3);
    expect(dup.map.extract.invisibleGlyphs * 2).toBe(dup.map.extract.glyphs);
    expect(dup.map.scanned).toBe(false);
    // 不可见副本与可见原文位置一致
    expect(Array.from(dup.map.charBoxes[1])).toEqual(Array.from(dup.map.charBoxes[0]));
    const scan = await pageMap("glyph-ops.pdf", 4);
    expect(scan.map.extract.imageCoverage).toBeGreaterThan(0.99);
    expect(scan.map.scanned).toBe(true);
    for (const pn of [1, 2, 5, 6]) expect((await pageMap("glyph-ops.pdf", pn)).map.scanned).toBe(false);
  });

  it("连字字符对应一个字形框", async () => {
    const { items, map } = await pageMap("glyph-ops.pdf", 6);
    const i = items.findIndex((it) => it.str.includes("ﬁrst"));
    const j = items[i].str.indexOf("ﬁ");
    const b = map.charBoxes[i];
    const w = b[j * 4 + 2] - b[j * 4];
    expect(w).toBeGreaterThan(5); // 16pt 的 ﬁ 约 0.55 em
    expect(b[j * 4 + 2]).toBeCloseTo(b[(j + 1) * 4], 3); // 紧接着 "r"
  });

  it("负字号与 180° 文字：字形向左排、倒置，边缘与片段几何一致", async () => {
    const { items, map } = await pageMap("glyph-ops.pdf", 7);
    expect(map.align.mapped).toBe(map.align.chars);
    for (const s of ["Negative font size words", "Rotated half turn text"]) {
      const i = items.findIndex((it) => it.str === s);
      const t = items[i].transform;
      expect(t[0]).toBeLessThan(0);
      const b = map.charBoxes[i];
      const size = Math.abs(t[3]);
      // 第一个字符在最右边，最后一个字符在最左边
      expect(Math.abs(b[2] - t[4]) / size, `${s} 首字右缘`).toBeLessThan(0.02);
      const last = s.length - 1;
      expect(b[last * 4]).toBeLessThan(b[0]);
      // pdf.js textContent 给负字号片段的 width 偏小（与 canvas 实际排版不符），只对 Tm 旋转的片段比较宽度；
      // 负字号片段的末端由 e2e 用墨迹验证
      if (s.startsWith("Rotated")) {
        expect(Math.abs(b[last * 4] - (t[4] - items[i].width)) / size, `${s} 末字左缘`).toBeLessThan(0.1);
      }
      // 倒置：字形主体在基线下方
      expect(b[1]).toBeLessThan(t[5] - 0.5 * size);
      expect(b[3]).toBeGreaterThan(t[5]);
    }
  });

  it("Type3：前进量、不可见文字不推进、FontMatrix 平移", async () => {
    const { items, map } = await pageMap("glyph-ops.pdf", 8);
    const box = (s: string, j: number) => {
      const b = map.charBoxes[items.findIndex((it) => it.str === s)];
      return [b[j * 4], b[j * 4 + 2]];
    };
    // A/B/C 宽 600、空格 300（千分之一 em），字号 20
    expect(box("ABC CAB BCA ACB", 0)).toEqual([72, 84]);
    expect(box("ABC CAB BCA ACB", 4)[0]).toBeCloseTo(72 + 3 * 12 + 6, 4);
    // 渲染模式 3 的 Type3 文字：canvas 不画也不推进，字形框为 NaN；后面的可见文字从原位置开始
    const hidden = box("CCC BAC CBA", 0);
    expect(hidden.every(Number.isNaN)).toBe(true);
    expect(box("CCC BAC CBA", 4)).toEqual([72, 84]);
    // FontMatrix 平移 0.02：每个字形多前进 0.02 × 20 = 0.4
    expect(box("CAB ABC BBA", 1)[0]).toBeCloseTo(72 + 12.4, 4);
    expect(box("CAB ABC BBA", 4)[0]).toBeCloseTo(72 + 3 * 12.4 + 6.4, 4);
    expect(map.extract.type3Glyphs).toBeGreaterThan(30);
    expect(map.align.resyncs).toBe(0);
  });

  it("竖排字形进入字形流（框为 NaN），其后的横排文字照常对齐", async () => {
    const { items, map } = await pageMap("glyph-ops.pdf", 9);
    expect(map.extract.verticalGlyphs).toBe("Vertical".length);
    expect(map.align.resyncs).toBe(0);
    const v = map.charBoxes[items.findIndex((it) => it.str === "Vertical")];
    expect(Array.from(v).every(Number.isNaN)).toBe(true);
    const after = items.findIndex((it) => it.str.startsWith("Horizontal line after"));
    expect(Array.from(map.charBoxes[after]).some(Number.isNaN)).toBe(false);
    expect(map.charBoxes[after][0]).toBeCloseTo(72, 3);
  });

  it("纵向范围收紧：ascent 不超过 0.95 em", async () => {
    const { items, map } = await pageMap("simple.pdf", 1);
    const t = items[0].transform;
    const size = Math.abs(t[3]);
    expect((map.charBoxes[0][3] - t[5]) / size).toBeLessThanOrEqual(MAX_ASCENT + 1e-6);
  });
});

/** 手工字形：每个字符宽 10，沿 x 排列 */
function glyphRun(text: string, x0 = 0, opts: { nan?: boolean } = {}): RawGlyph[] {
  return [...text].map((u, k) =>
    opts.nan
      ? { u, x1: NaN, y1: NaN, x2: NaN, y2: NaN, invisible: false }
      : { u, x1: x0 + k * 10, y1: 0, x2: x0 + (k + 1) * 10, y2: 10, invisible: false },
  );
}

describe("alignGlyphs", () => {
  it("单字符片段重新同步时跨片段比较，不会匹配到后面同字符的字形", () => {
    // 字形流开头多出 "za"（如页面外的字形），正确位置是第二个 "a"
    const glyphs = glyphRun("zaqabc", 0);
    const { charBoxes, stats } = alignGlyphs(glyphs, [{ str: "a" }, { str: "b" }, { str: "c" }]);
    expect(charBoxes[0][0]).toBe(30);
    expect(charBoxes[1][0]).toBe(40);
    expect(charBoxes[2][0]).toBe(50);
    expect(stats.resyncs).toBe(1);
  });

  it("没有位置的字形（竖排、不可见 Type3）保持对齐但不计入已映射", () => {
    const glyphs = [...glyphRun("ab", 0, { nan: true }), ...glyphRun("cd", 100)];
    const { charBoxes, stats } = alignGlyphs(glyphs, [{ str: "ab" }, { str: "cd" }]);
    expect(Number.isNaN(charBoxes[0][0])).toBe(true);
    expect(charBoxes[1][0]).toBe(100);
    expect(stats).toMatchObject({ chars: 4, mapped: 2, resyncs: 0 });
  });

  it("片段首尾的空白按片段起点和宽度推算", () => {
    const glyphs = glyphRun("ab", 5);
    const it = { str: " ab  ", transform: [10, 0, 0, 10, 0, 0], width: 40 };
    const [b] = alignGlyphs(glyphs, [it]).charBoxes;
    expect(Array.from(b.slice(0, 4))).toEqual([0, 0, 5, 10]); // 开头空白：0 → 5
    expect(b[3 * 4]).toBe(25); // 结尾两个空白均分 25 → 40
    expect(b[3 * 4 + 2]).toBeCloseTo(32.5);
    expect(b[4 * 4 + 2]).toBe(40);
  });
});
