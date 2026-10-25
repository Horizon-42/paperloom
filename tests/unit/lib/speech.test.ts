import { describe, expect, it } from "vitest";
import { detectLang, pickVoice, splitSentences, wordEnd, type VoiceLike } from "@/lib/speech";

const parts = (text: string) => splitSentences(text).map((s) => text.slice(s.start, s.end));

describe("splitSentences", () => {
  it("按句末标点分句，去掉两端空白；小数点和缩写里的点不切", () => {
    expect(parts("We propose RoPE. It encodes position 3.5 times better! Does it work?  Yes")).toEqual([
      "We propose RoPE.",
      "It encodes position 3.5 times better!",
      "Does it work?",
      "Yes",
    ]);
  });

  it("缩写和小节编号后的句点不断句", () => {
    expect(parts("1. Introduction We follow prior work, e.g. Su et al. 2021. See Fig. 3 for details. 3.2. Method Next.")).toEqual([
      "1. Introduction We follow prior work, e.g. Su et al. 2021.",
      "See Fig. 3 for details.",
      "3.2. Method Next.",
    ]);
    expect(parts("Published in 2017. Next one.")).toEqual(["Published in 2017.", "Next one."]);
  });

  it("中文句末标点", () => {
    expect(parts("我们提出了方法。效果很好！是吗？")).toEqual(["我们提出了方法。", "效果很好！", "是吗？"]);
  });

  it("太长的句子在逗号处再切，没有标点时按空白硬切，下标连续", () => {
    const long = Array.from({ length: 30 }, (_, i) => `clause number ${i} with words`).join(", ") + ".";
    const ss = splitSentences(long);
    expect(ss.length).toBeGreaterThan(1);
    expect(ss.every((s) => s.end - s.start <= 220)).toBe(true);
    expect(long.slice(ss[0].start, ss[ss.length - 1].end)).toBe(long);
    const noPunct = "word ".repeat(120).trim();
    expect(splitSentences(noPunct).every((s) => s.end - s.start <= 220)).toBe(true);
  });

  it("空白文字没有句子", () => {
    expect(splitSentences("   \n ")).toEqual([]);
  });
});

describe("detectLang", () => {
  it.each([
    ["Attention is all you need", "en"],
    ["注意力机制是 Transformer 的核心", "zh"],
    ["We use the 长短期记忆 network for trajectory prediction tasks in this paper", "en"],
    ["12345", "en"],
  ])("%s → %s", (text, lang) => expect(detectLang(text)).toBe(lang));
});

describe("pickVoice", () => {
  const v = (name: string, lang: string, localService = true, def = false): VoiceLike => ({ name, lang, localService, default: def });
  const voices = [v("Google US English", "en-US", false, true), v("Samantha", "en-US"), v("Ava (Enhanced)", "en-US"), v("Tingting", "zh-CN"), v("Meijia", "zh-TW"), v("Daniel", "en-GB")];

  it("语言匹配、本机、增强音质优先", () => {
    expect(pickVoice(voices, "en")?.name).toBe("Ava (Enhanced)");
    expect(pickVoice(voices, "zh")?.name).toBe("Tingting");
  });
  it("指定的语音语言对得上时用它", () => {
    expect(pickVoice(voices, "en", "Daniel")?.name).toBe("Daniel");
    expect(pickVoice(voices, "zh", "Daniel")?.name).toBe("Tingting");
  });
  it("没有该语言的语音时返回 null", () => {
    expect(pickVoice([v("Samantha", "en-US")], "zh")).toBeNull();
    expect(pickVoice([], "en")).toBeNull();
  });
});

describe("wordEnd", () => {
  it("一个词（含撇号、连字符）或一个字符", () => {
    expect(wordEnd("the self-attention layer", 4)).toBe(18);
    expect(wordEnd("it's fine", 0)).toBe(4);
    expect(wordEnd("注意力", 0)).toBe(3);
    expect(wordEnd("(x)", 0)).toBe(1);
  });
});
