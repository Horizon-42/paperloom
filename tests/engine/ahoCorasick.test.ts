import { describe, expect, it } from "vitest";
import { AhoCorasick } from "@/engine/ahoCorasick";

function collect(ac: AhoCorasick, text: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  ac.search(text, (p, end) => out.push([p, end - ac.lengths[p], end]));
  return out.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
}

function naive(patterns: string[], text: string): [number, number, number][] {
  const out: [number, number, number][] = [];
  patterns.forEach((p, k) => {
    if (!p) return;
    for (let i = text.indexOf(p); i >= 0; i = text.indexOf(p, i + 1)) out.push([k, i, i + p.length]);
  });
  return out.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
}

describe("AhoCorasick", () => {
  it("经典用例 he / she / his / hers", () => {
    const pats = ["he", "she", "his", "hers"];
    const ac = new AhoCorasick(pats);
    expect(collect(ac, "ushers")).toEqual([
      [1, 1, 4],
      [0, 2, 4],
      [3, 2, 6],
    ]);
  });

  it("中文、代理对与混合文字", () => {
    const pats = ["轨迹预测", "预测", "LSTM", "𝑥𝑦"];
    const ac = new AhoCorasick(pats);
    const text = "基于LSTM的轨迹预测与𝑥𝑦";
    expect(collect(ac, text)).toEqual(naive(pats, text));
    expect(collect(ac, text).map(([p]) => pats[p])).toEqual(["LSTM", "轨迹预测", "预测", "𝑥𝑦"]);
  });

  it("重复模式各自报告，空模式忽略", () => {
    const ac = new AhoCorasick(["ab", "", "ab", "b"]);
    expect(collect(ac, "xab")).toEqual([
      [0, 1, 3],
      [2, 1, 3],
      [3, 2, 3],
    ]);
    expect(collect(new AhoCorasick([]), "anything")).toEqual([]);
  });

  it("与朴素查找结果一致（随机用例）", () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = "abcAB 中文";
    const word = (len: number) => Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
    for (let round = 0; round < 20; round++) {
      const pats = Array.from({ length: 30 }, () => word(1 + Math.floor(rnd() * 4)));
      const text = word(300);
      expect(collect(new AhoCorasick(pats), text)).toEqual(naive(pats, text));
    }
  });
});
