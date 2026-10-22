import { describe, expect, it } from "vitest";
import { buildListModel, compareInPaper, matchesFilter, plainExcerpt } from "@/components/annotation/listModel";
import type { Annotation } from "@/types/models";

let n = 0;
function ann(p: Partial<Annotation>): Annotation {
  n++;
  return {
    id: `a${n}`,
    paperId: "p1",
    page: 1,
    rects: [[72, 700, 200, 712]],
    quote: { exact: "text", prefix: "", suffix: "" },
    fileHash: "h",
    color: "#fde68a",
    note: "",
    createdAt: n,
    updatedAt: n,
    ...p,
  };
}

describe("matchesFilter", () => {
  const a = ann({ quote: { exact: "Long Short-Term Memory", prefix: "", suffix: "" }, note: "Gated **RNN**", color: "#BBF7D0" });
  it("matches keywords in quote and note (all tokens, case-insensitive)", () => {
    expect(matchesFilter(a, { tokens: ["memory"] })).toBe(true);
    expect(matchesFilter(a, { tokens: ["memory", "rnn"] })).toBe(true);
    expect(matchesFilter(a, { tokens: ["memory", "lstm"] })).toBe(false);
  });
  it("filters by color (case-insensitive) and paper", () => {
    expect(matchesFilter(a, { colors: new Set(["#bbf7d0"]) })).toBe(true);
    expect(matchesFilter(a, { colors: new Set(["#fde68a"]) })).toBe(false);
    expect(matchesFilter(a, { colors: new Set() })).toBe(true);
    expect(matchesFilter(a, { paperIds: new Set(["p2"]) })).toBe(false);
    expect(matchesFilter(a, { paperIds: null })).toBe(true);
  });
});

describe("compareInPaper", () => {
  it("sorts by page, then top to bottom, then left to right", () => {
    const top = ann({ page: 2, rects: [[300, 700, 350, 712]] });
    const topLeft = ann({ page: 2, rects: [[72, 701, 100, 712]] });
    const lower = ann({ page: 2, rects: [[72, 500, 100, 512]] });
    const p1 = ann({ page: 1, rects: [[72, 100, 100, 112]] });
    const noRects = ann({ page: 2, rects: [] });
    const sorted = [lower, noRects, top, p1, topLeft].sort(compareInPaper);
    expect(sorted.map((x) => x.id)).toEqual([p1.id, topLeft.id, top.id, lower.id, noRects.id]);
  });
});

describe("buildListModel", () => {
  it("groups by paper, separates orphaned annotations and drops deleted papers", () => {
    const titles: Record<string, string> = { p1: "Paper One", p2: "Paper Two" };
    const a1 = ann({ paperId: "p1", updatedAt: 10 });
    const a2 = ann({ paperId: "p2", updatedAt: 50 });
    const a3 = ann({ paperId: "p1", page: 3, updatedAt: 20 });
    const orphan = ann({ paperId: "p1", anchorStatus: "orphaned" });
    const gone = ann({ paperId: "deleted" });
    const m = buildListModel([a1, a2, a3, orphan, gone], (id) => titles[id], {});
    expect(m.total).toBe(4);
    expect(m.orphaned.map((x) => x.id)).toEqual([orphan.id]);
    // 最近更新过批注的论文在前
    expect(m.groups.map((g) => g.paperId)).toEqual(["p2", "p1"]);
    expect(m.groups[1].items.map((x) => x.id)).toEqual([a1.id, a3.id]);
    expect(m.groups[1].title).toBe("Paper One");
  });

  it("applies the filter to orphaned annotations too", () => {
    const orphan = ann({ anchorStatus: "orphaned", note: "keep" });
    const other = ann({ anchorStatus: "orphaned" });
    const m = buildListModel([orphan, other], () => "T", { tokens: ["keep"] });
    expect(m.orphaned.map((x) => x.id)).toEqual([orphan.id]);
    expect(m.groups).toEqual([]);
  });
});

describe("plainExcerpt", () => {
  it("strips common markdown and truncates", () => {
    expect(plainExcerpt("# Title\n- **bold** and [link](http://x) `code`")).toBe("Title bold and link code");
    expect(plainExcerpt("x".repeat(200), 20)).toHaveLength(20);
  });
});
