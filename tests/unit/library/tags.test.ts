// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import { paperMatches } from "@/components/library/search";
import {
  collectTags,
  filterPapersByTags,
  findTag,
  hasTag,
  normalizeTag,
  normalizeTags,
  parseTagInput,
  renameInTags,
  sameTagInfos,
  suggestTags,
  TAG_MAX_LENGTH,
  tagColorIndex,
} from "@/lib/tags";
import { updatePaperMetadata } from "@/services/paperService";
import { normalizeTables } from "@/services/storage/format";
import { buildMarkdownFiles } from "@/services/storage/markdown";
import { addPaperTags, deleteTag, removePaperTag, renameTag, setPaperTags } from "@/services/tagService";
import type { Paper } from "@/types/models";

const paper = (id: string, tags?: string[], addedAt = 1): Paper => ({
  id,
  fileHash: `h-${id}`,
  title: `Paper ${id}`,
  authors: ["Ada"],
  domainIds: [],
  pageCount: 1,
  addedAt,
  ...(tags ? { tags } : {}),
});

describe("normalize", () => {
  it("trims, collapses whitespace, strips leading # and separators", () => {
    expect(normalizeTag("  #待读  ")).toBe("待读");
    expect(normalizeTag("＃ deep   learning ")).toBe("deep learning");
    expect(normalizeTag("a,b；c")).toBe("a b c");
    expect(normalizeTag("##")).toBe("");
    expect(normalizeTag("C#")).toBe("C#");
    expect([...normalizeTag("x".repeat(100))].length).toBe(TAG_MAX_LENGTH);
  });

  it("is idempotent, including repeated # groups with spaces", () => {
    expect(normalizeTag("# #foo")).toBe("foo");
    expect(normalizeTag("# # ＃ foo bar")).toBe("foo bar");
    for (const raw of ["# #foo", "  ##  # a,b ", "x".repeat(39) + " #y", "＃＃ 待 读 ；", "C# #", "#\u0000#a"]) {
      const once = normalizeTag(raw);
      expect(normalizeTag(once)).toBe(once);
    }
  });

  it("dedupes case-insensitively, keeping the first spelling and order", () => {
    expect(normalizeTags(["ML", "survey", "ml", " ", "Survey", "新"])).toEqual(["ML", "survey", "新"]);
  });

  it("parses comma/semicolon separated input", () => {
    expect(parseTagInput("待读, 方法；Baseline\n#综述,,")).toEqual(["待读", "方法", "Baseline", "综述"]);
  });
});

describe("queries", () => {
  const ps = [paper("a", ["ML", "待读"], 3), paper("b", ["ml"], 1), paper("c"), paper("d", ["综述", "待读"], 2)];

  it("collects tags with counts, display spelling from the earliest paper", () => {
    // 与标题排序同一个 zh-CN collator：中文在前
    expect(collectTags(ps)).toEqual([
      { name: "待读", count: 2 },
      { name: "综述", count: 1 },
      { name: "ml", count: 2 },
    ]);
  });

  it("filters by all tags (AND), case-insensitively", () => {
    expect(filterPapersByTags(ps, []).map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterPapersByTags(ps, ["ML"]).map((p) => p.id)).toEqual(["a", "b"]);
    expect(filterPapersByTags(ps, ["待读", "ml"]).map((p) => p.id)).toEqual(["a"]);
    expect(hasTag(ps[1], "Ml")).toBe(true);
    expect(hasTag(ps[2], "ml")).toBe(false);
  });

  it("renames in place and merges with an existing target", () => {
    expect(renameInTags(["a", "b", "c"], "B", "x")).toEqual(["a", "x", "c"]);
    expect(renameInTags(["a", "b", "c"], "a", "C")).toEqual(["C", "b"]);
    expect(renameInTags(["ml"], "ml", "ML")).toEqual(["ML"]);
    expect(renameInTags(["a"], "z", "x")).toBeNull();
  });

  it("search matches tags; #token only matches tags", () => {
    const p = paper("s", ["Deep Learning", "待读"]);
    expect(paperMatches(p, ["learning"])).toBe(true);
    expect(paperMatches(p, ["#待"])).toBe(true);
    expect(paperMatches(p, ["#paper"])).toBe(false); // 标题里有 Paper，但 # 只搜标签
    expect(paperMatches(p, ["paper", "#deep"])).toBe(true);
    expect(paperMatches(p, ["#"])).toBe(false);
  });
});

describe("storage format and markdown", () => {
  it("repairs tags on load and omits empty lists", () => {
    const { tables } = normalizeTables({
      papers: [
        { ...paper("a"), tags: [" #x ", "X", 3, "y"] },
        { ...paper("b"), tags: [] },
        { ...paper("c"), tags: "nope" },
      ],
    });
    expect(tables.papers.map((p) => p.tags)).toEqual([["x", "y"], undefined, undefined]);
    expect("tags" in tables.papers[1]).toBe(false);
  });

  it("exports user tags to Obsidian frontmatter and the meta list", () => {
    const files = buildMarkdownFiles({
      tables: { domains: [], papers: [paper("a", ["待读", "deep learning", "2024"])], annotations: [], terms: [] },
      occurrences: [],
    });
    const md = files.find((f) => f.name.startsWith("papers/"))!.content;
    expect(md).toContain("  - \"待读\"");
    expect(md).toContain("  - \"deep-learning\"");
    expect(md).toContain("  - \"_2024\"");
    expect(md).toContain("- 标签：待读、deep learning、2024");
  });

  it("escapes Markdown syntax in the tag line so Obsidian doesn't see extra tags", () => {
    const files = buildMarkdownFiles({
      tables: { domains: [], papers: [paper("a", ["a #b", "[x]"])], annotations: [], terms: [] },
      occurrences: [],
    });
    const md = files.find((f) => f.name.startsWith("papers/"))!.content;
    expect(md).toContain("- 标签：a \\#b、\\[x\\]");
  });
});

describe("tag service", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.papers.bulkAdd([paper("a", ["ML", "待读"]), paper("b", ["ml"]), paper("c")]);
  });

  it("adds, removes and replaces tags on one paper", async () => {
    expect(await addPaperTags("c", ["#新", "新", "Ml"])).toBe(2);
    expect((await db.papers.get("c"))!.tags).toEqual(["新", "Ml"]);
    expect(await addPaperTags("c", ["ML"])).toBe(0);
    await removePaperTag("c", "新");
    await removePaperTag("c", "ml");
    expect("tags" in (await db.papers.get("c"))!).toBe(false);
    await setPaperTags("a", ["x", "X", ""]);
    expect((await db.papers.get("a"))!.tags).toEqual(["x"]);
    await setPaperTags("a", []);
    expect("tags" in (await db.papers.get("a"))!).toBe(false);
  });

  it("updatePaperMetadata tagChanges applies only the form's edits to the current tags", async () => {
    // 打开对话框时是 ["ML", "待读"]，期间别处加了 "新"；表单里删了 "待读"、加了 "综述"，又把 ml 改成大写写法
    await addPaperTags("a", ["新"]);
    await updatePaperMetadata("a", { year: 2020, tagChanges: { add: ["综述", "ML"], remove: ["待读", "ml"] } });
    const a = (await db.papers.get("a"))!;
    expect(a.tags).toEqual(["ML", "新", "综述"]);
    expect(a.year).toBe(2020);
    await updatePaperMetadata("a", { tagChanges: { add: [], remove: ["ml", "新", "综述"] } });
    expect("tags" in (await db.papers.get("a"))!).toBe(false);
  });

  it("updatePaperMetadata normalizes tags and clears with []", async () => {
    await updatePaperMetadata("b", { tags: ["  a ", "A", "b"] });
    expect((await db.papers.get("b"))!.tags).toEqual(["a", "b"]);
    await updatePaperMetadata("b", { title: "T" });
    expect((await db.papers.get("b"))!.tags).toEqual(["a", "b"]);
    await updatePaperMetadata("b", { tags: [] });
    expect("tags" in (await db.papers.get("b"))!).toBe(false);
  });

  it("renames and deletes across the library", async () => {
    expect(await renameTag("ml", "机器学习")).toBe(2);
    expect((await db.papers.get("a"))!.tags).toEqual(["机器学习", "待读"]);
    expect((await db.papers.get("b"))!.tags).toEqual(["机器学习"]);
    expect(await renameTag("待读", "机器学习")).toBe(1); // 合并
    expect((await db.papers.get("a"))!.tags).toEqual(["机器学习"]);
    await expect(renameTag("机器学习", " # ")).rejects.toThrow();
    expect(await deleteTag("机器学习")).toBe(2);
    expect("tags" in (await db.papers.get("a"))!).toBe(false);
    expect("tags" in (await db.papers.get("b"))!).toBe(false);
  });
});

describe("autocomplete and colors", () => {
  const all = [
    { name: "Deep Learning", count: 2 },
    { name: "deep RL", count: 5 },
    { name: "待读", count: 3 },
    { name: "综述", count: 3 },
  ];

  it("suggests by case-insensitive substring, excluding the paper's tags, most used first", () => {
    expect(suggestTags(all, "DEEP").map((t) => t.name)).toEqual(["deep RL", "Deep Learning"]);
    expect(suggestTags(all, "deep", ["DEEP rl"]).map((t) => t.name)).toEqual(["Deep Learning"]);
    // 空输入：全部，按论文数、再按名称
    expect(suggestTags(all, "").map((t) => t.name)).toEqual(["deep RL", "待读", "综述", "Deep Learning"]);
    expect(suggestTags(all, "", [], 2)).toHaveLength(2);
    // 完全相同的排最前；开头的 # 忽略
    expect(suggestTags(all, "#deep learning").map((t) => t.name)).toEqual(["Deep Learning"]);
    expect(suggestTags([...all, { name: "读", count: 1 }], "读").map((t) => t.name)).toEqual(["读", "待读"]);
  });

  it("finds an existing tag case-insensitively", () => {
    expect(findTag(all, "deep learning")?.name).toBe("Deep Learning");
    expect(findTag(all, " #待读 ")?.name).toBe("待读");
    expect(findTag(all, "")).toBeUndefined();
    expect(findTag(all, "nope")).toBeUndefined();
  });

  it("colors are stable and case-insensitive", () => {
    expect(tagColorIndex("Deep Learning", 8)).toBe(tagColorIndex("deep learning", 8));
    expect(tagColorIndex("待读", 8)).toBe(tagColorIndex("待读", 8));
    const used = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "待读", "综述", "方法"].map((t) => tagColorIndex(t, 8)));
    expect(used.size).toBeGreaterThan(3);
    for (const i of used) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(8);
    }
  });

  it("compares tag lists by content", () => {
    expect(sameTagInfos(all, all.map((t) => ({ ...t })))).toBe(true);
    expect(sameTagInfos(all, all.slice(1))).toBe(false);
    expect(sameTagInfos([{ name: "a", count: 1 }], [{ name: "a", count: 2 }])).toBe(false);
  });
});
