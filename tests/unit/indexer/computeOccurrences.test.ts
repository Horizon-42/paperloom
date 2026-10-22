import { describe, expect, it } from "vitest";
import { TermMatcher } from "@/engine/matcher";
import { MATCH_VERSION, NORMALIZE_VERSION } from "@/engine/types";
import {
  buildDomainParent,
  computeOccurrences,
  domainTreeKey,
  isPageTextFresh,
  orderPapers,
  paperIndexSignature,
  paperScopeKey,
  termsMatchKey,
} from "@/workers/indexCore";
import { mkDomain, mkPaper, mkTerm } from "./fixtures";

const lstm = mkTerm("lstm", "Long Short-Term Memory", ["LSTM"]);
const atm = mkTerm("atm", "air traffic management", ["ATM"], { domains: ["d-atm"] });
const tf = mkTerm("tf", "transformer");
const noParent = new Map<string, string | null>();

describe("computeOccurrences", () => {
  it("统计每个术语的页码（升序、去重）和次数", () => {
    const pages = [
      { page: 3, text: "An LSTM and two LSTMs." },
      { page: 1, text: "Long Short-Term Memory (LSTM) networks." },
      { page: 2, text: "Nothing here, only a Transformer." },
    ];
    const out = computeOccurrences([lstm, tf], mkPaper("p1"), noParent, pages);
    expect(out).toEqual([
      { termId: "lstm", paperId: "p1", pages: [1, 3], count: 4, engineVersion: MATCH_VERSION },
      { termId: "tf", paperId: "p1", pages: [2], count: 1, engineVersion: MATCH_VERSION },
    ]);
  });

  it("没有命中的术语不产生记录；空页跳过", () => {
    expect(computeOccurrences([lstm], mkPaper("p"), noParent, [{ page: 1, text: "" }, { page: 2, text: "plain text" }])).toEqual([]);
  });

  it("作用范围：限定领域的术语只在该领域及其子领域的论文中计数", () => {
    const parent = buildDomainParent([mkDomain("d-atm"), mkDomain("d-traj", "d-atm"), mkDomain("d-nlp")]);
    const text = [{ page: 1, text: "ATM systems and LSTM." }];
    const inAtm = computeOccurrences([lstm, atm], mkPaper("a", { domainIds: ["d-atm"] }), parent, text);
    const inChild = computeOccurrences([lstm, atm], mkPaper("b", { domainIds: ["d-traj"] }), parent, text);
    const inNlp = computeOccurrences([lstm, atm], mkPaper("c", { domainIds: ["d-nlp"] }), parent, text);
    const unfiled = computeOccurrences([lstm, atm], mkPaper("d"), parent, text);
    expect(inAtm.map((o) => o.termId)).toEqual(["atm", "lstm"]);
    expect(inChild.map((o) => o.termId)).toEqual(["atm", "lstm"]);
    expect(inNlp.map((o) => o.termId)).toEqual(["lstm"]);
    expect(unfiled.map((o) => o.termId)).toEqual(["lstm"]);
  });

  it("同一表面形式属于多个生效的术语时，每个候选各计一次", () => {
    const a1 = mkTerm("a1", "ATM", [], { domains: ["d1"] });
    const a2 = mkTerm("a2", "ATM", [], { domains: ["d2"] });
    const out = computeOccurrences([a1, a2], mkPaper("p", { domainIds: ["d1", "d2"] }), noParent, [{ page: 1, text: "ATM ATM" }]);
    expect(out.map((o) => [o.termId, o.count])).toEqual([
      ["a1", 2],
      ["a2", 2],
    ]);
  });

  it("重叠消解：长术语优先，不再拆出短术语", () => {
    const memory = mkTerm("mem", "memory");
    const out = computeOccurrences([lstm, memory], mkPaper("p"), noParent, [{ page: 1, text: "Long Short-Term Memory. Memory is cheap." }]);
    expect(out.map((o) => [o.termId, o.count])).toEqual([
      ["lstm", 1],
      ["mem", 1],
    ]);
  });

  it("硬边界 \\n 不会被多词术语跨越", () => {
    const out = computeOccurrences([lstm], mkPaper("p"), noParent, [{ page: 1, text: "Long Short-Term\nMemory" }]);
    expect(out).toEqual([]);
  });

  it("可以直接传入已构建的 TermMatcher", () => {
    const m = new TermMatcher([lstm]);
    const out = computeOccurrences(m, mkPaper("p"), noParent, [{ page: 5, text: "LSTM" }]);
    expect(out).toMatchObject([{ termId: "lstm", pages: [5], count: 1 }]);
  });
});

describe("变化检测摘要", () => {
  it("termsMatchKey 只随影响匹配的字段变化，与顺序无关", () => {
    const base = termsMatchKey([lstm, tf, atm]);
    expect(termsMatchKey([atm, lstm, tf])).toBe(base);
    expect(termsMatchKey([{ ...lstm, note: "新笔记" }, tf, atm])).toBe(base);
    expect(termsMatchKey([{ ...lstm, updatedAt: 99 }, tf, atm])).toBe(base);
    expect(termsMatchKey([{ ...lstm, aliases: ["LSTM", "LSTMs"] }, tf, atm])).not.toBe(base);
    expect(termsMatchKey([{ ...lstm, matchMode: "caseSensitive" }, tf, atm])).not.toBe(base);
    expect(termsMatchKey([lstm, tf, { ...atm, scope: { kind: "global" } }])).not.toBe(base);
    expect(termsMatchKey([lstm, { ...tf, name: "Transformer encoder" }, atm])).not.toBe(base);
    expect(termsMatchKey([lstm, tf])).not.toBe(base);
  });

  it("paperScopeKey 只随生效的限定领域术语集合变化", () => {
    const parent = buildDomainParent([mkDomain("d-atm"), mkDomain("d-traj", "d-atm"), mkDomain("d-nlp")]);
    const scoped = [atm];
    const k = (domainIds: string[]) => paperScopeKey({ domainIds }, parent, scoped);
    expect(k(["d-atm"])).toBe(k(["d-traj"]));
    expect(k(["d-atm"])).not.toBe(k(["d-nlp"]));
    expect(k(["d-nlp"])).toBe(k([]));
    // 没有限定领域的术语时，论文换领域不影响结果
    expect(paperScopeKey({ domainIds: ["d-atm"] }, parent, [])).toBe(paperScopeKey({ domainIds: ["d-nlp"] }, parent, []));
  });

  it("paperIndexSignature / domainTreeKey", () => {
    expect(paperIndexSignature({ fileHash: "h", domainIds: ["b", "a"] })).toBe(paperIndexSignature({ fileHash: "h", domainIds: ["a", "b"] }));
    expect(paperIndexSignature({ fileHash: "h", domainIds: [] })).not.toBe(paperIndexSignature({ fileHash: "h2", domainIds: [] }));
    expect(domainTreeKey([mkDomain("a"), mkDomain("b", "a")])).toBe(domainTreeKey([mkDomain("b", "a"), { ...mkDomain("a"), name: "改名" }]));
    expect(domainTreeKey([mkDomain("a"), mkDomain("b", "a")])).not.toBe(domainTreeKey([mkDomain("a"), mkDomain("b")]));
  });
});

describe("isPageTextFresh", () => {
  const paper = { fileHash: "h", pageCount: 2 };
  const row = (o: Partial<{ fileHash: string; engineVersion: number }> = {}) => ({ fileHash: "h", engineVersion: NORMALIZE_VERSION, ...o });
  it("页数、文件、规则版本都一致才有效", () => {
    expect(isPageTextFresh([row(), row()], paper)).toBe(true);
    expect(isPageTextFresh([row()], paper)).toBe(false);
    expect(isPageTextFresh([], { fileHash: "h", pageCount: 0 })).toBe(false);
    expect(isPageTextFresh([row(), row({ fileHash: "old" })], paper)).toBe(false);
    expect(isPageTextFresh([row(), row({ engineVersion: NORMALIZE_VERSION + 1 })], paper)).toBe(false);
  });
});

describe("orderPapers", () => {
  it("优先列表在前，其余按最近打开、最近导入", () => {
    const papers = [
      mkPaper("old", { addedAt: 1 }),
      mkPaper("new", { addedAt: 5 }),
      mkPaper("opened", { addedAt: 2, lastOpenedAt: 10 }),
      mkPaper("open-tab", { addedAt: 3 }),
    ];
    expect(orderPapers(papers, ["open-tab"]).map((p) => p.id)).toEqual(["open-tab", "opened", "new", "old"]);
  });
});
