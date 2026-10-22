// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import {
  STAMP_PREFIX,
  TERM_STATS_KEY,
  getIndexStamps,
  getOutdatedPaperIds,
  getTermStatsRecord,
  listAllOccurrences,
  listOccurrencesForPaper,
  listOccurrencesForTerm,
  replacePaperOccurrences,
  type IndexStamp,
} from "@/db/repo/occurrences";
import { MATCH_VERSION, NORMALIZE_VERSION } from "@/engine/types";
import type { Occurrence } from "@/types/models";
import { resetIndexCoreState, runIndexJob } from "@/workers/indexCore";
import { mkDomain, mkPaper, mkTerm, occOf, putPaperWithTexts } from "./fixtures";

const lstm = mkTerm("lstm", "Long Short-Term Memory", ["LSTM"]);
const atm = mkTerm("atm", "ATM", [], { domains: ["d-atm"] });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetIndexCoreState();
});

const stampOf = (o: Partial<IndexStamp> = {}): IndexStamp => ({
  fileHash: "hash-p",
  normalizeVersion: NORMALIZE_VERSION,
  matchVersion: MATCH_VERSION,
  termsKey: "k",
  scopeKey: "",
  occCount: 1,
  at: 0,
  ...o,
});
const occRow = (termId: string, paperId: string, o: Partial<Occurrence> = {}): Occurrence => ({
  termId,
  paperId,
  pages: [1],
  count: 1,
  engineVersion: MATCH_VERSION,
  ...o,
});

describe("runIndexJob", () => {
  it("扫描有全文的论文并写入 occurrences；缺全文的报告 needsText", async () => {
    await db.terms.bulkPut([lstm, atm]);
    await db.domains.put(mkDomain("d-atm"));
    await putPaperWithTexts(mkPaper("p1", { domainIds: ["d-atm"] }), ["LSTM and ATM", "ATM again"]);
    await putPaperWithTexts(mkPaper("p2"), ["LSTM and ATM"]);
    await db.papers.put(mkPaper("p3", { pageCount: 0 })); // 新导入，还没有全文

    const r = await runIndexJob({ paperIds: null });
    expect(r.cancelled).toBe(false);
    expect(r.needsText).toEqual([{ paperId: "p3", fileHash: "hash-p3", missingFile: true }]);
    expect(r.stats).toMatchObject({ papers: 3, scanned: 2, skipped: 0, pages: 3 });
    expect(await occOf("p1")).toEqual({ lstm: { pages: [1], count: 1 }, atm: { pages: [1, 2], count: 2 } });
    // p2 不在 ATM 领域
    expect(await occOf("p2")).toEqual({ lstm: { pages: [1], count: 1 } });
    const rows = await db.occurrences.toArray();
    expect(rows.every((o) => o.engineVersion === MATCH_VERSION)).toBe(true);
  });

  it("缺全文时区分 PDF 文件是否存在", async () => {
    await db.papers.put(mkPaper("with-file", { pageCount: 0 }));
    await db.files.put({ hash: "hash-with-file", blob: new Blob(["%PDF-"]), size: 5 });
    await db.papers.put(mkPaper("no-file", { pageCount: 0 }));
    const r = await runIndexJob({ paperIds: ["with-file", "no-file"] });
    expect([...r.needsText].sort((a, b) => a.paperId.localeCompare(b.paperId))).toEqual([
      { paperId: "no-file", fileHash: "hash-no-file", missingFile: true },
      { paperId: "with-file", fileHash: "hash-with-file" },
    ]);
  });

  it("全文与文件不符或规范化版本过期时不使用", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("a"), ["LSTM"], { fileHash: "other" });
    await putPaperWithTexts(mkPaper("b"), ["LSTM"], { normalizeVersion: NORMALIZE_VERSION - 1 });
    const r = await runIndexJob({ paperIds: null });
    expect(r.needsText.map((n) => n.paperId).sort()).toEqual(["a", "b"]);
    expect(await db.occurrences.count()).toBe(0);
  });

  it("扫描戳一致时跳过；改别名后重扫；只改笔记不重扫", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("p"), ["LSTM networks and RNN"]);
    await runIndexJob({ paperIds: null });

    let r = await runIndexJob({ paperIds: null });
    expect(r.stats).toMatchObject({ scanned: 0, skipped: 1 });

    await db.terms.update("lstm", { note: "笔记", updatedAt: 5 });
    r = await runIndexJob({ paperIds: null });
    expect(r.stats).toMatchObject({ scanned: 0, skipped: 1 });

    await db.terms.update("lstm", { aliases: ["LSTM", "RNN"] });
    r = await runIndexJob({ paperIds: null });
    expect(r.stats).toMatchObject({ scanned: 1, skipped: 0 });
    expect(await occOf("p")).toEqual({ lstm: { pages: [1], count: 2 } });
  });

  it("论文换领域：只有生效的限定领域术语变化时才重扫", async () => {
    await db.terms.bulkPut([lstm, atm]);
    await db.domains.bulkPut([mkDomain("d-atm"), mkDomain("d-traj", "d-atm"), mkDomain("d-nlp")]);
    await putPaperWithTexts(mkPaper("p"), ["ATM LSTM"]);
    await runIndexJob({ paperIds: null });
    expect(Object.keys(await occOf("p"))).toEqual(["lstm"]);

    await db.papers.update("p", { domainIds: ["d-nlp"] });
    let r = await runIndexJob({ paperIds: ["p"] });
    expect(r.stats.skipped).toBe(1);

    await db.papers.update("p", { domainIds: ["d-traj"] });
    r = await runIndexJob({ paperIds: ["p"] });
    expect(r.stats.scanned).toBe(1);
    expect(Object.keys(await occOf("p")).sort()).toEqual(["atm", "lstm"]);

    // 领域树调整：d-traj 移出 d-atm
    await db.domains.update("d-traj", { parentId: null });
    r = await runIndexJob({ paperIds: null });
    expect(r.stats.scanned).toBe(1);
    expect(Object.keys(await occOf("p"))).toEqual(["lstm"]);
  });

  it("只写有变化的记录，删除不再出现的记录", async () => {
    const tf = mkTerm("tf", "transformer");
    await db.terms.bulkPut([lstm, tf]);
    await putPaperWithTexts(mkPaper("p"), ["LSTM transformer", "LSTM"]);
    let r = await runIndexJob({ paperIds: null });
    expect(r.stats).toMatchObject({ written: 2, deleted: 0 });

    // 新术语：其他术语的记录不变，不重写
    await db.terms.put(mkTerm("rnn", "RNN"));
    r = await runIndexJob({ paperIds: null });
    expect(r.stats).toMatchObject({ scanned: 1, written: 0, deleted: 0 });

    await db.terms.update("tf", { name: "attention" });
    r = await runIndexJob({ paperIds: null });
    expect(r.stats).toMatchObject({ written: 0, deleted: 1 });
    expect(await occOf("p")).toEqual({ lstm: { pages: [1, 2], count: 2 } });
  });

  it("删除术语后重扫会清掉它留下的记录", async () => {
    await db.terms.bulkPut([lstm, mkTerm("mem", "memory")]);
    await putPaperWithTexts(mkPaper("p"), ["Long Short-Term Memory and memory"]);
    await runIndexJob({ paperIds: null });
    expect(await occOf("p")).toEqual({ lstm: { pages: [1], count: 1 }, mem: { pages: [1], count: 1 } });
    // 模拟扫描期间写入的孤儿记录：术语已删除但记录还在
    await db.terms.delete("lstm");
    await runIndexJob({ paperIds: null });
    // 长术语没了，"Memory" 不再被它覆盖
    expect(await occOf("p")).toEqual({ mem: { pages: [1], count: 2 } });
  });

  it("自检：occurrences 被外部清掉时重算；旧版本记录只在启动后第一次全库任务里检查", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("p"), ["LSTM"]);
    await runIndexJob({ paperIds: null });

    await db.occurrences.clear();
    let r = await runIndexJob({ paperIds: null });
    expect(r.stats.scanned).toBe(1);
    expect(await db.occurrences.count()).toBe(1);

    // 扫描戳一致但记录是旧版本（如从备份恢复）：本次会话已检查过，不再全表扫描
    await db.occurrences.update(["lstm", "p"], { engineVersion: MATCH_VERSION - 1 });
    r = await runIndexJob({ paperIds: null });
    expect(r.stats.scanned).toBe(0);
    // 重新启动后的第一次全库任务会发现并重扫
    resetIndexCoreState();
    r = await runIndexJob({ paperIds: null });
    expect(r.stats.scanned).toBe(1);
    expect((await db.occurrences.get(["lstm", "p"]))?.engineVersion).toBe(MATCH_VERSION);
  });

  it("旧版本记录的强制重扫在任务被取消后仍保留到下一次任务", async () => {
    await db.terms.put(lstm);
    for (const id of ["a", "b"]) await putPaperWithTexts(mkPaper(id), ["LSTM"]);
    await runIndexJob({ paperIds: null });
    await db.occurrences.toCollection().modify({ engineVersion: MATCH_VERSION - 1 });
    resetIndexCoreState();
    const first = await runIndexJob({ paperIds: null }, { isCancelled: () => true });
    expect(first).toMatchObject({ cancelled: true, stats: { scanned: 0 } });
    const r = await runIndexJob({ paperIds: ["a", "b"] });
    expect(r.stats.scanned).toBe(2);
  });

  it("换过文件且新全文还没提取时，旧的出现位置作废", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("p"), ["LSTM"]);
    await runIndexJob({ paperIds: null });
    expect(await db.occurrences.count()).toBe(1);

    await db.papers.update("p", { fileHash: "new-hash" });
    const r = await runIndexJob({ paperIds: ["p"] });
    expect(r.needsText).toEqual([{ paperId: "p", fileHash: "new-hash", missingFile: true }]);
    expect(await db.occurrences.count()).toBe(0);
    expect((await getIndexStamps(["p"])).size).toBe(0);
  });

  it("写入时论文已删除或换了文件则放弃", async () => {
    await db.papers.put(mkPaper("p"));
    await db.terms.put(mkTerm("t", "t"));
    const stamp = stampOf();
    const row = occRow("t", "p");
    expect(await replacePaperOccurrences({ id: "p", fileHash: "stale" }, [row], stamp)).toBeNull();
    expect(await replacePaperOccurrences({ id: "gone", fileHash: "hash-gone" }, [{ ...row, paperId: "gone" }], stamp)).toBeNull();
    expect(await db.occurrences.count()).toBe(0);
    expect(await replacePaperOccurrences({ id: "p", fileHash: "hash-p" }, [row], stamp)).toEqual({ written: 1, deleted: 0, droppedTerms: 0 });
  });

  it("扫描期间被删除的术语：写入时丢弃它的记录，不留孤儿（#8）", async () => {
    await db.papers.put(mkPaper("p"));
    await db.terms.bulkPut([mkTerm("a", "a"), mkTerm("b", "b")]);
    // 扫描用的是开始时的术语快照，写入前 b 被删除
    await db.terms.delete("b");
    const w = await replacePaperOccurrences({ id: "p", fileHash: "hash-p" }, [occRow("a", "p"), occRow("b", "p")], stampOf({ occCount: 2 }));
    expect(w).toEqual({ written: 1, deleted: 0, droppedTerms: 1 });
    expect((await db.occurrences.toArray()).map((o) => o.termId)).toEqual(["a"]);
    // 扫描戳记录的是实际写入的行数，下次校验不会误判
    expect((await getIndexStamps(["p"])).get("p")?.occCount).toBe(1);
  });

  it("全库扫描时删除已不存在的论文的扫描戳", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("p"), ["LSTM"]);
    await putPaperWithTexts(mkPaper("q"), ["LSTM"]);
    await runIndexJob({ paperIds: null });
    expect((await getIndexStamps()).size).toBe(2);
    await db.papers.delete("q");
    await runIndexJob({ paperIds: null });
    expect([...(await getIndexStamps()).keys()]).toEqual(["p"]);
  });

  it("取消：在论文之间检查，返回 cancelled", async () => {
    await db.terms.put(lstm);
    for (const id of ["a", "b", "c"]) await putPaperWithTexts(mkPaper(id), ["LSTM"]);
    let calls = 0;
    const progress: number[] = [];
    const r = await runIndexJob(
      { paperIds: null },
      { isCancelled: () => ++calls > 1, onProgress: (done) => progress.push(done) },
    );
    expect(r.cancelled).toBe(true);
    expect(r.stats.scanned).toBe(1);
    expect(progress).toEqual([0, 1]);
  });

  it("按优先列表的顺序扫描，报告不存在的论文时忽略", async () => {
    await db.terms.put(lstm);
    for (const id of ["a", "b", "c"]) await db.papers.put(mkPaper(id, { pageCount: 0 }));
    const r = await runIndexJob({ paperIds: ["a", "b", "c", "missing"], priority: ["c", "b"] });
    expect(r.needsText.map((n) => n.paperId)).toEqual(["c", "b", "a"]);
    expect(r.stats.papers).toBe(3);
  });
});

describe("规则版本拆分（#2）", () => {
  it("扫描戳同时记录规范化和匹配规则版本", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("p"), ["LSTM"]);
    await runIndexJob({ paperIds: null });
    expect((await getIndexStamps(["p"])).get("p")).toMatchObject({ normalizeVersion: NORMALIZE_VERSION, matchVersion: MATCH_VERSION });
  });

  it("只有匹配规则变化：用缓存的全文重扫，不需要重新提取", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("p"), ["LSTM"]);
    await runIndexJob({ paperIds: null });
    // 模拟上次扫描用的是旧匹配规则
    await db.kv.update(STAMP_PREFIX + "p", (r) => {
      (r.value as IndexStamp).matchVersion = MATCH_VERSION - 1;
    });
    await db.occurrences.toCollection().modify({ engineVersion: MATCH_VERSION - 1 });
    const r = await runIndexJob({ paperIds: ["p"] });
    expect(r.needsText).toEqual([]);
    expect(r.stats.scanned).toBe(1);
    expect((await db.occurrences.toArray()).map((o) => o.engineVersion)).toEqual([MATCH_VERSION]);
  });

  it("规范化规则变化：报告缺全文，重新提取前保留旧结果，提取后重扫替换", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("p"), ["LSTM"], { normalizeVersion: NORMALIZE_VERSION - 1 });
    // 旧版本全文上算出的结果和扫描戳
    await db.occurrences.put(occRow("lstm", "p", { count: 3 }));
    await db.kv.put({ key: STAMP_PREFIX + "p", value: stampOf({ normalizeVersion: NORMALIZE_VERSION - 1 }) });
    expect(await getOutdatedPaperIds(["p"])).toEqual(new Set(["p"]));

    let r = await runIndexJob({ paperIds: ["p"] });
    expect(r.needsText.map((n) => n.paperId)).toEqual(["p"]);
    // 过渡期：旧记录仍在，界面照常显示（标为待更新）
    expect(await listOccurrencesForTerm("lstm")).toMatchObject([{ paperId: "p", count: 3 }]);

    await putPaperWithTexts(mkPaper("p"), ["LSTM LSTM"]);
    r = await runIndexJob({ paperIds: ["p"] });
    expect(r.stats.scanned).toBe(1);
    expect(await occOf("p")).toEqual({ lstm: { pages: [1], count: 2 } });
    expect(await getOutdatedPaperIds(["p"])).toEqual(new Set());
  });

  it("界面读取在过渡期返回旧版本记录（不变空），由扫描戳判断哪些待更新", async () => {
    await db.occurrences.bulkPut([occRow("a", "p"), occRow("b", "p", { engineVersion: MATCH_VERSION - 1 })]);
    expect((await listAllOccurrences()).map((o) => o.termId)).toEqual(["a", "b"]);
    expect((await listOccurrencesForPaper("p")).map((o) => o.termId)).toEqual(["a", "b"]);
    expect(await listOccurrencesForTerm("b")).toHaveLength(1);
    await db.kv.bulkPut([
      { key: STAMP_PREFIX + "new", value: stampOf() },
      { key: STAMP_PREFIX + "old", value: { fileHash: "h", engineVersion: 1, termsKey: "k", scopeKey: "", occCount: 1, at: 0 } },
    ]);
    expect(await getOutdatedPaperIds(["new", "old", "none"])).toEqual(new Set(["old", "none"]));
  });
});

describe("孤儿记录与术语统计（#3、#5）", () => {
  it("全库任务删除论文或术语已不存在的记录；单篇任务不做", async () => {
    await db.terms.put(lstm);
    await putPaperWithTexts(mkPaper("p"), ["LSTM"]);
    await runIndexJob({ paperIds: null });
    await db.occurrences.bulkPut([occRow("lstm", "gone-paper"), occRow("gone-term", "p")]);

    // 单篇任务：p 的行数对不上，重扫时顺带去掉 p 名下已删除术语的记录；不管别的论文
    let r = await runIndexJob({ paperIds: ["p"] });
    expect(r.stats.orphans).toBe(0);
    expect((await db.occurrences.toArray()).map((o) => [o.termId, o.paperId])).toEqual([
      ["lstm", "gone-paper"],
      ["lstm", "p"],
    ]);

    await db.occurrences.put(occRow("gone-term", "p"));
    r = await runIndexJob({ paperIds: null });
    expect(r.stats.orphans).toBe(2);
    expect((await db.occurrences.toArray()).map((o) => [o.termId, o.paperId])).toEqual([["lstm", "p"]]);
  });

  it("统计随写入增量维护，与全表汇总一致；外部删除后由行数校验发现并重建", async () => {
    const tf = mkTerm("tf", "transformer");
    await db.terms.bulkPut([lstm, tf]);
    await putPaperWithTexts(mkPaper("a"), ["LSTM transformer", "LSTM"]);
    await putPaperWithTexts(mkPaper("b"), ["transformer transformers"]);
    await runIndexJob({ paperIds: null });
    expect((await getTermStatsRecord())?.stats).toEqual({ lstm: [1, 2], tf: [2, 3] });

    // 增量：改别名、重扫（不重建）
    await db.terms.update("lstm", { aliases: ["LSTM", "transformer"] });
    await runIndexJob({ paperIds: null });
    const fromRows = async () => {
      const out: Record<string, [number, number]> = {};
      for (const o of await db.occurrences.toArray()) {
        const s = (out[o.termId] ??= [0, 0]);
        s[0]++;
        s[1] += o.count;
      }
      return out;
    };
    const rec = await getTermStatsRecord();
    expect(rec?.stats).toEqual(await fromRows());
    expect(rec?.rows).toBe(await db.occurrences.count());

    // 外部删除（如删论文的级联删除）：下一次任务开头重建
    await db.papers.delete("b");
    await db.occurrences.where("paperId").equals("b").delete();
    await runIndexJob({ paperIds: ["b"] });
    expect((await getTermStatsRecord())?.stats).toEqual(await fromRows());
  });

  it("重建统计时忽略论文或术语已不存在的记录", async () => {
    await db.papers.put(mkPaper("p"));
    await db.terms.put(mkTerm("t", "t"));
    await db.occurrences.bulkPut([occRow("t", "p", { count: 4 }), occRow("t", "gone"), occRow("x", "p")]);
    await db.kv.delete(TERM_STATS_KEY);
    await runIndexJob({ paperIds: ["p"] });
    const rec = await getTermStatsRecord();
    expect(rec).toEqual({ rows: 3, stats: { t: [1, 4] } });
  });
});
