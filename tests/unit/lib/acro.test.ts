import { describe, expect, it } from "vitest";
import { acroEntry, assignAcroIds, declareAcronym, glossaryToAcro, texEscape } from "@/lib/acro";
import type { Term } from "@/types/models";

let seq = 0;
function term(name: string, aliases: string[] = [], extra: Partial<Term> = {}): Term {
  seq++;
  return {
    id: `t${seq}`,
    name,
    aliases,
    matchMode: "auto",
    scope: { kind: "global" },
    note: "",
    createdAt: seq,
    updatedAt: seq,
    ...extra,
  } as Term;
}

describe("acroEntry", () => {
  it("规范名是全称、别名里有缩写", () => {
    expect(acroEntry(term("Long Short-Term Memory", ["LSTM", "LSTMs"]))).toEqual({
      short: "LSTM",
      long: "Long Short-Term Memory",
      foreign: undefined,
      noAbbrev: false,
    });
  });

  it("规范名本身是缩写：全称取别名", () => {
    expect(acroEntry(term("CNN", ["convolutional neural network", "CNNs"]))).toMatchObject({ short: "CNN", long: "convolutional neural network" });
  });

  it("大小写混合的缩写（BiLSTM）也算；优先全大写的", () => {
    expect(acroEntry(term("Bidirectional LSTM", ["BiLSTM"])).short).toBe("BiLSTM");
    expect(acroEntry(term("Residual Network", ["ResNet", "RN"])).short).toBe("RN");
  });

  it("只有复数形式时保留它", () => {
    expect(acroEntry(term("Graph Neural Networks", ["GNNs"])).short).toBe("GNNs");
  });

  it("中文全称 + 英文全称别名 → foreign", () => {
    expect(acroEntry(term("长短期记忆网络", ["LSTM", "Long Short-Term Memory"]))).toEqual({
      short: "LSTM",
      long: "长短期记忆网络",
      foreign: "Long Short-Term Memory",
      noAbbrev: false,
    });
  });

  it("英文全称 + 中文别名：不写 foreign", () => {
    expect(acroEntry(term("Long Short-Term Memory", ["LSTM", "长短期记忆网络"])).foreign).toBeUndefined();
  });

  it("没有缩写：short = long = 名称", () => {
    expect(acroEntry(term("self-attention", ["self attention"]))).toEqual({ short: "self-attention", long: "self-attention", noAbbrev: true });
    // 只有缩写、没有全称
    expect(acroEntry(term("BLEU"))).toEqual({ short: "BLEU", long: "BLEU", noAbbrev: true });
  });
});

describe("assignAcroIds", () => {
  it("小写 ASCII；重名按创建先后编号，并避开已有的自然 id", () => {
    const a = term("Positional Encoding", ["PE"]);
    const b = term("Policy Evaluation", ["PE"]);
    const c = term("PE-2", ["Something Else"]);
    const d = term("注意力机制");
    const e = term("自注意力");
    const ids = assignAcroIds([e, d, c, b, a]);
    expect(ids.get(a.id)).toBe("pe");
    expect(ids.get(c.id)).toBe("pe-2");
    expect(ids.get(b.id)).toBe("pe-3");
    expect(ids.get(d.id)).toBe("term");
    expect(ids.get(e.id)).toBe("term-2");
  });

  it("特殊字符和变音符号", () => {
    const x = term("Question & Answering", ["Q&A"]);
    const y = term("Generative Pre-trained Transformer 2", ["GPT-2"]);
    const z = term("Café Network", ["CaféN"]);
    const ids = assignAcroIds([x, y, z]);
    expect(ids.get(x.id)).toBe("q-a");
    expect(ids.get(y.id)).toBe("gpt-2");
    expect(ids.get(z.id)).toBe("cafen");
  });
});

describe("declareAcronym", () => {
  it("基本格式", () => {
    expect(declareAcronym(term("Long Short-Term Memory", ["LSTM"]), "lstm")).toBe(
      "\\DeclareAcronym{lstm}{\n  short = {LSTM} ,\n  long  = {Long Short-Term Memory} ,\n}",
    );
  });

  it("中文全称写 foreign 和不加 s 的复数", () => {
    const out = declareAcronym(term("长短期记忆网络", ["LSTM", "Long Short-Term Memory"]), "lstm");
    expect(out).toContain("foreign          = {Long Short-Term Memory} ,");
    expect(out).toContain("long-plural-form = {长短期记忆网络} ,");
    expect(out).not.toContain("short-plural-form");
  });

  it("没有缩写：首次出现也只写名称，带 tag", () => {
    const out = declareAcronym(term("self-attention"), "self-attention");
    expect(out).toContain("first-style = short ,");
    expect(out).toContain("tag         = noabbrev ,");
  });

  it("转义 LaTeX 特殊字符", () => {
    expect(texEscape("50% of R&D_x {a} #1 $5 ~ ^ \\")).toBe("50\\% of R\\&D\\_x \\{a\\} \\#1 \\$5 \\textasciitilde{} \\textasciicircum{} \\textbackslash{}");
    expect(texEscape("a\n  b")).toBe("a b");
    expect(declareAcronym(term("Q&A systems", ["Q&A"]), "q-a")).toContain("short = {Q\\&A} ,");
  });
});

describe("glossaryToAcro", () => {
  it("说明注释、按缩写字母序、笔记写成注释", () => {
    const a = term("Transformer", [], { note: "基于注意力\n\n见 Vaswani 2017" });
    const b = term("Long Short-Term Memory", ["LSTM"]);
    const c = term("Convolutional Neural Network", ["CNN"]);
    const out = glossaryToAcro([a, b, c], ["Header", "", "  usage"]);
    expect(out.startsWith("% Header\n%\n%   usage\n\n")).toBe(true);
    const order = ["{cnn}", "{lstm}", "{transformer}"].map((s) => out.indexOf(s));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(out).toContain("% 基于注意力\n%\n% 见 Vaswani 2017\n\\DeclareAcronym{transformer}{");
    expect(out.endsWith("}\n")).toBe(true);
  });

  it("只导出一部分时沿用全部术语分配的 id", () => {
    const a = term("Positional Encoding", ["PE"]);
    const b = term("Policy Evaluation", ["PE"]);
    const out = glossaryToAcro([b], [], assignAcroIds([a, b]));
    expect(out).toContain("\\DeclareAcronym{pe-2}{");
  });
});

describe("边界情况", () => {
  it("笔记里单独的 \\r 也拆成注释行", () => {
    const out = glossaryToAcro([term("Transformer", [], { note: "第一行\r第二行\r\n第三行" })], []);
    expect(out).toContain("% 第一行\n% 第二行\n% 第三行\n\\DeclareAcronym");
    expect(out).not.toContain("\r");
  });

  it("缩写只有复数形式时写明复数，\\acp 不会变成 GNNss", () => {
    expect(declareAcronym(term("Graph Neural Networks", ["GNNs"]), "gnns")).toContain("short-plural-form = {GNNs} ,");
    expect(declareAcronym(term("Long Short-Term Memory", ["LSTM", "LSTMs"]), "lstm")).not.toContain("plural");
  });
});
