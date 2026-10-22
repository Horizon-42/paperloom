import { describe, expect, it } from "vitest";
import { fromNormalizedText, normalizeItems } from "@/engine/normalize";
import { TermMatcher, isAcronymLike, isTermInScope, surfaceForms } from "@/engine/matcher";
import type { ScopeContext, TermLike, TermMatch } from "@/engine/types";
import { column, item, term } from "./helpers";

/** 命中的文字与术语 id，便于断言 */
function hits(matches: TermMatch[], text: string): [string, string[]][] {
  return matches.map((m) => [text.slice(m.start, m.end), m.termIds]);
}

function matchText(terms: TermLike[], text: string, scope?: ScopeContext) {
  return hits(new TermMatcher(terms).match(fromNormalizedText(text), scope), text);
}

describe("surfaceForms", () => {
  it("名称、别名、复数、连字符变体；auto 模式下缩写区分大小写", () => {
    const forms = surfaceForms(term("t1", "Long Short-Term Memory", ["LSTM"]));
    expect(forms).toEqual([
      { form: "Long Short-Term Memory", caseSensitive: false },
      { form: "Long Short-Term Memories", caseSensitive: false },
      { form: "Long Short Term Memory", caseSensitive: false },
      { form: "Long Short Term Memories", caseSensitive: false },
      { form: "Long ShortTerm Memory", caseSensitive: false },
      { form: "Long ShortTerm Memories", caseSensitive: false },
      { form: "Long-Short-Term-Memory", caseSensitive: false },
      { form: "Long-Short-Term-Memories", caseSensitive: false },
      { form: "LSTM", caseSensitive: true },
      { form: "LSTMs", caseSensitive: true },
    ]);
  });

  it("复数规则", () => {
    const plural = (name: string) => surfaceForms(term("t", name)).map((f) => f.form);
    expect(plural("transformer")).toEqual(["transformer", "transformers"]);
    expect(plural("softmax")).toEqual(["softmax", "softmaxes"]);
    expect(plural("patch")).toEqual(["patch", "patches"]);
    expect(plural("loss")).toEqual(["loss", "losses"]);
    expect(plural("policy")).toEqual(["policy", "policies"]);
    expect(plural("ATM")).toEqual(["ATM", "ATMs"]);
    expect(plural("LSTMs")).toEqual(["LSTMs"]);
    expect(plural("GPT")).toEqual(["GPT", "GPTs"]);
    expect(plural("ResNet50")).toEqual(["ResNet50"]); // 数字结尾不派生
    expect(plural("轨迹预测")).toEqual(["轨迹预测"]); // 中文不派生
    expect(plural("C++")).toEqual(["C++"]);
  });

  it("表面形式经过 normalizeString 并去重", () => {
    const forms = surfaceForms(term("t", " eﬃcient net ", ["efficient net", "Efficient Net"]));
    expect(forms.map((f) => f.form)).toEqual(["efficient net", "efficient nets", "efficient-net", "efficient-nets"]);
  });

  it("matchMode 覆盖 auto 判断", () => {
    const cs = surfaceForms(term("t", "Transformer", [], { matchMode: "caseSensitive" }));
    expect(cs.every((f) => f.caseSensitive)).toBe(true);
    const ci = surfaceForms(term("t", "ATM", [], { matchMode: "caseInsensitive" }));
    expect(ci.every((f) => !f.caseSensitive)).toBe(true);
  });

  it("isAcronymLike", () => {
    expect(isAcronymLike("ATM")).toBe(true);
    expect(isAcronymLike("4D-TP")).toBe(true);
    expect(isAcronymLike("LSTMs")).toBe(true);
    expect(isAcronymLike("Transformer")).toBe(false);
    expect(isAcronymLike("IoU")).toBe(false);
    expect(isAcronymLike("As")).toBe(false);
    expect(isAcronymLike("2024")).toBe(false);
  });

  it("同形的区分大小写形式被不区分大小写形式覆盖时去掉", () => {
    const forms = surfaceForms(term("t", "atm", ["ATM"]));
    expect(forms).toEqual([
      { form: "atm", caseSensitive: false },
      { form: "atms", caseSensitive: false },
    ]);
  });
});

describe("TermMatcher：大小写与词边界", () => {
  const atm = term("atm", "Automated Teller Machine", ["ATM"]);

  it("全大写缩写区分大小写：ATM 命中，atm 不命中", () => {
    expect(matchText([atm], "The ATM is near; an atm is not.")).toEqual([["ATM", ["atm"]]]);
  });

  it("caseInsensitive 模式两种都命中", () => {
    const t = { ...atm, matchMode: "caseInsensitive" as const };
    expect(matchText([t], "The ATM and the atm.").map((h) => h[0])).toEqual(["ATM", "atm"]);
  });

  it("caseSensitive 模式下普通单词也区分大小写", () => {
    const t = term("tr", "Transformer", [], { matchMode: "caseSensitive" });
    expect(matchText([t], "Transformer vs transformer").map((h) => h[0])).toEqual(["Transformer"]);
  });

  it("词边界：ATM 不命中 ATMOSPHERE、xATM、ATM2，命中 ATMs、ATM-based、(ATM)", () => {
    const text = "ATMOSPHERE xATM ATM2 ATMs ATM-based (ATM).";
    expect(matchText([atm], text).map((h) => h[0])).toEqual(["ATMs", "ATM", "ATM"]);
  });

  it("不区分大小写的普通词也检查边界", () => {
    const t = term("m", "memory");
    expect(matchText([t], "Memory memorylessness amemory memory.").map((h) => h[0])).toEqual(["Memory", "memory"]);
  });

  it("名称本身也能命中（不区分大小写），复数形式命中", () => {
    expect(matchText([atm], "automated teller machines are ATMs").map((h) => h[0])).toEqual([
      "automated teller machines",
      "ATMs",
    ]);
  });
});

describe("TermMatcher：重叠与变体", () => {
  const lstm = term("lstm", "Long Short-Term Memory", ["LSTM"]);
  const memory = term("mem", "Memory");

  it("嵌套术语：Long Short-Term Memory 不再拆出 Memory", () => {
    const text = "Long Short-Term Memory networks use memory cells.";
    expect(matchText([memory, lstm], text)).toEqual([
      ["Long Short-Term Memory", ["lstm"]],
      ["memory", ["mem"]],
    ]);
  });

  it("连字符变体：空格写法、直接相连、全连字符写法", () => {
    const text = "long short term memory; Long ShortTerm Memory; long-short-term-memory; LONG SHORT-TERM MEMORIES";
    expect(matchText([lstm], text).map((h) => h[0])).toEqual([
      "long short term memory",
      "Long ShortTerm Memory",
      "long-short-term-memory",
      "LONG SHORT-TERM MEMORIES",
    ]);
  });

  it("跨两行的多词术语（含行尾连字符）", () => {
    const items1 = column(["we use a Long Short-Term", "Memory network"], 50, 700);
    const nt1 = normalizeItems(items1);
    expect(hits(new TermMatcher([lstm]).match(nt1), nt1.text)).toEqual([["Long Short-Term Memory", ["lstm"]]]);

    const items2 = column(["we use a Long Short-", "Term Memory network"], 50, 700);
    const nt2 = normalizeItems(items2);
    expect(hits(new TermMatcher([lstm]).match(nt2), nt2.text)).toEqual([["Long Short-Term Memory", ["lstm"]]]);
  });

  it("跨栏硬边界不匹配多词术语", () => {
    const items = [
      ...column(["first column text", "ends with Long Short-Term"], 50, 700),
      ...column(["Memory networks are", "popular"], 320, 700),
    ];
    const nt = normalizeItems(items);
    expect(hits(new TermMatcher([lstm, memory]).match(nt), nt.text)).toEqual([["Memory", ["mem"]]]);
  });

  it("连字展开后的文本能命中术语", () => {
    const nt = normalizeItems([item("an eﬃcient ﬁlter", 0, 700)]);
    const m = new TermMatcher([term("e", "efficient filter")]).match(nt);
    expect(hits(m, nt.text)).toEqual([["efficient filter", ["e"]]]);
  });
});

describe("TermMatcher：兼容映射", () => {
  it("全角缩写、ϵ、µ、弯单引号都能命中按常规写法录入的术语", () => {
    const terms = [
      term("lstm", "LSTM"),
      term("eps", "\u03B5-greedy"),
      term("mu", "\u03BC-law"),
      term("newton", "Newton's method"),
    ];
    const nt = normalizeItems([item("基于ＬＳＴＭ的 \u03F5-greedy 与 \u00B5-law 以及 Newton\u2019s method", 0, 700)]);
    expect(hits(new TermMatcher(terms).match(nt), nt.text)).toEqual([
      ["LSTM", ["lstm"]],
      ["\u03B5-greedy", ["eps"]],
      ["\u03BC-law", ["mu"]],
      ["Newton's method", ["newton"]],
    ]);
  });

  it("用全角录入的术语也能命中半角正文", () => {
    expect(matchText([term("atm", "ＡＴＭ")], "an ATM here")).toEqual([["ATM", ["atm"]]]);
  });
});

describe("TermMatcher：中文", () => {
  const traj = term("traj", "轨迹预测", ["trajectory prediction"]);
  const lstm = term("lstm", "Long Short-Term Memory", ["LSTM"]);

  it("中文术语不需要空格边界；中英混排时缩写两侧的汉字不阻挡", () => {
    const text = "基于LSTM的轨迹预测方法优于传统轨迹预测。";
    expect(matchText([traj, lstm], text)).toEqual([
      ["LSTM", ["lstm"]],
      ["轨迹预测", ["traj"]],
      ["轨迹预测", ["traj"]],
    ]);
  });

  it("中文跨行的术语", () => {
    const nt = normalizeItems(column(["基于深度学习的轨迹", "预测方法"], 50, 700));
    expect(hits(new TermMatcher([traj]).match(nt), nt.text)).toEqual([["轨迹预测", ["traj"]]]);
  });
});

describe("作用范围", () => {
  // ml ← dl ← cv ；robotics 独立；loopA ↔ loopB 成环
  const domainParent = new Map<string, string | null>([
    ["ml", null],
    ["dl", "ml"],
    ["cv", "dl"],
    ["robotics", null],
    ["loopA", "loopB"],
    ["loopB", "loopA"],
  ]);
  const ctx = (paperDomainIds: string[]): ScopeContext => ({ paperDomainIds, domainParent });

  const global = term("g", "global");
  const inMl = term("m", "machine", [], { scope: { kind: "domains", domainIds: ["ml"] } });
  const inCv = term("c", "camera", [], { scope: { kind: "domains", domainIds: ["cv"] } });
  const nowhere = term("n", "nowhere", [], { scope: { kind: "domains", domainIds: [] } });

  it("全局术语总在范围内", () => {
    expect(isTermInScope(global, ctx([]))).toBe(true);
  });

  it("论文属于术语领域或其子孙领域时在范围内", () => {
    expect(isTermInScope(inMl, ctx(["ml"]))).toBe(true);
    expect(isTermInScope(inMl, ctx(["cv"]))).toBe(true); // 子领域继承
    expect(isTermInScope(inCv, ctx(["ml"]))).toBe(false); // 父领域看不到子领域的术语
    expect(isTermInScope(inMl, ctx(["robotics"]))).toBe(false);
    expect(isTermInScope(inMl, ctx(["robotics", "dl"]))).toBe(true);
    expect(isTermInScope(inMl, ctx([]))).toBe(false);
  });

  it("domainIds 为空表示不在任何地方生效", () => {
    expect(isTermInScope(nowhere, ctx(["ml", "cv"]))).toBe(false);
  });

  it("领域树有环时不死循环", () => {
    const t = term("l", "loop", [], { scope: { kind: "domains", domainIds: ["loopB"] } });
    expect(isTermInScope(t, ctx(["loopA"]))).toBe(true);
    expect(isTermInScope(inMl, ctx(["loopA"]))).toBe(false);
  });

  it("match 按作用范围过滤；不传 scope 不过滤", () => {
    const terms = [global, inMl, inCv, nowhere];
    const text = "global machine camera nowhere";
    expect(matchText(terms, text).map((h) => h[0])).toEqual(["global", "machine", "camera", "nowhere"]);
    expect(matchText(terms, text, ctx(["dl"])).map((h) => h[0])).toEqual(["global", "machine"]);
    expect(matchText(terms, text, ctx(["cv"])).map((h) => h[0])).toEqual(["global", "machine", "camera"]);
  });

  it("先过滤作用范围再做重叠消解：范围外的长术语不挡住范围内的短术语", () => {
    const long = term("long", "Long Short-Term Memory", [], { scope: { kind: "domains", domainIds: ["robotics"] } });
    const short = term("short", "Short-Term Memory");
    const text = "Long Short-Term Memory";
    expect(matchText([long, short], text, ctx(["ml"]))).toEqual([["Short-Term Memory", ["short"]]]);
    expect(matchText([long, short], text, ctx(["robotics"]))).toEqual([["Long Short-Term Memory", ["long"]]]);
  });
});

describe("多候选合并", () => {
  const domainParent = new Map<string, string | null>([
    ["finance", null],
    ["net", null],
  ]);
  const atmFin = term("fin", "Automated Teller Machine", ["ATM"], { scope: { kind: "domains", domainIds: ["finance"] } });
  const atmNet = term("net", "Asynchronous Transfer Mode", ["ATM"], { scope: { kind: "domains", domainIds: ["net"] } });
  const atmLower = term("low", "atm", [], { matchMode: "caseInsensitive" });

  it("不同术语命中相同区间时合并为一个 TermMatch，termIds 按术语顺序", () => {
    expect(matchText([atmNet, atmFin], "the ATM layer")).toEqual([["ATM", ["net", "fin"]]]);
    expect(matchText([atmFin, atmNet], "the ATM layer")).toEqual([["ATM", ["fin", "net"]]]);
  });

  it("区分与不区分大小写的自动机命中同一区间也合并", () => {
    expect(matchText([atmFin, atmLower], "ATM")).toEqual([["ATM", ["fin", "low"]]]);
  });

  it("作用范围过滤后只剩一个候选", () => {
    const scope = { paperDomainIds: ["net"], domainParent };
    expect(matchText([atmFin, atmNet], "the ATM layer", scope)).toEqual([["ATM", ["net"]]]);
  });
});

// ---------------------------------------------------------------------------
// 性能
// ---------------------------------------------------------------------------

function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function randomTerms(n: number): TermLike[] {
  const rnd = makeRng(7);
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const word = () =>
    Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => letters[Math.floor(rnd() * 26)]).join("");
  const terms: TermLike[] = [];
  for (let i = 0; i < n; i++) {
    const words = Array.from({ length: 1 + Math.floor(rnd() * 3) }, word);
    const name = words.join(rnd() < 0.3 ? "-" : " ");
    const acronym = words.map((w) => w[0].toUpperCase()).join("") + String.fromCharCode(65 + (i % 26)) + i;
    terms.push(term(`t${i}`, name, [acronym, words[0] + "-" + i]));
  }
  return terms;
}

describe("性能", () => {
  it("2000 个术语构建自动机", () => {
    const terms = randomTerms(2000);
    new TermMatcher(terms.slice(0, 50)); // 预热
    const runs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      new TermMatcher(terms);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    console.log(`[perf] 2000 terms build: median ${runs[2].toFixed(1)} ms, min ${runs[0].toFixed(1)} ms`);
    expect(runs[2]).toBeLessThan(250);
  });

  it("一页约 5000 字符、500 次命中", () => {
    const n = 500;
    const terms: TermLike[] = [];
    for (let i = 0; i < 104; i++) {
      const tag = String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26));
      terms.push(term(`a${i}`, `model ${tag.toLowerCase()}x`, [`Q${tag}`]));
    }
    const all = [...terms, ...randomTerms(1900)];
    const matcher = new TermMatcher(all);
    const parts: string[] = [];
    for (let k = 0; k < n; k++) {
      const tag = String.fromCharCode(65 + (k % 26)) + String.fromCharCode(65 + (Math.floor(k / 26) % 4));
      parts.push(k % 2 ? `Q${tag} is` : `the model ${tag.toLowerCase()}x`);
    }
    const text = parts.join(" ").slice(0, 6000);
    const nt = fromNormalizedText(text);
    const result = matcher.match(nt);
    expect(result.length).toBeGreaterThanOrEqual(480);
    for (let r = 0; r < 5; r++) matcher.match(nt); // 预热
    const R = 50;
    const t0 = performance.now();
    for (let r = 0; r < R; r++) matcher.match(nt);
    const avg = (performance.now() - t0) / R;
    console.log(`[perf] match ${text.length} chars, ${result.length} hits: avg ${avg.toFixed(3)} ms`);
    expect(avg).toBeLessThan(20);
  });

  it("normalizeItems：一页约 5000 字符", () => {
    const lines: string[] = [];
    for (let k = 0; k < 90; k++) lines.push(`line ${k} of the long short-term memory text with eﬃcient tokens`);
    const items = column(lines, 50, 780, 8);
    const nt = normalizeItems(items);
    expect(nt.text.length).toBeGreaterThan(5000);
    for (let r = 0; r < 5; r++) normalizeItems(items);
    const R = 50;
    const t0 = performance.now();
    for (let r = 0; r < R; r++) normalizeItems(items);
    const avg = (performance.now() - t0) / R;
    console.log(`[perf] normalizeItems ${nt.text.length} chars: avg ${avg.toFixed(3)} ms`);
    expect(avg).toBeLessThan(20);
  });
});
