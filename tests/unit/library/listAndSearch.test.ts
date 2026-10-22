// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import type { Paper } from "@/types/models";
import { formatAuthorsShort, sortPapers } from "@/components/library/paperQuery";
import { paperMatches, parseQuery, registerSearchProvider, runSearch } from "@/components/library/search";

const paper = (id: string, extra: Partial<Paper> = {}): Paper => ({
  id,
  fileHash: `h-${id}`,
  title: id,
  authors: [],
  domainIds: [],
  pageCount: 1,
  addedAt: 0,
  ...extra,
});

describe("sortPapers", () => {
  const papers = [
    paper("a", { title: "Beta", year: 2020, addedAt: 3 }),
    paper("b", { title: "alpha", addedAt: 1, lastOpenedAt: 10 }),
    paper("c", { title: "Gamma 10", year: 2023, addedAt: 2, lastOpenedAt: 20 }),
    paper("d", { title: "Gamma 9", year: 2020, addedAt: 4 }),
  ];
  const order = (sort: Parameters<typeof sortPapers>[1]) => sortPapers(papers, sort).map((p) => p.id);

  it("sorts by title (case-insensitive, numeric)", () => expect(order("title")).toEqual(["b", "a", "d", "c"]));
  it("sorts by year, newest first, missing last", () => expect(order("year")).toEqual(["c", "a", "d", "b"]));
  it("sorts by last opened, then never-opened by added time", () => expect(order("lastOpened")).toEqual(["c", "b", "d", "a"]));
  it("sorts by added time", () => expect(order("added")).toEqual(["d", "a", "c", "b"]));
  it("does not mutate the input", () => {
    sortPapers(papers, "title");
    expect(papers.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("search", () => {
  beforeEach(async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it("matches all tokens against title and authors", () => {
    const p = { title: "Attention Is All You Need", authors: ["Ashish Vaswani", "Noam Shazeer"] };
    expect(paperMatches(p, parseQuery("attention VASWANI").tokens)).toBe(true);
    expect(paperMatches(p, parseQuery("attention bert").tokens)).toBe(false);
    expect(paperMatches(p, parseQuery("   ").tokens)).toBe(false);
  });

  it("groups results by provider and isolates provider failures", async () => {
    await db.papers.bulkAdd([paper("p1", { title: "LSTM for trajectories" }), paper("p2", { title: "Other" })]);
    const offTerm = registerSearchProvider({
      kind: "term",
      label: "术语",
      order: 2,
      search: async (q) => (q.tokens.includes("lstm") ? [{ kind: "term", id: "t1", title: "LSTM" }] : []),
      activate: () => {},
    });
    const offAnn = registerSearchProvider({
      kind: "annotation",
      label: "批注",
      order: 1,
      search: async () => {
        throw new Error("boom");
      },
      activate: () => {},
    });
    const groups = await runSearch("lstm");
    expect(groups.map((g) => [g.kind, g.total])).toEqual([
      ["paper", 1],
      ["annotation", 0],
      ["term", 1],
    ]);
    expect(groups[0].hits[0].id).toBe("p1");
    offTerm();
    offAnn();
    expect((await runSearch("lstm")).map((g) => g.kind)).toEqual(["paper"]);
    expect(await runSearch("  ")).toEqual([]);
  });
});

it("formatAuthorsShort", () => {
  expect(formatAuthorsShort([])).toBe("");
  expect(formatAuthorsShort(["A", "B"])).toBe("A, B");
  expect(formatAuthorsShort(["A", "B", "C", "D"])).toBe("A, B, C 等");
});
