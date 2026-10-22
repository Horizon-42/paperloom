import { describe, expect, it } from "vitest";
import {
  aggregateOccurrences,
  aliasExcerpt,
  countByFilter,
  filterTerms,
  formatPages,
  formatShortDate,
  groupOccurrencesByDomain,
  makeFilterContext,
  noteSnippet,
  scopeSummary,
  sortTerms,
  statsFromRecord,
  termMatchesQuery,
  tokenize,
} from "@/components/term/glossary/model";
import type { Occurrence } from "@/types/models";
import { mkDomain, mkPaper, mkTerm } from "../indexer/fixtures";

const domains = [mkDomain("atm", null, "ATM"), mkDomain("traj", "atm", "轨迹预测"), mkDomain("nlp", null, "NLP")];
const terms = [
  mkTerm("t-lstm", "Long Short-Term Memory", ["LSTM", "LSTMs"], { note: "门控循环网络", updatedAt: 30 }),
  mkTerm("t-atm", "air traffic management", ["ATM"], { domains: ["atm"], updatedAt: 10 }),
  mkTerm("t-ade", "average displacement error", ["ADE"], { domains: ["traj"], note: "轨迹预测的常用指标", updatedAt: 20 }),
  mkTerm("t-bert", "BERT", [], { domains: ["nlp"], updatedAt: 40 }),
  mkTerm("t-dead", "orphan term", [], { domains: ["deleted-domain"], updatedAt: 5 }),
  mkTerm("t-empty", "empty scope", [], { domains: [], updatedAt: 6 }),
];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("搜索", () => {
  it("名称、别名、笔记都能命中，多个关键词须全部命中，不区分大小写", () => {
    const t = terms[0];
    expect(termMatchesQuery(t, tokenize("long memory"))).toBe(true);
    expect(termMatchesQuery(t, tokenize("lstms"))).toBe(true);
    expect(termMatchesQuery(t, tokenize("门控"))).toBe(true);
    expect(termMatchesQuery(t, tokenize("long transformer"))).toBe(false);
    expect(termMatchesQuery(t, [])).toBe(true);
  });
});

describe("筛选", () => {
  const ctx = makeFilterContext(domains);
  it("全部 / 全局 / 无作用范围", () => {
    expect(ids(filterTerms(terms, { kind: "all" }, [], ctx))).toHaveLength(terms.length);
    expect(ids(filterTerms(terms, { kind: "global" }, [], ctx))).toEqual(["t-lstm"]);
    expect(ids(filterTerms(terms, { kind: "unscoped" }, [], ctx))).toEqual(["t-dead", "t-empty"]);
  });

  it("领域筛选包含子领域的术语", () => {
    expect(ids(filterTerms(terms, { kind: "domain", id: "atm" }, [], ctx))).toEqual(["t-atm", "t-ade"]);
    expect(ids(filterTerms(terms, { kind: "domain", id: "traj" }, [], ctx))).toEqual(["t-ade"]);
    expect(ids(filterTerms(terms, { kind: "domain", id: "nlp" }, [], ctx))).toEqual(["t-bert"]);
  });

  it("筛选与搜索叠加", () => {
    expect(ids(filterTerms(terms, { kind: "domain", id: "atm" }, tokenize("指标"), ctx))).toEqual(["t-ade"]);
  });

  it("各筛选项的计数", () => {
    const c = countByFilter(terms, domains);
    expect(c).toMatchObject({ all: 6, global: 1, unscoped: 2 });
    expect(c.byDomain.get("atm")).toBe(2);
    expect(c.byDomain.get("traj")).toBe(1);
    expect(c.byDomain.get("nlp")).toBe(1);
  });
});

describe("排序", () => {
  const stats = aggregateOccurrences([
    { termId: "t-atm", paperId: "p1", count: 5 },
    { termId: "t-atm", paperId: "p2", count: 7 },
    { termId: "t-lstm", paperId: "p1", count: 12 },
    { termId: "t-bert", paperId: "p1", count: 1 },
  ]);

  it("aggregateOccurrences：论文数与总次数", () => {
    expect(stats.get("t-atm")).toEqual({ papers: 2, count: 12 });
    expect(stats.get("t-lstm")).toEqual({ papers: 1, count: 12 });
  });

  it("aggregateOccurrences：给出现存论文时忽略孤儿记录（与详情一致）", () => {
    const s = aggregateOccurrences(
      [
        { termId: "t", paperId: "p1", count: 5 },
        { termId: "t", paperId: "deleted", count: 7 },
      ],
      new Set(["p1"]),
    );
    expect(s.get("t")).toEqual({ papers: 1, count: 5 });
  });

  it("statsFromRecord", () => {
    const m = statsFromRecord({ rows: 3, stats: { a: [2, 9], b: [0, 0] } });
    expect([...m]).toEqual([["a", { papers: 2, count: 9 }]]);
  });

  it("按名称（不区分大小写）", () => {
    expect(ids(sortTerms(terms.slice(0, 4), { key: "name", dir: "asc" }))).toEqual(["t-atm", "t-ade", "t-bert", "t-lstm"]);
    expect(ids(sortTerms(terms.slice(0, 4), { key: "name", dir: "desc" }))).toEqual(["t-lstm", "t-bert", "t-ade", "t-atm"]);
  });

  it("按出现次数：次数相同时论文多的在前，再按名称；没有出现的视为 0", () => {
    expect(ids(sortTerms(terms.slice(0, 4), { key: "occurrences", dir: "desc" }, stats))).toEqual(["t-atm", "t-lstm", "t-bert", "t-ade"]);
    expect(ids(sortTerms(terms.slice(0, 4), { key: "occurrences", dir: "asc" }, stats))).toEqual(["t-ade", "t-bert", "t-lstm", "t-atm"]);
  });

  it("按修改时间", () => {
    expect(ids(sortTerms(terms.slice(0, 4), { key: "updated", dir: "desc" }))).toEqual(["t-bert", "t-lstm", "t-ade", "t-atm"]);
  });

  it("2000 条排序足够快", () => {
    const many = Array.from({ length: 2000 }, (_, i) => mkTerm(`t${i}`, `term ${(i * 7919) % 2000}`, [], { updatedAt: i }));
    const t0 = performance.now();
    sortTerms(many, { key: "name", dir: "asc" });
    sortTerms(many, { key: "occurrences", dir: "desc" }, stats);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("展示", () => {
  const byId = new Map(domains.map((d) => [d.id, d]));
  it("scopeSummary：全局、领域路径、已失效", () => {
    expect(scopeSummary(terms[0], byId)).toEqual({ kind: "global" });
    expect(scopeSummary(terms[2], byId)).toMatchObject({ kind: "domains", tags: [{ id: "traj", path: "ATM / 轨迹预测" }] });
    expect(scopeSummary(terms[4], byId)).toEqual({ kind: "none" });
  });

  it("formatPages 合并连续页", () => {
    expect(formatPages([1, 2, 3, 7, 9, 10])).toBe("1–3, 7, 9–10");
    expect(formatPages([1, 3, 5, 7, 9, 11, 13], 3)).toBe("1, 3, 5 …");
    expect(formatPages([])).toBe("");
  });

  it("aliasExcerpt 截断", () => {
    expect(aliasExcerpt(["a", "b"])).toBe("a, b");
    expect(aliasExcerpt(["a", "b", "c", "d", "e"], 2)).toBe("a, b 等 5 个");
  });

  it("noteSnippet 截取关键词附近", () => {
    const note = "这是一段很长的笔记。".repeat(10) + "关键内容在这里" + "后面还有很多文字。".repeat(10);
    const s = noteSnippet(note, ["关键"], 30)!;
    expect(s).toContain("关键内容");
    expect(s.startsWith("…")).toBe(true);
    expect(noteSnippet("abc", ["zzz"])).toBeUndefined();
    expect(noteSnippet("", ["a"])).toBeUndefined();
  });

  it("formatShortDate", () => {
    const now = new Date(2026, 9, 20, 18, 0).getTime();
    expect(formatShortDate(new Date(2026, 9, 20, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatShortDate(new Date(2026, 2, 3).getTime(), now)).toBe("3月3日");
    expect(formatShortDate(new Date(2024, 0, 9).getTime(), now)).toBe("2024-01-09");
  });
});

describe("groupOccurrencesByDomain", () => {
  const papers = [
    mkPaper("p1", { title: "B paper", domainIds: ["traj"] }),
    mkPaper("p2", { title: "A paper", domainIds: ["atm", "nlp"] }),
    mkPaper("p3", { title: "C paper" }),
    mkPaper("p4", { title: "D paper", domainIds: ["deleted"] }),
  ];
  const byId = new Map(papers.map((p) => [p.id, p]));
  const occ = (paperId: string, count: number, pages: number[]): Occurrence => ({ termId: "t", paperId, pages, count, engineVersion: 1 });

  it("按领域树顺序分组，多领域论文出现在每个组，未分类在最后；忽略已删除的论文", () => {
    const g = groupOccurrencesByDomain(
      [occ("p1", 3, [2, 5]), occ("p2", 1, [4]), occ("p3", 2, [1]), occ("p4", 4, [3]), occ("gone", 9, [1])],
      byId,
      domains,
    );
    expect(g.paperCount).toBe(4);
    expect(g.total).toBe(10);
    expect(g.groups.map((x) => [x.label, x.papers.map((p) => p.paper.id), x.count])).toEqual([
      ["ATM", ["p2"], 1],
      ["ATM / 轨迹预测", ["p1"], 3],
      ["NLP", ["p2"], 1],
      ["未分类", ["p4", "p3"], 6],
    ]);
    expect(g.groups[1].papers[0].pages).toEqual([2, 5]);
  });

  it("标记待更新的论文", () => {
    const g = groupOccurrencesByDomain([occ("p1", 3, [2]), occ("p3", 2, [1])], byId, domains, (o) => o.paperId === "p3");
    expect(g.updating).toBe(1);
    expect(g.groups.flatMap((x) => x.papers.map((p) => [p.paper.id, p.updating]))).toEqual([
      ["p1", false],
      ["p3", true],
    ]);
  });

  it("组内按次数降序、标题升序", () => {
    const g = groupOccurrencesByDomain([occ("p3", 2, [1]), occ("p4", 2, [1])], byId, domains);
    expect(g.groups[0].papers.map((p) => p.paper.title)).toEqual(["C paper", "D paper"]);
  });
});
