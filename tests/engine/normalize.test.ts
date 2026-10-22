import { describe, expect, it } from "vitest";
import {
  fromNormalizedText,
  mapRangeToItems,
  normalizeItems,
  normalizeString,
  toLowerAligned,
} from "@/engine/normalize";
import type { NormalizedText, TextItemLike } from "@/engine/types";
import { column, eolItem, item } from "./helpers";

/** 把规范化区间映射回片段，再拼出片段中的原文 */
function sliceItems(items: TextItemLike[], nt: NormalizedText, start: number, end: number): string | null {
  const r = mapRangeToItems(nt, start, end);
  if (!r) return null;
  if (r.startItem === r.endItem) return items[r.startItem].str.slice(r.startOffset, r.endOffset);
  let s = items[r.startItem].str.slice(r.startOffset);
  for (let i = r.startItem + 1; i < r.endItem; i++) s += "|" + items[i].str;
  return s + "|" + items[r.endItem].str.slice(0, r.endOffset);
}

function expectAligned(nt: NormalizedText) {
  expect(nt.lower.length).toBe(nt.text.length);
  expect(nt.itemIndex.length).toBe(nt.text.length);
  expect(nt.charOffset.length).toBe(nt.text.length);
}

describe("normalizeItems：拼接", () => {
  it("同一行：有间隔补空格，紧挨着直接相连", () => {
    // "Long" 宽 20；与下一片段间隔 3（0.3 em）→ 空格；"Short-Term" 与 "s" 紧挨着
    const items = [item("Long", 0, 700), item("Short-Term", 23, 700), item("s", 73, 700)];
    const nt = normalizeItems(items);
    expect(nt.text).toBe("Long Short-Terms");
    expectAligned(nt);
    expect(nt.itemIndex[4]).toBe(-1); // 合成空格
    expect(nt.charOffset[4]).toBe(-1);
  });

  it("很小的字距不补空格", () => {
    const items = [item("Trans", 0, 700), item("former", 25.5, 700)];
    expect(normalizeItems(items).text).toBe("Transformer");
  });

  it("换行补空格，已有空白不重复补，连续空白压缩", () => {
    const items = [item("hello   ", 0, 700, { eol: true }), item("  big\tworld", 0, 688)];
    const nt = normalizeItems(items);
    expect(nt.text).toBe("hello big world");
    // 真实空白保留原映射
    expect(nt.itemIndex[5]).toBe(0);
    expect(nt.charOffset[5]).toBe(5);
  });

  it("pdf.js 的空 EOL 片段与纯空白片段", () => {
    const items = [
      item("alpha", 0, 700),
      { str: " ", transform: [10, 0, 0, 10, 25, 700], width: 8, height: 0 },
      item("beta", 33, 700),
      eolItem(53, 700),
      item("gamma", 0, 688),
      eolItem(25, 688),
    ];
    const nt = normalizeItems(items);
    expect(nt.text).toBe("alpha beta gamma");
    expect(nt.itemIndex[5]).toBe(1); // 来自纯空白片段
  });

  it("首尾空白与空片段不产生多余字符", () => {
    const items = [eolItem(), item("  ", 0, 700), item(" word ", 0, 688, { eol: true }), eolItem(), item("   ", 0, 676)];
    expect(normalizeItems(items).text).toBe("word");
    expect(normalizeItems([]).text).toBe("");
  });

  it("上下标（脚注标记）与正文之间补空格", () => {
    const items = [item("Transformer", 0, 700), item("1", 55, 703.5, { size: 7 }), item(" is", 58.5, 700)];
    expect(normalizeItems(items).text).toBe("Transformer 1 is");
  });

  it("小型大写（同基线、字号变小）不补空格", () => {
    const items = [item("L", 0, 700), item("STM", 5, 700, { size: 8 })];
    expect(normalizeItems(items).text).toBe("LSTM");
  });
});

describe("normalizeItems：行尾连字符", () => {
  it("trans- / former → transformer，并能映射回两个片段", () => {
    const items = column(["the trans-", "former model"], 0, 700);
    const nt = normalizeItems(items);
    expect(nt.text).toBe("the transformer model");
    const s = nt.text.indexOf("transformer");
    expect(mapRangeToItems(nt, s, s + "transformer".length)).toEqual({
      startItem: 0,
      startOffset: 4,
      endItem: 1,
      endOffset: 6,
    });
  });

  it("连字符后有空格和 pdf.js 空 EOL 片段时也能合并", () => {
    const items = [item("the trans- ", 0, 700), eolItem(55, 700), item("former", 0, 688)];
    expect(normalizeItems(items).text).toBe("the transformer");
  });

  it("下一行大写开头时保留连字符并直接相连", () => {
    const items = column(["a Bi-", "LSTM model"], 0, 700);
    expect(normalizeItems(items).text).toBe("a Bi-LSTM model");
  });

  it("软连字符与 U+2010 在行尾同样处理", () => {
    expect(normalizeItems(column(["trans­", "former"], 0, 700)).text).toBe("transformer");
    expect(normalizeItems(column(["Bi­", "LSTM"], 0, 700)).text).toBe("Bi-LSTM");
    expect(normalizeItems(column(["pre‐", "trained"], 0, 700)).text).toBe("pretrained");
    expect(normalizeItems(column(["Bi‐", "LSTM"], 0, 700)).text).toBe("Bi-LSTM");
  });

  it("同一行片段末尾的软连字符后跟空白时，空白也一并丢弃", () => {
    expect(normalizeItems([item("co\u00AD ", 0, 700, { width: 10 }), item("ntinue", 10, 700)]).text).toBe("continue");
    const withWs = [item("co\u00AD", 0, 700, { width: 10 }), { str: " ", transform: [10, 0, 0, 10, 10, 700], width: 0, height: 0 }, item("ntinue", 10, 700)];
    expect(normalizeItems(withWs).text).toBe("continue");
  });

  it("行内软连字符删除；同一行片段末尾的软连字符也删除", () => {
    expect(normalizeItems([item("trans­former", 0, 700)]).text).toBe("transformer");
    expect(normalizeItems([item("trans­", 0, 700), item("former", 30, 700)]).text).toBe("transformer");
  });

  it("同一行内的连字符不删除", () => {
    const items = [item("pre-", 0, 700), item("trained", 20, 700)];
    expect(normalizeItems(items).text).toBe("pre-trained");
  });

  it("前面不是字母的独立破折号不合并", () => {
    expect(normalizeItems(column(["results -", "which"], 0, 700)).text).toBe("results - which");
    expect(normalizeItems(column(["1-", "2"], 0, 700)).text).toBe("1- 2");
  });
});

describe("normalizeItems：字符规范化", () => {
  it("连字展开，多个规范字符指向同一个原字符", () => {
    const items = [item("eﬃcient ﬁne", 0, 700)];
    const nt = normalizeItems(items);
    expect(nt.text).toBe("efficient fine");
    expectAligned(nt);
    expect(Array.from(nt.charOffset.slice(0, 5))).toEqual([0, 1, 1, 1, 2]);
    // 区间落在展开字符中间 → 映射到整个原字符
    expect(mapRangeToItems(nt, 2, 3)).toEqual({ startItem: 0, startOffset: 1, endItem: 0, endOffset: 2 });
    expect(sliceItems(items, nt, 0, 9)).toBe("eﬃcient");
  });

  it("特殊空白视为空格，零宽字符删除，U+2011 → -", () => {
    const nt = normalizeItems([item("a b​c‑d　e﻿", 0, 700)]);
    expect(nt.text).toBe("a bc-d e");
    expectAligned(nt);
  });

  it("小写副本与原文等长；长度会变的字符保留原样", () => {
    const nt = normalizeItems([item("İSTANBUL Straße ΣΑΣ LSTM", 0, 700)]);
    expectAligned(nt);
    expect(nt.lower).toBe("İstanbul straße σασ lstm");
    expect(toLowerAligned("ATM")).toBe("atm");
    expect(toLowerAligned("𐐀")).toBe("𐐨"); // 代理对
  });
});

describe("normalizeItems：硬边界", () => {
  it("跨栏（y 向上大幅回跳）插入合成的 \\n", () => {
    const items = [
      ...column(["first column text", "ends with Long Short-Term"], 50, 700),
      ...column(["Memory networks are", "popular"], 320, 700),
    ];
    const nt = normalizeItems(items);
    expect(nt.text).toBe("first column text ends with Long Short-Term\nMemory networks are popular");
    const k = nt.text.indexOf("\n");
    expect(nt.itemIndex[k]).toBe(-1);
    expect(nt.charOffset[k]).toBe(-1);
  });

  it("硬边界处行尾连字符 + 非小写开头：保留连字符并照常插入 \\n", () => {
    // 栏底 "were ob-"，接着是图注（另一区域），再回到正文
    const items = [
      item("traffic flows were ob-", 50, 120, { eol: true }),
      item("Figure 2: Layout of LGA Airport.", 320, 700, { eol: true }),
      item("served in 2011.", 320, 650),
    ];
    expect(normalizeItems(items).text).toBe("traffic flows were ob-\nFigure 2: Layout of LGA Airport.\nserved in 2011.");
  });

  it("跨栏但行尾是连字符 + 小写：仍按单词续写合并", () => {
    const items = [...column(["the trans-"], 50, 400), ...column(["former is"], 320, 700)];
    expect(normalizeItems(items).text).toBe("the transformer is");
  });

  it("同一行的大间隔（栏间距、表格列）插入 \\n", () => {
    const items = [item("Long Short-Term", 50, 700), item("Memory", 320, 700)];
    expect(normalizeItems(items).text).toBe("Long Short-Term\nMemory");
  });

  it("向下大跳（跨过图表到脚注）插入 \\n，正常段落间距不插", () => {
    const far = [item("above the figure", 50, 700, { eol: true }), item("footnote", 50, 100)];
    expect(normalizeItems(far).text).toBe("above the figure\nfootnote");
    const para = [item("end of paragraph.", 50, 700, { eol: true }), item("Next one", 65, 676)];
    expect(normalizeItems(para).text).toBe("end of paragraph. Next one");
  });

  it("新行起点远在上一行右端之后插入 \\n", () => {
    const items = [item("short", 50, 700, { eol: true }), item("right side", 300, 688)];
    expect(normalizeItems(items).text).toBe("short\nright side");
  });

  it("书写方向变化（旋转文字）插入 \\n", () => {
    const rotated: TextItemLike = { str: "arXiv", transform: [0, 10, -10, 0, 20, 300], width: 25, height: 10 };
    const items = [item("body text", 50, 700), rotated, item("more", 50, 688)];
    expect(normalizeItems(items).text).toBe("body text\narXiv\nmore");
  });

  it("居中标题的第二行更宽时仍是普通换行", () => {
    const items = [item("A Survey of Long Short-Term", 230, 700, { size: 17 }), item("Memory for Trajectory Prediction", 160, 680, { size: 17 })];
    expect(normalizeItems(items).text).toBe("A Survey of Long Short-Term Memory for Trajectory Prediction");
  });
});

describe("normalizeItems：中文", () => {
  it("中文换行直接相连，中英文之间换行补空格", () => {
    const items = column(["基于深度学习的轨迹", "预测方法，使用", "LSTM 模型"], 50, 700);
    expect(normalizeItems(items).text).toBe("基于深度学习的轨迹预测方法，使用 LSTM 模型");
  });

  it("中文标点在行尾也直接相连", () => {
    expect(normalizeItems(column(["模型，", "我们"], 50, 700)).text).toBe("模型，我们");
  });
});

describe("mapRangeToItems", () => {
  const items = [
    item("The eﬃcient trans-", 0, 700, { eol: true }),
    eolItem(),
    item("former", 0, 688),
    item("model", 35, 688),
    item("works", 63, 688, { eol: true }),
  ];
  const nt = normalizeItems(items);

  it("往返：每个词映射回片段后与原文一致", () => {
    expect(nt.text).toBe("The efficient transformer model works");
    expect(sliceItems(items, nt, 4, 13)).toBe("eﬃcient");
    const t = nt.text.indexOf("transformer");
    expect(sliceItems(items, nt, t, t + 11)).toBe("trans-||former");
    const m = nt.text.indexOf("model");
    expect(sliceItems(items, nt, m, m + 5)).toBe("model");
    expect(sliceItems(items, nt, m, nt.text.length)).toBe("model|works");
  });

  it("跳过两端的合成空格", () => {
    const m = nt.text.indexOf("model");
    // [m-1, m+6) 前后都是合成空格
    expect(nt.itemIndex[m - 1]).toBe(-1);
    expect(nt.itemIndex[m + 5]).toBe(-1);
    expect(mapRangeToItems(nt, m - 1, m + 6)).toEqual({ startItem: 3, startOffset: 0, endItem: 3, endOffset: 5 });
    expect(mapRangeToItems(nt, m - 1, m)).toBeNull();
    expect(mapRangeToItems(nt, 5, 5)).toBeNull();
  });

  it("越界区间被截断", () => {
    expect(mapRangeToItems(nt, -5, 3)).toEqual({ startItem: 0, startOffset: 0, endItem: 0, endOffset: 3 });
    expect(mapRangeToItems(nt, nt.text.length - 2, nt.text.length + 10)).toEqual({
      startItem: 4,
      startOffset: 3,
      endItem: 4,
      endOffset: 5,
    });
  });

  it("不拆开代理对", () => {
    const its = [item("a𝑥b", 0, 700)];
    const n2 = normalizeItems(its);
    expect(mapRangeToItems(n2, 1, 2)).toEqual({ startItem: 0, startOffset: 1, endItem: 0, endOffset: 3 });
    expect(mapRangeToItems(n2, 2, 3)).toEqual({ startItem: 0, startOffset: 1, endItem: 0, endOffset: 3 });
  });
});

describe("1:1 兼容映射", () => {
  it("全角字母数字与少数符号 → ASCII，全角标点保持原样", () => {
    const nt = normalizeItems([item("基于ＬＳＴＭ（Ｌｏｎｇ）：准确率９５％，ＲＭＳＥ＝１．２", 0, 700)]);
    expect(nt.text).toBe("基于LSTM（Long）：准确率95%，RMSE=1．2");
    expectAligned(nt);
    // 1:1：单个片段、没有空白压缩时偏移与下标一致
    expect(Array.from(nt.charOffset)).toEqual(Array.from({ length: nt.text.length }, (_, i) => i));
  });

  it("µ、上下标数字、希腊字母变体、字母类数学符号、弯单引号", () => {
    const raw = "5\u00B5m L\u00B2 x\u2081 \u2113\u2081 \u211D \u03F5-greedy \u03D5 Newton\u2019s \u212Bngstr\u00F6m";
    expect(normalizeItems([item(raw, 0, 700)]).text).toBe("5\u03BCm L2 x1 l1 R \u03B5-greedy \u03C6 Newton's \u00C5ngstr\u00F6m");
    expect(normalizeString(raw)).toBe("5\u03BCm L2 x1 l1 R \u03B5-greedy \u03C6 Newton's \u00C5ngstr\u00F6m");
  });

  it("双引号、中文标点、表意空格", () => {
    expect(normalizeItems([item("\u201C终端\u201D，。：；！？\u3000空域", 0, 700)]).text).toBe("\u201C终端\u201D，。：；！？ 空域");
  });

  it("normalizeString 与 normalizeItems 一致（含换行时也先做字符替换）", () => {
    expect(normalizeString("使用\nＬＳＴＭ")).toBe("使用 LSTM");
    expect(normalizeItems(column(["使用", "ＬＳＴＭ"], 50, 700)).text).toBe("使用 LSTM");
    expect(normalizeString("ＢＩ-\nＬＳＴＭ")).toBe("BI-LSTM");
    expect(normalizeItems(column(["ＢＩ-", "ＬＳＴＭ"], 50, 700)).text).toBe("BI-LSTM");
  });
});

describe("normalizeString", () => {
  it("与页面文本一致的字符规范化", () => {
    expect(normalizeString("  eﬃcient  ﬁne-tuning​ ")).toBe("efficient fine-tuning");
    expect(normalizeString("non‑linear  soft­max")).toBe("non-linear softmax");
    expect(normalizeString("")).toBe("");
    expect(normalizeString(" \n\t ")).toBe("");
  });

  it("含真实换行时按页面规则处理行尾连字符和中文换行", () => {
    expect(normalizeString("the trans-\nformer")).toBe("the transformer");
    expect(normalizeString("a Bi-\nLSTM")).toBe("a Bi-LSTM");
    expect(normalizeString("轨迹\n预测")).toBe("轨迹预测");
    expect(normalizeString("results -\nwhich")).toBe("results - which");
  });

  it("与 normalizeItems 的结果一致", () => {
    const raw = "Long Short‑Term  Memory eﬃcient";
    expect(normalizeItems([item(raw, 0, 700)]).text).toBe(normalizeString(raw));
  });
});

describe("fromNormalizedText", () => {
  it("保留硬边界，小写副本对齐", () => {
    const nt = fromNormalizedText("Long\nMemory ATM");
    expect(nt.text).toBe("Long\nMemory ATM");
    expect(nt.lower).toBe("long\nmemory atm");
    expect(mapRangeToItems(nt, 5, 11)).toEqual({ startItem: 0, startOffset: 5, endItem: 0, endOffset: 11 });
  });
});
