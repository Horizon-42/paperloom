// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import { getTermDisplay } from "@/db/repo/terms";
import {
  cleanAliases,
  createTerm,
  deleteTerm,
  normalizeTermInput,
  setTermDisplaySettings,
  updateTerm,
  type TermInput,
} from "@/services/termService";
import { createLink, deleteLink, listLinksFor, otherEnd, resolveEntities, searchEntities } from "@/services/linkService";
import { matchSignature } from "@/components/term/runtime";
import { useTermUiStore } from "@/app/stores/termUi";
import type { SelectionAnchor, Term } from "@/types/models";

const input = (over: Partial<TermInput> = {}): TermInput => ({
  name: "Long Short-Term Memory",
  aliases: ["LSTM"],
  matchMode: "auto",
  scope: { kind: "global" },
  note: "",
  ...over,
});

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe("termService", () => {
  it("normalizeTermInput 清理名称和别名，名称为空时报错", () => {
    expect(normalizeTermInput(input({ name: "  Long   Short-Term\nMemory ", aliases: [" LSTM", "LSTM", "", "Long Short-Term Memory", "LSTMs "] }))).toEqual({
      name: "Long Short-Term Memory",
      aliases: ["LSTM", "LSTMs"],
      matchMode: "auto",
      scope: { kind: "global" },
      note: "",
    });
    expect(() => normalizeTermInput(input({ name: "   " }))).toThrow("名称");
    expect(normalizeTermInput(input({ scope: { kind: "domains", domainIds: ["a", "a", "b"] } })).scope).toEqual({ kind: "domains", domainIds: ["a", "b"] });
    expect(cleanAliases(["ATM", "atm", "ATM"], "x")).toEqual(["ATM", "atm"]);
    // 只有零宽字符的形式规范化后为空：别名丢弃，名称报错
    expect(cleanAliases(["\u200b\u200b", "LSTM"], "x")).toEqual(["LSTM"]);
    expect(() => normalizeTermInput(input({ name: "\u200b" }))).toThrow("名称");
  });

  it("createTerm 带出处时创建批注并互相关联", async () => {
    const source: SelectionAnchor = {
      paperId: "p1",
      page: 2,
      rects: [[1, 2, 3, 4]],
      quote: { exact: "LSTM", prefix: "a ", suffix: " b" },
      fileHash: "h",
    };
    const t = await createTerm(input({ name: " LSTM network " }), source);
    expect(t.name).toBe("LSTM network");
    const ann = await db.annotations.get(t.sourceAnnotationId!);
    expect(ann).toMatchObject({ paperId: "p1", page: 2, termId: t.id });
  });

  it("updateTerm 清理别名（与新名称相同的去掉），名称不能改为空", async () => {
    const t = await createTerm(input());
    await updateTerm(t.id, { name: "LSTM", aliases: ["LSTM", "Long Short-Term Memory"] });
    expect(await db.terms.get(t.id)).toMatchObject({ name: "LSTM", aliases: ["Long Short-Term Memory"] });
    await updateTerm(t.id, { aliases: [" LSTMs ", "LSTM"] });
    expect((await db.terms.get(t.id))!.aliases).toEqual(["LSTMs"]);
    await expect(updateTerm(t.id, { name: " " })).rejects.toThrow("名称");
    await updateTerm(t.id, { note: "笔记" });
    expect((await db.terms.get(t.id))!.note).toBe("笔记");
  });

  it("deleteTerm 删除相关连线、解除出处批注关联", async () => {
    const t = await createTerm(input(), { paperId: "p", page: 1, rects: [], quote: { exact: "x", prefix: "", suffix: "" }, fileHash: "h" });
    const other = await createTerm(input({ name: "Transformer", aliases: [] }));
    await createLink({ from: { kind: "term", id: t.id }, to: { kind: "term", id: other.id }, relation: "compares" });
    await createLink({ from: { kind: "annotation", id: "a1" }, to: { kind: "term", id: other.id }, relation: "supports" });
    await deleteTerm(t.id);
    expect(await db.terms.get(t.id)).toBeUndefined();
    expect(await db.links.count()).toBe(1);
    expect((await db.annotations.get(t.sourceAnnotationId!))!.termId).toBeUndefined();
  });

  it("显示设置：合并写入、读取时补全", async () => {
    expect(await getTermDisplay()).toEqual({ firstOnly: false, hidden: false });
    await setTermDisplaySettings({ firstOnly: true });
    await setTermDisplaySettings({ hidden: true });
    expect(await getTermDisplay()).toEqual({ firstOnly: true, hidden: true });
    await db.kv.put({ key: "termDisplay", value: "garbage" });
    expect(await getTermDisplay()).toEqual({ firstOnly: false, hidden: false });
  });
});

describe("linkService", () => {
  const term = { kind: "term", id: "t1" } as const;

  it("createLink 去重、拒绝自连、自定义关系带标签", async () => {
    const a = await createLink({ from: term, to: { kind: "paper", id: "p1" }, relation: "supports", label: " " });
    const b = await createLink({ from: term, to: { kind: "paper", id: "p1" }, relation: "supports" });
    expect(b.id).toBe(a.id);
    expect(a.label).toBeUndefined();
    await expect(createLink({ from: term, to: term, relation: "extends" })).rejects.toThrow();
    const c = await createLink({ from: { kind: "annotation", id: "a1" }, to: term, relation: "custom", label: "举例" });
    expect(c.label).toBe("举例");
    expect(await db.links.count()).toBe(2);
  });

  it("listLinksFor 两个方向、按 kind 区分同 id 的实体", async () => {
    await createLink({ from: term, to: { kind: "paper", id: "p1" }, relation: "supports" });
    await createLink({ from: { kind: "annotation", id: "a1" }, to: term, relation: "extends" });
    // 同 id 的论文（不是这个术语）
    await createLink({ from: { kind: "paper", id: "t1" }, to: { kind: "paper", id: "p2" }, relation: "compares" });
    const links = await listLinksFor(term);
    expect(links.map((l) => otherEnd(l, term))).toEqual([
      { kind: "paper", id: "p1" },
      { kind: "annotation", id: "a1" },
    ]);
    await deleteLink(links[0].id);
    expect(await listLinksFor(term)).toHaveLength(1);
  });

  it("resolveEntities / searchEntities", async () => {
    const now = Date.now();
    await db.papers.add({ id: "p1", fileHash: "h", title: "Attention Is All You Need", authors: ["Vaswani"], year: 2017, domainIds: [], pageCount: 1, addedAt: now });
    await db.terms.add({ id: "t1", name: "Transformer", aliases: ["TF"], matchMode: "auto", scope: { kind: "global" }, note: "attention only", createdAt: now, updatedAt: now } as Term);
    await db.annotations.add({
      id: "a1",
      paperId: "p1",
      page: 3,
      rects: [[10, 20, 30, 40]],
      quote: { exact: "multi-head attention", prefix: "", suffix: "" },
      fileHash: "h",
      color: "#fde68a",
      note: "",
      createdAt: now,
      updatedAt: now,
    });
    const r = await resolveEntities([{ kind: "annotation", id: "a1" }, { kind: "note", id: "gone" }]);
    expect(r.get("annotation:a1")).toMatchObject({ title: "multi-head attention", paperId: "p1", page: 3, pdfPoint: [10, 40] });
    expect(r.get("note:gone")!.missing).toBe(true);
    const hits = await searchEntities("attention", { exclude: [{ kind: "term", id: "t1" }] });
    expect(hits.map((h) => `${h.ref.kind}:${h.ref.id}`)).toEqual(["annotation:a1", "paper:p1"]);
    expect((await searchEntities("TF")).map((h) => h.ref.id)).toEqual(["t1"]);
    expect(await searchEntities("  ")).toEqual([]);
  });
});

describe("runtime / termUi", () => {
  it("matchSignature 只随匹配相关字段变化", () => {
    const t: Term = { id: "a", name: "LSTM", aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 1, updatedAt: 1 };
    const sig = matchSignature([t]);
    expect(matchSignature([{ ...t, note: "x", updatedAt: 2 }])).toBe(sig);
    expect(matchSignature([{ ...t, aliases: ["L"] }])).not.toBe(sig);
    expect(matchSignature([{ ...t, scope: { kind: "domains", domainIds: ["b", "a"] } }])).toBe(
      matchSignature([{ ...t, scope: { kind: "domains", domainIds: ["a", "b"] } }]),
    );
  });

  it("termUi：打开编辑器收起弹窗；关闭弹窗时取消随弹窗移动的定位", () => {
    const s = useTermUiStore.getState;
    const anchor = { paneId: "left" as const, paperId: "p", page: 1, start: 0, end: 4, seg: 0 };
    s().openPopover({ mode: "edit", termIds: ["a", "b"], activeTermId: "a", anchor });
    const seq = s().popover!.seq;
    s().setActiveTerm("b");
    s().moveAnchor({ ...anchor, page: 2 });
    expect(s().popover).toMatchObject({ seq, activeTermId: "b", anchor: { page: 2 } });
    s().requestFlash({ paneId: "left", paperId: "p", page: 3, termId: "b", movePopover: true });
    s().closePopover();
    expect(s().popover).toBeNull();
    expect(s().flash).toBeNull();
    const f = s().requestFlash({ paneId: "left", paperId: "p", page: 3, termId: "b" });
    s().clearFlash(f - 1);
    expect(s().flash).not.toBeNull();
    s().clearFlash(f);
    expect(s().flash).toBeNull();
    s().openPopover({ mode: "preview", termIds: ["a"], activeTermId: "a", anchor });
    s().openTermEditor({ termId: "a" });
    expect(s().popover).toBeNull();
    expect(s().editor).toEqual({ termId: "a" });
  });
});
