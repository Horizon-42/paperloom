import { describe, expect, it } from "vitest";
import { findQuote, makeQuote } from "@/engine/anchor";

const PAGE1 =
  "Recurrent networks have long been used for sequence modelling. " +
  "In this work we propose a transformer encoder for trajectory prediction. " +
  "The transformer encoder attends to all past positions at once.";
const PAGE2 =
  "Ablation. Removing the transformer encoder hurts accuracy by four points, " +
  "while removing the decoder only costs one point.";

describe("makeQuote", () => {
  it("exact 加前后各 32 个字符", () => {
    const s = PAGE1.indexOf("transformer encoder for");
    const q = makeQuote(PAGE1, s, s + "transformer encoder".length);
    expect(q.exact).toBe("transformer encoder");
    expect(q.prefix).toBe(PAGE1.slice(s - 32, s));
    expect(q.prefix.length).toBe(32);
    expect(q.suffix).toBe(PAGE1.slice(s + 19, s + 19 + 32));
  });

  it("页首页尾截断，参数越界被截断", () => {
    const q = makeQuote("short text here", 0, 5);
    expect(q).toEqual({ exact: "short", prefix: "", suffix: " text here" });
    expect(makeQuote("abc", -3, 10)).toEqual({ exact: "abc", prefix: "", suffix: "" });
  });

  it("不拆开代理对", () => {
    const text = "𝑥".repeat(40) + "AB" + "𝑦".repeat(40);
    const q = makeQuote(text, 80, 82);
    expect(q.exact).toBe("AB");
    expect(q.prefix).toBe("𝑥".repeat(16));
    expect(q.suffix).toBe("𝑦".repeat(16));
  });
});

describe("findQuote", () => {
  const pages = [
    { page: 1, text: PAGE1 },
    { page: 2, text: PAGE2 },
  ];

  it("唯一精确命中，上下文一致时得分为 1", () => {
    const s = PAGE2.indexOf("decoder");
    const q = makeQuote(PAGE2, s, s + 7);
    expect(findQuote(pages, q)).toEqual({ page: 2, start: s, end: s + 7, score: 1 });
  });

  it("多处命中时用 prefix/suffix 选最优", () => {
    // "transformer encoder" 在第 1 页出现两次、第 2 页一次；选第 1 页的第二处
    const s = PAGE1.lastIndexOf("transformer encoder");
    const q = makeQuote(PAGE1, s, s + 19);
    const r = findQuote(pages, q);
    expect(r).toMatchObject({ page: 1, start: s, end: s + 19 });
    expect(r!.score).toBe(1);

    const s2 = PAGE2.indexOf("transformer encoder");
    expect(findQuote(pages, makeQuote(PAGE2, s2, s2 + 19))).toMatchObject({ page: 2, start: s2 });
  });

  it("上下文相似度相同时参考 hint.page，否则取最靠前的", () => {
    const text = "alpha beta gamma";
    const twin = [
      { page: 1, text },
      { page: 2, text },
      { page: 3, text },
    ];
    const q = { exact: "beta", prefix: "alpha ", suffix: " gamma" };
    expect(findQuote(twin, q)).toMatchObject({ page: 1, start: 6, end: 10 });
    expect(findQuote(twin, q, { page: 3 })).toMatchObject({ page: 3, start: 6, end: 10 });
    expect(findQuote(twin, q, { page: 9 })).toMatchObject({ page: 3 });
  });

  it("新版本里上下文略有改动时仍选最像的一处", () => {
    const v2 = [
      { page: 1, text: "We use the LSTM baseline here. Later the LSTM model is trained with dropout." },
    ];
    const q = { exact: "LSTM", prefix: "Later, the ", suffix: " model was trained with dropout" };
    const r = findQuote(v2, q);
    expect(r).toMatchObject({ page: 1, start: v2[0].text.lastIndexOf("LSTM") });
    expect(r!.score).toBeGreaterThan(0.75);
    expect(r!.score).toBeLessThan(1);
  });

  it("容忍空白、换行和连字符差异", () => {
    const v2 = [
      { page: 1, text: "intro" },
      { page: 2, text: "we propose a trans-former\nencoder for trajectory pre- diction tasks" },
    ];
    const q = { exact: "transformer encoder for trajectory prediction", prefix: "we propose a ", suffix: " tasks" };
    const r = findQuote(v2, q);
    expect(r).not.toBeNull();
    expect(r!.page).toBe(2);
    expect(v2[1].text.slice(r!.start, r!.end)).toBe("trans-former\nencoder for trajectory pre- diction");
    expect(r!.score).toBeCloseTo(0.9, 5);
  });

  it("连字未展开的旧文本也能定位", () => {
    const v2 = [{ page: 4, text: "an eﬃcient method" }];
    const r = findQuote(v2, { exact: "efficient", prefix: "an ", suffix: " method" });
    expect(r).toMatchObject({ page: 4, start: 3, end: 4 + "cient".length + 1 });
  });

  it("exact 本身有小改动时靠前后文定位", () => {
    const old = "Section 3. In this paper we propose a novel transformer encodr for trajectory forecasting on highways.";
    const s = old.indexOf("novel transformer encodr");
    const q = makeQuote(old, s, s + "novel transformer encodr".length);
    const v2 = [{ page: 1, text: old.replace("encodr", "encoder") }];
    const r = findQuote(v2, q);
    expect(r).not.toBeNull();
    expect(v2[0].text.slice(r!.start, r!.end)).toBe("novel transformer encoder");
    expect(r!.score).toBeLessThan(0.5);
  });

  it("连字与全角字符差异也能宽松定位", () => {
    const v2 = [{ page: 1, text: "we use ＬＳＴＭ model" }];
    const r = findQuote(v2, { exact: "LSTM model", prefix: "we use ", suffix: "" });
    expect(r).toMatchObject({ page: 1, start: 7, end: 17 });
  });

  it("找不到时返回 null", () => {
    expect(findQuote(pages, { exact: "graph neural network", prefix: "", suffix: "" })).toBeNull();
    expect(findQuote(pages, { exact: "", prefix: "a", suffix: "b" })).toBeNull();
    expect(findQuote(pages, { exact: "  \n ", prefix: "", suffix: "" })).toBeNull();
    expect(findQuote([], { exact: "x", prefix: "", suffix: "" })).toBeNull();
    // 前后文还在但中间内容完全不同
    const q = { exact: "completely different words", prefix: "In this work we propose a ", suffix: " for trajectory prediction. " };
    expect(findQuote(pages, q)).toBeNull();
  });
});

describe("findQuote：hint.page 加分", () => {
  const header = "Running Header Text | Proceedings of Things 2026 | Under review";
  const body = (k: number) => ` body text number ${k} with some words.`;
  const v1 = [1, 2, 3, 4].map((k) => ({ page: k, text: header + body(k) }));
  // 引用第 3 页的页眉
  const q = makeQuote(v1[2].text, 0, "Running Header Text".length);

  it("页眉在各页精确重复、上下文相同：选 hint 页", () => {
    expect(findQuote(v1, q)).toMatchObject({ page: 1, start: 0 });
    expect(findQuote(v1, q, { page: 3 })).toMatchObject({ page: 3, start: 0, score: 1 });
  });

  it("hint 页的原位置只能宽松命中时，仍胜过相邻页的精确重复", () => {
    const v2 = v1.map((p) => (p.page === 3 ? { page: 3, text: p.text.replace("Header Text", "Header\nText") } : p));
    expect(findQuote(v2, q)).toMatchObject({ page: 1 }); // 无 hint：精确命中优先
    const r = findQuote(v2, q, { page: 3 });
    expect(r).toMatchObject({ page: 3, start: 0, end: "Running Header\nText".length });
    expect(r!.score).toBeCloseTo(0.9, 5); // 返回的是不含加分的基础分
  });

  const passage = "We train the bidirectional LSTM model with dropout on the data.";
  const s0 = passage.indexOf("LSTM");
  const qp = makeQuote(passage, s0, s0 + 4);

  it("别处有明显更好的命中时不被 hint 页拉走", () => {
    const pages = [
      { page: 2, text: "Completely unrelated words before the LSTM and other stuff after it." },
      { page: 3, text: passage },
    ];
    expect(findQuote(pages, qp, { page: 2 })).toMatchObject({ page: 3, start: s0, score: 1 });
  });

  it("差别很小时 hint 页胜出", () => {
    const pages = [
      { page: 2, text: "We train the bidirectional LSTM model with dropout on the set." },
      { page: 6, text: passage },
    ];
    expect(findQuote(pages, qp)).toMatchObject({ page: 6 });
    const r = findQuote(pages, qp, { page: 2 });
    expect(r).toMatchObject({ page: 2, start: s0 });
    expect(r!.score).toBeLessThan(1);
  });

  it("加分随页距衰减：原文挪到相邻页时选相邻页而不是远处的重复", () => {
    const pages = [
      { page: 2, text: "Some other content now sits on this page." },
      { page: 3, text: passage },
      { page: 7, text: passage },
    ];
    expect(findQuote(pages, qp, { page: 2 })).toMatchObject({ page: 3 });
    expect(findQuote(pages, qp, { page: 9 })).toMatchObject({ page: 7 });
  });
});
