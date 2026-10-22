import { describe, expect, it } from "vitest";
import { TermMatcher } from "@/engine/matcher";
import { fromNormalizedText } from "@/engine/normalize";
import type { TermLike, TermMatch } from "@/engine/types";
import { firstPerTerm, hitTest, visibleMatches } from "@/components/term/logic/display";
import {
  buildFormIndex,
  findConflicts,
  formsCollide,
  paperDomainClosures,
  scopeOverlap,
  scopesOverlap,
} from "@/components/term/logic/conflicts";
import { weakForms } from "@/components/term/logic/forms";
import { surfaceForms } from "@/engine/matcher";
import { findDefinitions, looksLikeAbbreviation, matchLongForm, suggestFromSelection } from "@/components/term/logic/definition";
import {
  buildOccurrenceIndex,
  groupOccurrences,
  navigationOrigin,
  occurrenceIndexOf,
  orderCandidates,
  scopeDistance,
  stepOccurrence,
} from "@/components/term/logic/occurrences";
import type { Domain, Occurrence } from "@/types/models";

const t = (id: string, name: string, aliases: string[] = [], extra: Partial<TermLike> = {}): TermLike => ({
  id,
  name,
  aliases,
  matchMode: "auto",
  scope: { kind: "global" },
  ...extra,
});

const m = (start: number, end: number, ...termIds: string[]): TermMatch => ({ start, end, termIds });

describe("display", () => {
  it("firstPerTerm 每个术语只留第一次；多候选命中只要有一个新术语就保留", () => {
    const ms = [m(0, 4, "a"), m(10, 14, "a"), m(20, 23, "b", "c"), m(30, 33, "b"), m(40, 43, "c", "d")];
    expect(firstPerTerm(ms).map((x) => x.start)).toEqual([0, 20, 40]);
  });

  it("visibleMatches 隐藏优先于只标第一次", () => {
    const ms = [m(0, 4, "a"), m(10, 14, "a")];
    expect(visibleMatches(ms, { hidden: true, firstOnly: true })).toEqual([]);
    expect(visibleMatches(ms, { hidden: false, firstOnly: true })).toHaveLength(1);
    expect(visibleMatches(ms, { hidden: false, firstOnly: false })).toHaveLength(2);
  });

  it("hitTest 命中段、容差、最近优先", () => {
    const items = [
      [{ left: 10, top: 10, width: 40, height: 12 }],
      [
        { left: 300, top: 10, width: 50, height: 12 },
        { left: 0, top: 30, width: 30, height: 12 },
      ],
    ];
    expect(hitTest(items, 20, 15)).toEqual({ index: 0, seg: 0 });
    expect(hitTest(items, 5, 35)).toEqual({ index: 1, seg: 1 });
    expect(hitTest(items, 50.5, 15)).toEqual({ index: 0, seg: 0 }); // 容差 1px
    expect(hitTest(items, 53, 15)).toBeNull();
    expect(hitTest(items, 100, 100)).toBeNull();
    const overlapping = [[{ left: 0, top: 0, width: 100, height: 20 }], [{ left: 60, top: 0, width: 20, height: 20 }]];
    expect(hitTest(overlapping, 65, 10)?.index).toBe(1);
  });
});

describe("conflicts", () => {
  const parent = new Map<string, string | null>([
    ["atm", null],
    ["traj", "atm"],
    ["bank", null],
  ]);

  it("formsCollide 区分大小写规则", () => {
    expect(formsCollide({ form: "ATM", caseSensitive: true }, { form: "ATM", caseSensitive: true })).toBe(true);
    expect(formsCollide({ form: "ATM", caseSensitive: true }, { form: "Atm", caseSensitive: true })).toBe(false);
    expect(formsCollide({ form: "ATM", caseSensitive: true }, { form: "atm", caseSensitive: false })).toBe(true);
    expect(formsCollide({ form: "memory", caseSensitive: false }, { form: "Memory", caseSensitive: false })).toBe(true);
  });

  it("scopesOverlap：全局、同领域、祖先/子孙、互不相干、空领域", () => {
    const g = { kind: "global" } as const;
    const d = (...ids: string[]) => ({ kind: "domains" as const, domainIds: ids });
    expect(scopesOverlap(g, d("bank"), parent)).toBe(true);
    expect(scopesOverlap(d("traj"), d("atm"), parent)).toBe(true);
    expect(scopesOverlap(d("atm"), d("traj"), parent)).toBe(true);
    expect(scopesOverlap(d("atm"), d("bank"), parent)).toBe(false);
    expect(scopesOverlap(d(), g, parent)).toBe(false);
  });

  it("findConflicts 报告共享表面形式且范围重叠的术语，排除自身", () => {
    const terms = [
      t("t1", "Long Short-Term Memory", ["LSTM"]),
      t("t2", "Automated Teller Machine", ["ATM"], { scope: { kind: "domains", domainIds: ["bank"] } }),
      t("t3", "Air Traffic Management", ["ATM"], { scope: { kind: "domains", domainIds: ["atm"] } }),
    ];
    const index = buildFormIndex(terms);
    const byId = new Map(terms.map((x) => [x.id, x]));
    // 新术语 "LSTM network"，别名 LSTM → 与 t1 冲突
    expect(findConflicts(t("new", "LSTM network", ["LSTM"]), index, byId, parent)).toEqual([{ termId: "t1", forms: ["LSTM", "LSTMs"], via: "tree" }]);
    // 在 traj 领域新建 ATM：与 t3（上级领域）冲突，与 t2（bank）不冲突
    const draft = t("new", "Air Traffic Manager", ["ATM"], { scope: { kind: "domains", domainIds: ["traj"] } });
    expect(findConflicts(draft, index, byId, parent).map((c) => c.termId)).toEqual(["t3"]);
    // 编辑 t3 自身不报冲突
    expect(findConflicts(terms[2], index, byId, parent)).toEqual([]);
    // 小写 atm 在 auto 模式下不区分大小写，会命中 "ATM" → 冲突
    expect(findConflicts(t("new", "atm"), index, byId, parent).map((c) => c.termId)).toEqual(["t2", "t3"]);
    // 区分大小写的 "Atm" 不会命中 "ATM"
    expect(findConflicts(t("new", "Atm", [], { matchMode: "caseSensitive" }), index, byId, parent)).toEqual([]);
  });
});

describe("conflicts：一篇论文属于多个领域", () => {
  // atm 与 bank 互不相干；p1 同时属于 traj（atm 的子领域）和 bank
  const parent = new Map<string, string | null>([
    ["atm", null],
    ["traj", "atm"],
    ["bank", null],
    ["nlp", null],
  ]);
  const d = (...ids: string[]) => ({ kind: "domains" as const, domainIds: ids });
  const closures = paperDomainClosures([["traj", "bank"], ["nlp"], []], parent);

  it("paperDomainClosures 含祖先，跳过未归类论文", () => {
    expect(closures.map((c) => [...c].sort())).toEqual([["atm", "bank", "traj"], ["nlp"]]);
  });

  it("scopeOverlap：树上不相干但有论文同时属于两边 → paper", () => {
    expect(scopeOverlap(d("atm"), d("bank"), parent)).toBeNull();
    expect(scopeOverlap(d("atm"), d("bank"), parent, closures)).toBe("paper");
    expect(scopeOverlap(d("atm"), d("nlp"), parent, closures)).toBeNull();
    expect(scopeOverlap(d("traj"), d("atm"), parent, closures)).toBe("tree");
    expect(scopesOverlap(d(), d("bank"), parent, closures)).toBe(false);
  });

  it("findConflicts 报告经由论文的重叠和论文数", () => {
    const terms = [t("t-bank", "Automated Teller Machine", ["ATM"], { scope: d("bank") })];
    const index = buildFormIndex(terms);
    const byId = new Map(terms.map((x) => [x.id, x]));
    const draft = t("new", "Air Traffic Management", ["ATM"], { scope: d("atm") });
    expect(findConflicts(draft, index, byId, parent)).toEqual([]);
    expect(findConflicts(draft, index, byId, parent, closures)).toEqual([{ termId: "t-bank", forms: ["ATM", "ATMs"], via: "paper", sharedPapers: 1 }]);
    const nlp = t("new", "Abstract Text Model", ["ATM"], { scope: d("nlp") });
    expect(findConflicts(nlp, index, byId, parent, closures)).toEqual([]);
  });
});

describe("forms：过短或不含字母数字的表面形式", () => {
  it("weakForms", () => {
    expect(weakForms(surfaceForms(t("x", "a", ["-", "CO2", "ε", "熵", "x-y"])))).toEqual([
      { form: "a", reason: "short" },
      { form: "-", reason: "noAlnum" },
      { form: "ε", reason: "short" },
      { form: "熵", reason: "short" },
    ]);
    expect(weakForms([{ form: "LSTM" }, { form: "Tz" }])).toEqual([]);
    expect(weakForms([{ form: "§" }, { form: "§" }])).toEqual([{ form: "§", reason: "noAlnum" }]);
  });
});

describe("definition", () => {
  it("looksLikeAbbreviation", () => {
    expect(looksLikeAbbreviation("LSTM")).toBe(true);
    expect(looksLikeAbbreviation("LSTMs")).toBe(true);
    expect(looksLikeAbbreviation("4D-TP")).toBe(true);
    expect(looksLikeAbbreviation("Transformer")).toBe(false);
    expect(looksLikeAbbreviation("A")).toBe(false);
    expect(looksLikeAbbreviation("AIR TRAFFIC")).toBe(false);
    expect(looksLikeAbbreviation("2024")).toBe(false);
  });

  it("matchLongForm（Schwartz–Hearst）", () => {
    expect(matchLongForm("LSTM", "networks called Long Short-Term Memory")).toBe("Long Short-Term Memory");
    expect(matchLongForm("ATM", "In air traffic management")).toBe("air traffic management");
    expect(matchLongForm("LSTMs", "Long Short-Term Memory")).toBe("Long Short-Term Memory");
    expect(matchLongForm("CNN", "we use a recurrent model")).toBeNull();
    expect(matchLongForm("ATM", "ATM")).toBeNull();
  });

  it("findDefinitions 在页内查找定义", () => {
    const text = "Intro. Long Short-Term Memory (LSTM) networks are popular. A stacked LSTM is used. In air traffic management (ATM), …";
    expect(findDefinitions(text, "LSTM")).toEqual(["Long Short-Term Memory"]);
    expect(findDefinitions(text, "ATM")).toEqual(["air traffic management"]);
    expect(findDefinitions(text, "CNN")).toEqual([]);
  });

  it("suggestFromSelection 各种句式", () => {
    // 选中缩写，前文是全称 + "("
    expect(suggestFromSelection("LSTM", "class of models. Long Short-Term Memory (", ") networks are")).toMatchObject({
      name: "Long Short-Term Memory",
      aliases: ["LSTM"],
    });
    // 选中全称，后文是 "(缩写)"
    expect(suggestFromSelection("Long Short-Term Memory", "of models. ", " (LSTM) networks are")).toMatchObject({
      name: "Long Short-Term Memory",
      aliases: ["LSTM"],
    });
    // 选中整个定义
    expect(suggestFromSelection("Long Short-Term Memory (LSTM)")).toMatchObject({ name: "Long Short-Term Memory", aliases: ["LSTM"] });
    expect(suggestFromSelection("ATM (air traffic management)")).toMatchObject({ name: "air traffic management", aliases: ["ATM"] });
    // 缩写 + "(全称)"
    expect(suggestFromSelection("ATM", "In ", " (air traffic management), trajectory")).toMatchObject({
      name: "air traffic management",
      aliases: ["ATM"],
    });
    // 页内其他地方的定义
    expect(suggestFromSelection("LSTM", "a stacked ", " on data", "Long Short-Term Memory (LSTM) networks …")).toMatchObject({
      name: "Long Short-Term Memory",
    });
    // 没有定义
    expect(suggestFromSelection("LSTM", "a stacked ", " on data")).toBeNull();
    expect(suggestFromSelection("transformer", "the ", " architecture")).toBeNull();
  });
});

describe("occurrences", () => {
  const matcher = new TermMatcher([t("lstm", "Long Short-Term Memory", ["LSTM"]), t("tf", "Transformer")]);
  const pages = [
    { page: 2, text: "A Transformer and an LSTM." },
    { page: 1, text: "Long Short-Term Memory (LSTM) is old." },
    { page: 3, text: "Nothing here." },
  ];

  it("buildOccurrenceIndex 按页码和偏移排序", () => {
    const idx = buildOccurrenceIndex(pages, matcher);
    expect(idx.get("lstm")).toEqual([
      { page: 1, start: 0, end: 22 },
      { page: 1, start: 24, end: 28 },
      { page: 2, start: 21, end: 25 },
    ]);
    expect(idx.get("tf")).toEqual([{ page: 2, start: 2, end: 13 }]);
    // 与逐页 match 一致
    expect(matcher.match(fromNormalizedText(pages[0].text)).map((x) => x.start)).toEqual([2, 21]);
  });

  it("stepOccurrence 前后跳转与首尾相接", () => {
    const list = buildOccurrenceIndex(pages, matcher).get("lstm")!;
    expect(stepOccurrence(list, { page: 1, start: 0 }, 1)).toBe(1);
    expect(stepOccurrence(list, { page: 1, start: 24 }, 1)).toBe(2);
    expect(stepOccurrence(list, { page: 2, start: 21 }, 1)).toBe(0);
    expect(stepOccurrence(list, { page: 2, start: 21 }, 1, false)).toBe(-1);
    expect(stepOccurrence(list, { page: 1, start: 0 }, -1)).toBe(2);
    expect(stepOccurrence(list, { page: 2, start: 0 }, -1)).toBe(1); // 不在列表里的位置
    expect(stepOccurrence([], { page: 1, start: 0 }, 1)).toBe(-1);
    expect(occurrenceIndexOf(list, { page: 1, start: 24 })).toBe(1);
    expect(occurrenceIndexOf(list, { page: 1, start: 25 })).toBe(-1);
  });

  it("groupOccurrences 按领域分组，多领域论文出现在每个组，未归类在最后", () => {
    const domains: Domain[] = [
      { id: "b", name: "B", parentId: null, color: "", order: 1 },
      { id: "a", name: "A", parentId: null, color: "", order: 0 },
      { id: "a1", name: "A1", parentId: "a", color: "", order: 0 },
    ];
    const papers = new Map([
      ["p1", { id: "p1", title: "One", domainIds: ["a1", "b"] }],
      ["p2", { id: "p2", title: "Two", domainIds: [] }],
      ["p3", { id: "p3", title: "Three", domainIds: ["a1"] }],
    ]);
    const occ = (paperId: string, pages: number[]): Occurrence => ({ termId: "x", paperId, pages, count: pages.length, engineVersion: 1 });
    const groups = groupOccurrences([occ("p1", [3, 5]), occ("p2", [1]), occ("p3", [2, 4, 9]), occ("gone", [1])], papers, domains);
    expect(groups.map((g) => [g.label, g.papers.map((p) => `${p.title}×${p.count}@${p.firstPage}`)])).toEqual([
      ["A / A1", ["Three×3@2", "One×2@3"]],
      ["B", ["One×2@3"]],
      ["未归类", ["Two×1@1"]],
    ]);
    // 规则版本过渡：旧记录照常列出，标为待更新
    const withOutdated = groupOccurrences([occ("p1", [3]), occ("p2", [1])], papers, domains, new Set(["p2"]));
    expect(withOutdated.flatMap((g) => g.papers.map((p) => [p.paperId, p.outdated]))).toEqual([
      ["p1", false],
      ["p1", false],
      ["p2", true],
    ]);
  });

  it("navigationOrigin：跨页导航未落定时从它的目标算起", () => {
    const anchor = { paperId: "p", page: 8, start: 40 };
    expect(navigationOrigin(anchor, null)).toEqual({ page: 8, start: 40 });
    expect(navigationOrigin(anchor, { paperId: "p", page: 1, range: { start: 5 }, movePopover: true })).toEqual({ page: 1, start: 5 });
    // 不随弹窗移动的闪烁（打开别的论文）、别的论文、没有区间：不影响
    expect(navigationOrigin(anchor, { paperId: "p", page: 1, range: { start: 5 } })).toEqual({ page: 8, start: 40 });
    expect(navigationOrigin(anchor, { paperId: "q", page: 1, range: { start: 5 }, movePopover: true })).toEqual({ page: 8, start: 40 });
    expect(navigationOrigin(anchor, { paperId: "p", page: 1, movePopover: true })).toEqual({ page: 8, start: 40 });

    // 连按：在最后一处按两次 ↓，第二次从第一次的目标算起 → 第 2 处
    const list = buildOccurrenceIndex(pages, matcher).get("lstm")!;
    const last = list[list.length - 1];
    const a = { paperId: "p", page: last.page, start: last.start };
    const i1 = stepOccurrence(list, navigationOrigin(a, null), 1);
    const pending = { paperId: "p", page: list[i1].page, range: { start: list[i1].start }, movePopover: true };
    expect([i1, stepOccurrence(list, navigationOrigin(a, pending), 1)]).toEqual([0, 1]);
  });

  it("scopeDistance / orderCandidates：离论文领域近的在前，全局在后，再按名称", () => {
    const parent = new Map<string, string | null>([
      ["root", null],
      ["mid", "root"],
      ["leaf", "mid"],
      ["other", null],
    ]);
    const d = (...ids: string[]) => ({ kind: "domains", domainIds: ids });
    expect(scopeDistance(d("leaf"), ["leaf"], parent)).toBe(0);
    expect(scopeDistance(d("root"), ["leaf"], parent)).toBe(2);
    expect(scopeDistance(d("root", "mid"), ["leaf", "other"], parent)).toBe(1);
    expect(scopeDistance({ kind: "global" }, ["leaf"], parent)).toBe(Infinity);
    expect(scopeDistance(d("other"), ["leaf"], parent)).toBeNaN();

    const byId = new Map([
      ["g", { id: "g", name: "Global", scope: { kind: "global" } }],
      ["r", { id: "r", name: "Root term", scope: d("root") }],
      ["l", { id: "l", name: "Leaf term", scope: d("leaf") }],
      ["m2", { id: "m2", name: "B mid", scope: d("mid") }],
      ["m1", { id: "m1", name: "A mid", scope: d("mid") }],
    ]);
    // nanoid 顺序（输入顺序）不影响结果
    expect(orderCandidates(["g", "r", "m2", "l", "m1"], byId, ["leaf"], parent)).toEqual(["l", "m1", "m2", "r", "g"]);
    expect(orderCandidates(["r", "l"], byId, ["mid"], parent)).toEqual(["r", "l"]); // leaf 不在范围内，排后
    expect(orderCandidates(["g", "r"], byId)).toEqual(["r", "g"]);
  });
});
