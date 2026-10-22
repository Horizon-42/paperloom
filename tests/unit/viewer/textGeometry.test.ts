import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeItems } from "@/engine/normalize";
import type { TextItemLike } from "@/engine/types";
import type { PageLayerContext, PageTextInfo } from "@/components/viewer/overlays";
import {
  domRangeToTextRange,
  itemRangeToTextRange,
  refineRangeByPointer,
  snapToWords,
  textOffsetAtPoint,
  textRangeToPdfRects,
} from "@/lib/textGeometry";

const CW = 6; // 每个字符宽 6pt
const SIZE = 10;

/** 横排片段：起点 (x, baseline)，字号 10 */
function item(str: string, x: number, baseline: number, hasEOL = false): TextItemLike {
  return { str, transform: [SIZE, 0, 0, SIZE, x, baseline], width: str.length * CW, height: SIZE, hasEOL };
}

/** 按等宽字符手工构造字形框；nanAt 中的下标设为未映射 */
function boxes(it: TextItemLike, nanAt: number[] = []): Float32Array {
  const b = new Float32Array(it.str.length * 4);
  const [, , , , x, y] = it.transform;
  for (let j = 0; j < it.str.length; j++) {
    const v = nanAt.includes(j) ? [NaN, NaN, NaN, NaN] : [x + j * CW, y - 2, x + (j + 1) * CW, y + 8];
    b.set(v, j * 4);
  }
  return b;
}

/** 文本层 DOM：每个片段一个 span；split 时像词级校正那样拆成子 span */
function buildLayer(items: TextItemLike[], split = false) {
  const layerEl = document.createElement("div");
  layerEl.className = "textLayer";
  const divs = items.map((it) => {
    const span = document.createElement("span");
    if (split) {
      for (const m of it.str.matchAll(/\s+|\S+/g)) {
        const seg = document.createElement("span");
        seg.className = "pl-seg";
        seg.textContent = m[0];
        span.append(seg);
      }
    } else span.textContent = it.str;
    layerEl.append(span);
    return span;
  });
  const end = document.createElement("div");
  end.className = "endOfContent";
  layerEl.append(end);
  const pageEl = document.createElement("div");
  pageEl.append(layerEl);
  document.body.append(pageEl);
  return { layerEl, divs, pageEl };
}

function makeCtx(items: TextItemLike[], opts: { charBoxes?: Float32Array[] | null; split?: boolean; scanned?: boolean } = {}) {
  const { layerEl, divs, pageEl } = buildLayer(items, opts.split);
  const text: PageTextInfo = {
    items,
    divs,
    layerEl,
    normalized: normalizeItems(items),
    charBoxes: opts.charBoxes === undefined ? items.map((it) => boxes(it)) : opts.charBoxes,
    scanned: !!opts.scanned,
  };
  // viewport：scale 1，页面高 800，PDF y 向上 → 屏幕 y 向下
  const viewport = {
    rotation: 0,
    convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
    convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
  };
  const ctx = {
    paneId: "left",
    paperId: "p",
    fileHash: "h",
    pageNumber: 1,
    viewport,
    pageEl,
    text,
  } as unknown as PageLayerContext;
  return { ctx, text };
}

const find = (text: PageTextInfo, s: string) => {
  const start = text.normalized.text.indexOf(s);
  return { start, end: start + s.length };
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("textRangeToPdfRects（字形映射）", () => {
  const items = [item("Hello brave ", 10, 700), item("world", 82, 700, true), item("second line here", 10, 680)];

  it("单词得到一个矩形，纵向用整个片段的范围", () => {
    const { ctx, text } = makeCtx(items);
    const { start, end } = find(text, "brave");
    expect(textRangeToPdfRects(ctx, start, end)).toEqual([[10 + 6 * CW, 698, 10 + 11 * CW, 708]]);
  });

  it("同一行相邻片段合并，跨行得到多段", () => {
    const { ctx, text } = makeCtx(items);
    const a = find(text, "brave world");
    expect(textRangeToPdfRects(ctx, a.start, a.end)).toEqual([[46, 698, 112, 708]]);
    const b = find(text, "world second");
    const rects = textRangeToPdfRects(ctx, b.start, b.end);
    expect(rects).toHaveLength(2);
    expect(rects[1]).toEqual([10, 678, 10 + 6 * CW, 688]);
  });

  it("去掉区间两端的空白", () => {
    const { ctx, text } = makeCtx(items);
    const { start } = find(text, "brave");
    expect(textRangeToPdfRects(ctx, start - 1, start + 5)).toEqual(textRangeToPdfRects(ctx, start, start + 5));
  });

  it("文本层未就绪时返回 []", () => {
    const { ctx } = makeCtx(items);
    expect(textRangeToPdfRects({ ...ctx, text: null }, 0, 5)).toEqual([]);
  });
});

describe("textRangeToPdfRects（DOM 兜底）", () => {
  const items = [item("alpha beta", 10, 700)];

  // jsdom 没有 Range.getClientRects，这里补一个可控的实现
  const calls = { n: 0 };
  function stubRects(rects: DOMRect[]) {
    calls.n = 0;
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      writable: true,
      value: () => {
        calls.n++;
        return Object.assign([...rects], { item: (i: number) => rects[i] }) as unknown as DOMRectList;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 800));
  }
  afterEach(() => {
    delete (Range.prototype as Partial<Range>).getClientRects;
  });

  it("charBoxes 为 null 时用 DOM Range，并合并同一行的矩形", () => {
    const { ctx, text } = makeCtx(items, { charBoxes: null });
    stubRects([new DOMRect(40, 92, 20, 10), new DOMRect(60, 92, 18, 10)]);
    const { start, end } = find(text, "beta");
    expect(textRangeToPdfRects(ctx, start, end)).toEqual([[40, 698, 78, 708]]);
  });

  it("端点字符未映射时也退回 DOM", () => {
    const { ctx, text } = makeCtx(items, { charBoxes: [boxes(items[0], [9])] });
    stubRects([new DOMRect(40, 92, 38, 10)]);
    const { start, end } = find(text, "beta");
    expect(textRangeToPdfRects(ctx, start, end)).toEqual([[40, 698, 78, 708]]);
    expect(calls.n).toBe(1);
  });
});

describe("domRangeToTextRange", () => {
  const items = [item("The LSTM model ", 10, 700), item("works well", 100, 700, true), item("on long sequences", 10, 680)];

  for (const split of [false, true]) {
    it(`文本节点端点换算为规范化区间${split ? "（词级校正后的子 span）" : ""}`, () => {
      const { ctx, text } = makeCtx(items, { split });
      // 选中 "LSTM model works"：从片段 0 偏移 4 到片段 1 偏移 5
      const nodeAt = (i: number, off: number) => {
        const walker = document.createTreeWalker(text.divs[i], NodeFilter.SHOW_TEXT);
        let acc = 0;
        for (let n = walker.nextNode() as Text; n; n = walker.nextNode() as Text) {
          if (off <= acc + n.data.length) return [n, off - acc] as const;
          acc += n.data.length;
        }
        throw new Error("offset");
      };
      const range = document.createRange();
      range.setStart(...nodeAt(0, 4));
      range.setEnd(...nodeAt(1, 5));
      const r = domRangeToTextRange(ctx, range)!;
      expect(text.normalized.text.slice(r.start, r.end)).toBe("LSTM model works");
    });
  }

  it("去掉首尾空白；元素边界取相邻字符", () => {
    const { ctx, text } = makeCtx(items);
    const range = document.createRange();
    range.setStart(text.divs[0].firstChild!, 3); // "The| LSTM"
    range.setEnd(text.layerEl, 2); // 片段 1 之后
    const r = domRangeToTextRange(ctx, range)!;
    expect(text.normalized.text.slice(r.start, r.end)).toBe("LSTM model works well");
  });

  it("选区跨出本页时裁剪到本页文本层；不在本页时返回 null", () => {
    const { ctx, text } = makeCtx(items);
    const other = document.createElement("div");
    other.textContent = "outside";
    document.body.append(other);
    const range = document.createRange();
    range.setStart(text.divs[2].firstChild!, 3);
    range.setEnd(other.firstChild!, 3);
    const r = domRangeToTextRange(ctx, range)!;
    expect(text.normalized.text.slice(r.start, r.end)).toBe("long sequences");
    const outside = document.createRange();
    outside.selectNodeContents(other);
    expect(domRangeToTextRange(ctx, outside)).toBeNull();
  });

  it("只选中空白时返回 null", () => {
    const { ctx, text } = makeCtx(items);
    const range = document.createRange();
    range.setStart(text.divs[0].firstChild!, 3);
    range.setEnd(text.divs[0].firstChild!, 4);
    expect(domRangeToTextRange(ctx, range)).toBeNull();
  });

  it("扫描件把端点吸附到最近的词边界", () => {
    const { ctx, text } = makeCtx(items, { scanned: true });
    const range = document.createRange();
    range.setStart(text.divs[0].firstChild!, 5); // L|STM：靠近词首
    range.setEnd(text.divs[0].firstChild!, 13); // mod|el 末尾附近 → 吸附到词尾
    const r = domRangeToTextRange(ctx, range)!;
    expect(text.normalized.text.slice(r.start, r.end)).toBe("LSTM model");
  });

  it("连字展开：选中 ﬁ 得到两个规范化字符", () => {
    const lig = [item("the ﬁrst ﬁgure", 10, 700)];
    const { ctx, text } = makeCtx(lig);
    const range = document.createRange();
    range.setStart(text.divs[0].firstChild!, 4);
    range.setEnd(text.divs[0].firstChild!, 8);
    const r = domRangeToTextRange(ctx, range)!;
    expect(text.normalized.text.slice(r.start, r.end)).toBe("first");
    // 反过来：规范化区间 → 片段内的 ﬁ 字形
    expect(textRangeToPdfRects(ctx, r.start, r.end)).toEqual([[10 + 4 * CW, 698, 10 + 8 * CW, 708]]);
  });
});

describe("itemRangeToTextRange / snapToWords", () => {
  it("片段内区间换算", () => {
    const items = [item("alpha beta gamma", 10, 700)];
    const { ctx, text } = makeCtx(items);
    const r = itemRangeToTextRange(ctx, 0, 6, 10)!;
    expect(text.normalized.text.slice(r.start, r.end)).toBe("beta");
  });

  it("只吸附离词边界不超过 2 个字符的端点；吸附后为空时保持原区间", () => {
    const t = "alpha beta gamma";
    expect(snapToWords(t, { start: 1, end: 9 })).toEqual({ start: 0, end: 10 });
    expect(snapToWords(t, { start: 7, end: 8 })).toEqual({ start: 7, end: 8 });
    // 长词中间：离边界太远，不扩成整词
    const long = "internationalization works";
    expect(snapToWords(long, { start: 5, end: 9 })).toEqual({ start: 5, end: 9 });
  });

  it("汉字每个字单独成词，不会把整句吸成一个词", () => {
    const t = "我们使用注意力机制来建模序列";
    const r = { start: t.indexOf("注意力"), end: t.indexOf("注意力") + 3 };
    expect(snapToWords(t, r)).toEqual(r);
    // 中英混排：LSTM 两侧是词边界
    const m = "使用LSTM模型";
    expect(snapToWords(m, { start: 3, end: 6 })).toEqual({ start: 2, end: 6 });
  });

  it("行尾连字符合并后的词不会被整体扩展", () => {
    const t = "the interpolated values"; // inter-/polated 规范化后连成一个词
    expect(snapToWords(t, { start: 6, end: 12 })).toEqual({ start: 4, end: 12 });
  });
});

describe("textOffsetAtPoint / refineRangeByPointer", () => {
  // 片段 "Hello brave world" 起点 x=10，每字符宽 6；基线 700，字形框 y 698–708 → 屏幕 y 92–102
  const items = [item("Hello brave world", 10, 700)];
  const Y = 97;
  const xOf = (j: number, frac: number) => 10 + (j + frac) * CW;

  it("按字形前半/后半返回字符前/后的位置；空白和字形外返回 null", () => {
    const { ctx, text } = makeCtx(items);
    const b = text.normalized.text.indexOf("brave");
    expect(textOffsetAtPoint(ctx, xOf(6, 0.2), Y)).toBe(b);
    expect(textOffsetAtPoint(ctx, xOf(6, 0.8), Y)).toBe(b + 1);
    expect(textOffsetAtPoint(ctx, xOf(5, 0.5), Y)).toBeNull(); // 空格
    expect(textOffsetAtPoint(ctx, xOf(6, 0.5), 300)).toBeNull(); // 行外
    expect(textOffsetAtPoint({ ...ctx, text: { ...text, charBoxes: null } }, xOf(6, 0.2), Y)).toBeNull();
  });

  it("原生选区少了首字母/末字母时按指针校正；正向、反向拖选结果相同", () => {
    const { ctx, text } = makeCtx(items);
    const b = text.normalized.text.indexOf("brave");
    const down = { clientX: xOf(6, 0.1), clientY: Y };
    const up = { clientX: xOf(10, 0.9), clientY: Y };
    const want = { start: b, end: b + 5 };
    expect(refineRangeByPointer(ctx, { start: b + 1, end: b + 5 }, down, up)).toEqual(want); // "rave"
    expect(refineRangeByPointer(ctx, { start: b, end: b + 4 }, down, up)).toEqual(want); // "brav"
    expect(refineRangeByPointer(ctx, { start: b + 1, end: b + 4 }, up, down)).toEqual(want); // 反向
  });

  it("任一端没命中字形、或与原区间相差超过 2 个字符时原样返回", () => {
    const { ctx, text } = makeCtx(items);
    const b = text.normalized.text.indexOf("brave");
    const native = { start: b + 3, end: b + 5 };
    const down = { clientX: xOf(6, 0.1), clientY: Y };
    const up = { clientX: xOf(10, 0.9), clientY: Y };
    expect(refineRangeByPointer(ctx, native, down, up)).toBe(native); // 起点差 3
    const r = { start: b + 1, end: b + 5 };
    expect(refineRangeByPointer(ctx, r, { clientX: xOf(5, 0.5), clientY: Y }, up)).toBe(r); // 按在空格上
    expect(refineRangeByPointer(ctx, r, down, { clientX: 900, clientY: Y })).toBe(r); // 抬起在页外
  });

  it("180° 文字沿阅读方向判定前后半", () => {
    // 片段 "ab" 起点 x=100 向左排：a 占 94–100，b 占 88–94
    const it180: TextItemLike = { str: "ab", transform: [-SIZE, 0, 0, -SIZE, 100, 700], width: 12, height: SIZE };
    const box = new Float32Array([94, 692, 100, 702, 88, 692, 94, 702]);
    const { ctx } = makeCtx([it180], { charBoxes: [box] });
    expect(textOffsetAtPoint(ctx, 99, 800 - 697)).toBe(0); // a 的阅读方向前半（右侧）
    expect(textOffsetAtPoint(ctx, 95, 800 - 697)).toBe(1);
    expect(textOffsetAtPoint(ctx, 89, 800 - 697)).toBe(2);
  });
});
