import { afterEach, describe, expect, it } from "vitest";
import { setLocaleForTest } from "@/i18n";
import { assignFileNames, buildCombinedMarkdown, buildMarkdownFiles, safeFileName, type MarkdownInput } from "@/services/storage/markdown";
import type { Annotation, Domain, Paper, Term } from "@/types/models";

const domains: Domain[] = [
  { id: "d1", name: "ATM", parentId: null, color: "#000", order: 0 },
  { id: "d2", name: "轨迹 预测", parentId: "d1", color: "#000", order: 0 },
];
const papers: Paper[] = [
  { id: "p1", fileHash: "h1", title: "LSTM: A Search Space Odyssey", authors: ["Klaus Greff", "Rupesh Srivastava"], year: 2017, domainIds: ["d2"], pageCount: 12, addedAt: 1 },
  { id: "p2", fileHash: "h2", title: "lstm: a search space odyssey", authors: [], domainIds: [], pageCount: 3, addedAt: 2 },
];
const terms: Term[] = [
  {
    id: "t1",
    name: "Long Short-Term Memory",
    aliases: ["LSTM", "LSTMs"],
    matchMode: "auto",
    scope: { kind: "domains", domainIds: ["d2"] },
    note: "一种 **循环** 神经网络。",
    createdAt: Date.UTC(2026, 9, 20),
    updatedAt: Date.UTC(2026, 9, 21),
  },
  { id: "t2", name: "C++/CLI?", aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 2, updatedAt: 2 },
];
const ann = (id: string, page: number, y: number, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  paperId: "p1",
  page,
  rects: [[0, y - 10, 100, y]],
  quote: { exact: `quote ${id} with *stars* and $x$`, prefix: "", suffix: "" },
  fileHash: "h1",
  color: "#fde68a",
  note: "",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const annotations = [ann("a2", 3, 500), ann("a1", 3, 700, { note: "我的笔记", termId: "t1" }), ann("a3", 1, 100)];

const input: MarkdownInput = {
  tables: { domains, papers, annotations, terms },
  occurrences: [
    { termId: "t1", paperId: "p1", pages: [1, 3, 5], count: 12 },
    { termId: "t1", paperId: "p2", pages: [2], count: 3 },
    { termId: "t1", paperId: "gone", pages: [2], count: 9 },
  ],
};

describe("文件名", () => {
  it("去掉非法字符、限制长度", () => {
    expect(safeFileName("LSTM: A Search Space Odyssey")).toBe("LSTM A Search Space Odyssey");
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe("a b c d e f g h i j k l m n");
    expect(safeFileName("...hidden.")).toBe("hidden");
    expect(safeFileName("  ")).toBe("untitled");
    expect(safeFileName("CON")).toBe("CON_");
    expect(safeFileName("tab\there\u0000")).toBe("tab here");
    const long = safeFileName("长".repeat(200));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(150);
    expect(long).toBe("长".repeat(50));
    // 不会截断在代理对中间
    expect(safeFileName("😀".repeat(100), 10)).toBe("😀😀");
  });

  it("重名（不区分大小写）时加序号", () => {
    const items = ["Attention", "attention", "Attention", "Other"].map((title) => ({ title }));
    const names = assignFileNames(items, (x) => x.title);
    expect(items.map((x) => names.get(x))).toEqual(["Attention", "attention (2)", "Attention (3)", "Other"]);
  });
});

describe("Markdown 文件", () => {
  const files = buildMarkdownFiles(input);
  const byName = new Map(files.map((f) => [f.name, f.content]));

  it("每个术语、每篇论文一个文件，重名论文区分开", () => {
    expect([...byName.keys()].sort()).toEqual([
      "README.md",
      "papers/LSTM A Search Space Odyssey.md",
      "papers/lstm a search space odyssey (2).md",
      "terms/C++ CLI.md",
      "terms/Long Short-Term Memory.md",
    ]);
  });

  it("术语：frontmatter 有 aliases、scope、domains、tags；正文有笔记和出现于", () => {
    const md = byName.get("terms/Long Short-Term Memory.md")!;
    expect(md).toMatch(/^---\naliases:\n {2}- "LSTM"\n {2}- "LSTMs"\nscope: domains\ndomains:\n {2}- "ATM\/轨迹 预测"\ntags:\n {2}- "paperlens\/term"\n {2}- "ATM\/轨迹-预测"\n/);
    expect(md).toContain("# Long Short-Term Memory");
    expect(md).toContain("一种 **循环** 神经网络。");
    expect(md).toContain("## 出现于");
    expect(md).toContain("- [[papers/LSTM A Search Space Odyssey|LSTM: A Search Space Odyssey]] · 12 次（第 1、3、5 页）");
    expect(md).toContain("- [[papers/lstm a search space odyssey (2)|lstm: a search space odyssey]] · 3 次（第 2 页）");
    expect(md).not.toContain("gone");
    // 文件名被改过的术语把原名放进 aliases
    expect(byName.get("terms/C++ CLI.md")).toContain('aliases:\n  - "C++/CLI?"');
  });

  it("论文：元数据 + 按页码和位置排列的批注", () => {
    const md = byName.get("papers/LSTM A Search Space Odyssey.md")!;
    expect(md).toContain('title: "LSTM: A Search Space Odyssey"');
    expect(md).toContain('authors:\n  - "Klaus Greff"');
    expect(md).toContain("year: 2017");
    expect(md).toContain("## 批注（3）");
    const i1 = md.indexOf("### 第 1 页");
    const i3 = md.indexOf("### 第 3 页");
    const qa1 = md.indexOf("quote a1");
    const qa2 = md.indexOf("quote a2");
    expect(i1).toBeGreaterThan(0);
    expect(i1).toBeLessThan(i3);
    expect(qa1).toBeGreaterThan(i3);
    expect(qa1).toBeLessThan(qa2); // 同一页里靠上的在前
    expect(md).toContain("> quote a1 with \\*stars\\* and \\$x\\$");
    expect(md).toContain("我的笔记");
    expect(md).toContain("术语：[[terms/Long Short-Term Memory|Long Short-Term Memory]]");
  });

  it("没有服务时合并成一个文件", () => {
    const md = buildCombinedMarkdown(input, Date.UTC(2026, 9, 21));
    expect(md).toContain("## 术语");
    expect(md).toContain("### Long Short-Term Memory");
    expect(md).toContain("出现于：LSTM: A Search Space Odyssey（12 次）");
    expect(md).toContain("## 论文与批注");
    expect(md).toContain("术语：**Long Short-Term Memory**");
  });
});

describe("英文界面：生成的 Markdown 跟随界面语言，文件名不变", () => {
  afterEach(() => setLocaleForTest("zh"));

  it("标题、说明、README 是英文；文件名和 frontmatter 与中文相同", () => {
    const zhNames = buildMarkdownFiles(input).map((f) => f.name);
    setLocaleForTest("en");
    const files = buildMarkdownFiles(input);
    expect(files.map((f) => f.name)).toEqual(zhNames);
    const byName = new Map(files.map((f) => [f.name, f.content]));
    const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
    const userData = ["轨迹 预测", "轨迹-预测", "一种 **循环** 神经网络。", "我的笔记"];
    expect(byName.get("README.md")).toContain("# Paperloom notes");
    expect(byName.get("README.md")).toContain("Obsidian vault");

    const term = byName.get("terms/Long Short-Term Memory.md")!;
    expect(term).toContain("Aliases: LSTM, LSTMs");
    expect(term).toContain("Scope: ATM / 轨迹 预测");
    expect(term).toContain("## Appears in");
    expect(term).toContain("- [[papers/LSTM A Search Space Odyssey|LSTM: A Search Space Odyssey]] · 12 times (pp. 1, 3, 5)");
    expect(term).toContain("· 3 times (p. 2)");
    expect(byName.get("terms/C++ CLI.md")).toContain("_(No notes yet)_");

    const paper = byName.get("papers/LSTM A Search Space Odyssey.md")!;
    expect(paper).toContain("- Authors: Klaus Greff; Rupesh Srivastava");
    expect(paper).toContain("- Year: 2017");
    expect(paper).toContain("- Pages: 12");
    expect(paper).toContain("## Annotations (3)");
    expect(paper).toContain("### Page 1");
    expect(paper).toContain("Term: [[terms/Long Short-Term Memory|Long Short-Term Memory]]");
    expect(byName.get("papers/lstm a search space odyssey (2).md")).toContain("_(No annotations yet)_");
    // 除了用户数据（领域名、笔记），没有中文
    for (const [name, content] of byName) expect(CJK.test(userData.reduce((c, u) => c.split(u).join(""), content)), name).toBe(false);
  });

  it("合并文件与后备文件名", () => {
    setLocaleForTest("en");
    const md = buildCombinedMarkdown(input, Date.UTC(2026, 9, 21, 12));
    expect(md).toContain("# Paperloom export");
    expect(md).toContain("2 terms, 2 papers.");
    expect(md).toContain("## Terms");
    expect(md).toContain("Appears in: LSTM: A Search Space Odyssey (12 times); lstm: a search space odyssey (3 times)");
    expect(md).toContain("## Papers & annotations");
    expect(md).toContain("#### Page 3");
    expect(md).toContain("Term: **Long Short-Term Memory**");
    expect(safeFileName("  ")).toBe("untitled");
  });
});
