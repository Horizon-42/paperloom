import { beforeEach, describe, expect, it } from "vitest";
import "@/components/term/glossary/register";
import { useAppStore } from "@/app/stores/app";
import { useGlossaryStore } from "@/app/stores/glossary";
import { getSearchProvider, parseQuery, runSearch } from "@/components/library/search";
import { db } from "@/db/schema";
import { mkTerm } from "../indexer/fixtures";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await db.terms.bulkPut([
    mkTerm("a", "Long Short-Term Memory", ["LSTM"], { note: "适合短时预测" }),
    mkTerm("b", "LSTM encoder", []),
    mkTerm("c", "Transformer", ["TF"], { note: "比 LSTM 更擅长长序列" }),
    mkTerm("d", "air traffic management", ["ATM"]),
  ]);
});

describe("术语搜索提供者", () => {
  it("匹配名称、别名、笔记；名称/别名完全匹配排在前面，只在笔记中命中的带片段", async () => {
    const p = getSearchProvider("term")!;
    expect(p.label).toBe("术语");
    const hits = await p.search(parseQuery("lstm"));
    expect(hits.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(hits[0]).toMatchObject({ kind: "term", title: "Long Short-Term Memory", subtitle: "LSTM" });
    expect(hits[2].snippet).toContain("LSTM");
    expect(hits[0].snippet).toBeUndefined();
  });

  it("出现在全局搜索的分组里", async () => {
    const groups = await runSearch("短时");
    expect(groups.find((g) => g.kind === "term")?.hits.map((h) => h.id)).toEqual(["a"]);
  });

  it("激活结果：切到术语表并选中该术语", async () => {
    useAppStore.getState().setView("reader");
    getSearchProvider("term")!.activate({ kind: "term", id: "c", title: "Transformer" });
    expect(useAppStore.getState().view).toBe("glossary");
    expect(useGlossaryStore.getState().selectedTermId).toBe("c");
    expect(useGlossaryStore.getState().reveal?.termId).toBe("c");
  });
});
