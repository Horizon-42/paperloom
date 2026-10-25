// 领域树（文件夹视图）的行：文件夹在前、论文在后，多领域论文在每个领域下各出现一次，计数不重复，标签筛选时隐藏空领域
import { describe, expect, it } from "vitest";
import { buildFieldTreeRows, revealPath, type FieldTreeInput } from "@/components/library/fieldTree";
import { buildDomainTree } from "@/services/domainTree";
import type { Domain, Paper } from "@/types/models";

const d = (id: string, parentId: string | null, order: number): Domain => ({ id, name: id.toUpperCase(), parentId, color: "#000", order });
const p = (id: string, domainIds: string[]): Paper => ({ id, fileHash: id, title: id, authors: [], domainIds, pageCount: 1, addedAt: 0 });

// a ─ a1
//   └ a2
// b
const DOMAINS = [d("a", null, 0), d("a1", "a", 0), d("a2", "a", 1), d("b", null, 1)];
const PAPERS = [p("x", ["a"]), p("y", ["a1", "b"]), p("z", []), p("w", ["gone"]), p("v", ["a1"])];

function rows(over: Partial<FieldTreeInput> = {}) {
  return buildFieldTreeRows({
    tree: buildDomainTree(DOMAINS),
    papers: PAPERS,
    domainById: new Map(DOMAINS.map((x) => [x.id, x])),
    isExpanded: () => true,
    unfiledOpen: true,
    filtering: false,
    showEmptyUnfiled: false,
    ...over,
  });
}
const outline = (rs: ReturnType<typeof rows>) =>
  rs.map((r) =>
    r.kind === "folder"
      ? `${"  ".repeat(r.depth)}[${r.node.domain.id} ${r.count}]`
      : r.kind === "unfiled"
        ? `[unfiled ${r.count}]`
        : r.kind === "note"
          ? `${"  ".repeat(r.depth)}note:${r.note.id}`
          : `${"  ".repeat(r.depth)}${r.paper.id}${r.multi ? "*" : ""}`,
  );

describe("buildFieldTreeRows", () => {
  it("全部展开：子领域在前、论文在后；多领域论文各出现一次；不属于现存领域的在「未分类」", () => {
    expect(outline(rows())).toEqual([
      "[a 3]", // x、y、v（去重）
      "  [a1 2]",
      "    y*",
      "    v",
      "  [a2 0]",
      "  x",
      "[b 1]",
      "  y*",
      "[unfiled 2]",
      "  z",
      "  w", // 只属于已删除的领域
    ]);
  });

  it("折叠的领域不列出其中内容；空领域不能展开", () => {
    const rs = rows({ isExpanded: (id) => id !== "a" });
    expect(outline(rs)).toEqual(["[a 3]", "[b 1]", "  y*", "[unfiled 2]", "  z", "  w"]);
    const a2 = rows().find((r) => r.kind === "folder" && r.node.domain.id === "a2");
    expect(a2).toMatchObject({ expandable: false, expanded: false });
  });

  it("「未分类」收起时只显示一行；为空时不显示，拖论文时显示", () => {
    expect(outline(rows({ unfiledOpen: false })).slice(-1)).toEqual(["[unfiled 2]"]);
    const filed = { papers: PAPERS.filter((x) => x.id !== "z" && x.id !== "w") };
    expect(rows(filed).some((r) => r.kind === "unfiled")).toBe(false);
    expect(rows({ ...filed, showEmptyUnfiled: true }).at(-1)).toMatchObject({ kind: "unfiled", count: 0, expanded: false });
  });

  it("标签筛选时（传入的是已筛选的论文）：没有匹配论文的领域不显示，计数按筛选后算", () => {
    const rs = rows({ papers: [PAPERS[1]], filtering: true });
    expect(outline(rs)).toEqual(["[a 1]", "  [a1 1]", "    y*", "[b 1]", "  y*"]);
  });

  it("keepVisible：筛选时也显示这个领域，并展开它的上级（新建子领域时）", () => {
    const rs = rows({ papers: [PAPERS[1]], filtering: true, keepVisible: "a2", isExpanded: (id) => id !== "a" });
    expect(outline(rs)).toEqual(["[a 1]", "  [a1 1]", "    y*", "  [a2 0]", "[b 1]", "  y*"]);
  });

  it("domainIds 里重复的领域只算一次，不显示「也在其他领域」", () => {
    const rs = rows({ papers: [p("dup", ["b", "b"])] });
    expect(outline(rs)).toEqual(["[a 0]", "  [a1 0]", "  [a2 0]", "[b 1]", "  dup"]);
  });

  it("每行的 key 唯一（同一篇论文在不同领域下）", () => {
    const keys = rows().map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("revealPath", () => {
  const tree = buildDomainTree(DOMAINS);
  it("按树的顺序取论文所在的第一个领域及其上级；不在任何领域时为 null", () => {
    expect(revealPath(tree, p("y", ["b", "a1"]))).toEqual({ folderId: "a1", ancestors: ["a"] });
    expect(revealPath(tree, p("x", ["a"]))).toEqual({ folderId: "a", ancestors: [] });
    expect(revealPath(tree, p("z", []))).toBeNull();
    expect(revealPath(tree, p("w", ["gone"]))).toBeNull();
  });
});

describe("领域笔记", () => {
  const note = (id: string, domainId: string) => ({ id, domainId, text: "", createdAt: 1, updatedAt: 1 });
  it("排在所属领域的最前面（子领域和论文之前）；只有笔记的领域也可以展开；按标签筛选时不显示", () => {
    const notesByDomain = new Map([
      ["a", [note("n1", "a"), note("n2", "a")]],
      ["b", [note("n3", "b")]],
    ]);
    const out = outline(rows({ notesByDomain }));
    expect(out.slice(0, 4)).toEqual(["[a 3]", "  note:n1", "  note:n2", "  [a1 2]"]);
    expect(out).toContain("  note:n3");
    // 收起时不显示
    expect(outline(rows({ notesByDomain, isExpanded: () => false })).some((x) => x.includes("note:"))).toBe(false);
    // 筛选时不显示
    expect(outline(rows({ notesByDomain, filtering: true })).some((x) => x.includes("note:"))).toBe(false);
  });
});
