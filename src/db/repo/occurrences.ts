// occurrences 表的读写，以及后台索引在 kv 表里的派生数据：
//   indexer:paper:<id>  每篇论文的扫描戳
//   indexer:termStats   每个术语的出现统计（论文数、总次数），随写入增量维护
// 写操作只由索引 Worker 调用；界面只读。
import { db } from "@/db/schema";
import { MATCH_VERSION, NORMALIZE_VERSION } from "@/engine/types";
import type { Occurrence, Paper } from "@/types/models";

/**
 * 某篇论文上一次扫描时的输入摘要。与当前输入一致（且 occurrences 行数对得上）就不必重扫。
 * 属于派生数据：导出备份时可以忽略，丢失后只会触发一次重扫。
 */
export interface IndexStamp {
  fileHash: string;
  /** 扫描所用全文的规范化规则版本；变化时需要重新提取全文再重扫 */
  normalizeVersion: number;
  /** 匹配规则版本；变化时用缓存的全文重扫即可 */
  matchVersion: number;
  /** 全部术语中影响匹配的字段的摘要 */
  termsKey: string;
  /** 对这篇论文生效的"限定领域"术语集合的摘要（随论文领域、领域树变化） */
  scopeKey: string;
  /** 写入的 occurrences 行数，用于发现被外部清掉的缓存 */
  occCount: number;
  at: number;
}

export const STAMP_PREFIX = "indexer:paper:";
const stampKey = (paperId: string) => STAMP_PREFIX + paperId;

/** 扫描戳是否对应当前的规则版本（旧格式的扫描戳没有这两个字段，视为过期） */
export function isStampCurrent(s: Pick<IndexStamp, "normalizeVersion" | "matchVersion"> | undefined): boolean {
  return !!s && s.normalizeVersion === NORMALIZE_VERSION && s.matchVersion === MATCH_VERSION;
}

/**
 * 每个术语的出现统计。rows 是写入时记录的 occurrences 总行数：
 * 与表的实际行数不符说明有别的模块删过记录（删论文、删术语、换文件），需要重建。
 */
export interface TermStatsRecord {
  rows: number;
  /** termId → [论文数, 总次数] */
  stats: Record<string, [number, number]>;
}

export const TERM_STATS_KEY = "indexer:termStats";

// ---------- 读（界面用） ----------
// 规则版本变化后，旧记录在新结果写入前继续返回（界面标为"待更新"），不让"出现在哪些论文"变空。

export function listOccurrencesForTerm(termId: string): Promise<Occurrence[]> {
  return db.occurrences.where("termId").equals(termId).toArray();
}

export function listOccurrencesForPaper(paperId: string): Promise<Occurrence[]> {
  return db.occurrences.where("paperId").equals(paperId).toArray();
}

export function listAllOccurrences(): Promise<Occurrence[]> {
  return db.occurrences.toArray();
}

/** 这些论文中结果来自旧规则版本（或还没有扫描戳）的那些 */
export async function getOutdatedPaperIds(paperIds: string[]): Promise<Set<string>> {
  const stamps = await getIndexStamps(paperIds);
  return new Set(paperIds.filter((id) => !isStampCurrent(stamps.get(id))));
}

export async function getTermStatsRecord(): Promise<TermStatsRecord | undefined> {
  return (await db.kv.get(TERM_STATS_KEY))?.value as TermStatsRecord | undefined;
}

/** 含过期记录的行数（与扫描戳的 occCount 对照） */
export function countOccurrencesForPaper(paperId: string): Promise<number> {
  return db.occurrences.where("paperId").equals(paperId).count();
}

/** 含有过期 engineVersion 记录的论文（全表扫描，较慢） */
export async function listPaperIdsWithStaleOccurrences(): Promise<Set<string>> {
  const out = new Set<string>();
  await db.occurrences
    .filter((o) => o.engineVersion !== MATCH_VERSION)
    .each((o) => {
      out.add(o.paperId);
    });
  return out;
}

/** paperIds 缺省时返回全部扫描戳 */
export async function getIndexStamps(paperIds?: string[]): Promise<Map<string, IndexStamp>> {
  const out = new Map<string, IndexStamp>();
  if (paperIds) {
    if (!paperIds.length) return out;
    const rows = await db.kv.bulkGet(paperIds.map(stampKey));
    rows.forEach((r, i) => {
      if (r) out.set(paperIds[i], r.value as IndexStamp);
    });
  } else {
    await db.kv
      .where("key")
      .startsWith(STAMP_PREFIX)
      .each((r) => {
        out.set(r.key.slice(STAMP_PREFIX.length), r.value as IndexStamp);
      });
  }
  return out;
}

// ---------- 写 ----------

function sameOccurrence(a: Occurrence, b: Occurrence): boolean {
  if (a.count !== b.count || a.engineVersion !== b.engineVersion || a.pages.length !== b.pages.length) return false;
  for (let i = 0; i < a.pages.length; i++) if (a.pages[i] !== b.pages[i]) return false;
  return true;
}

function bump(stats: TermStatsRecord["stats"], termId: string, papers: number, count: number) {
  const s = stats[termId] ?? [0, 0];
  s[0] += papers;
  s[1] += count;
  if (s[0] <= 0) delete stats[termId];
  else stats[termId] = s;
}

export interface WriteOutcome {
  written: number;
  deleted: number;
  /** 写入时已不存在、被丢弃的术语 */
  droppedTerms: number;
}

/**
 * 用 rows 替换论文的全部 occurrences，写扫描戳并增量更新术语统计（一个事务）。
 * 只删除不再出现的记录、只写有变化的记录，结果等价于"先删后写"，但不会惊动未变化术语的查询。
 * 论文已被删除或换了文件时不写，返回 null；扫描期间被删除的术语的记录丢弃，不留孤儿。
 */
export async function replacePaperOccurrences(
  paper: Pick<Paper, "id" | "fileHash">,
  rows: Occurrence[],
  stamp: IndexStamp,
): Promise<WriteOutcome | null> {
  return db.transaction("rw", [db.occurrences, db.kv, db.papers, db.terms], async () => {
    const now = await db.papers.get(paper.id);
    if (!now || now.fileHash !== paper.fileHash) return null;
    const existing = await db.occurrences.where("paperId").equals(paper.id).toArray();
    const before = new Map(existing.map((e) => [e.termId, e]));
    const next = new Map(rows.map((r) => [r.termId, r]));
    const drop: Occurrence[] = [];
    for (const e of existing) {
      const n = next.get(e.termId);
      if (!n) drop.push(e);
      else if (sameOccurrence(e, n)) next.delete(e.termId);
    }
    let put = [...next.values()];
    let droppedTerms = 0;
    if (put.length) {
      // 扫描用的是开始时的术语快照：写入前被删除的术语丢弃，不留孤儿。
      // 已有记录不必查：deleteTerm 在同一事务里删掉了它们。一次 getAllKeys，比 anyOf 的逐个跳转游标快得多
      const alive = new Set(await db.terms.toCollection().primaryKeys());
      const n = put.length;
      put = put.filter((r) => alive.has(r.termId));
      droppedTerms = n - put.length;
    }
    if (drop.length) await db.occurrences.bulkDelete(drop.map((e) => [e.termId, e.paperId] as [string, string]));
    if (put.length) await db.occurrences.bulkPut(put);
    const added = put.filter((n) => !before.has(n.termId)).length;
    await db.kv.put({ key: stampKey(paper.id), value: { ...stamp, occCount: existing.length - drop.length + added } });

    if (drop.length || put.length) {
      const rec = await getTermStatsRecord();
      if (rec) {
        for (const e of drop) bump(rec.stats, e.termId, -1, -e.count);
        for (const n of put) {
          const old = before.get(n.termId);
          if (old) bump(rec.stats, n.termId, 0, n.count - old.count);
          else bump(rec.stats, n.termId, 1, n.count);
        }
        rec.rows += added - drop.length;
        await db.kv.put({ key: TERM_STATS_KEY, value: rec });
      }
    }
    return { written: put.length, deleted: drop.length, droppedTerms };
  });
}

/** 清掉论文的 occurrences 和扫描戳（换过文件、旧位置作废时）。统计由下次校验重建 */
export async function clearPaperOccurrences(paperId: string): Promise<void> {
  await db.transaction("rw", db.occurrences, db.kv, async () => {
    await db.occurrences.where("paperId").equals(paperId).delete();
    await db.kv.delete(stampKey(paperId));
  });
}

/** 删除已不存在的论文留下的扫描戳 */
export async function deleteIndexStamps(paperIds: string[]): Promise<void> {
  if (paperIds.length) await db.kv.bulkDelete(paperIds.map(stampKey));
}

/** 删除论文或术语已不存在的记录（只读主键，不读出记录内容）。返回删除的行数 */
export async function deleteOrphanOccurrences(): Promise<number> {
  return db.transaction("rw", [db.occurrences, db.papers, db.terms], async () => {
    const [keys, paperIds, termIds] = await Promise.all([
      db.occurrences.toCollection().primaryKeys(),
      db.papers.toCollection().primaryKeys(),
      db.terms.toCollection().primaryKeys(),
    ]);
    const papers = new Set(paperIds);
    const terms = new Set(termIds);
    const orphans = keys.filter(([t, p]) => !terms.has(t) || !papers.has(p));
    if (orphans.length) await db.occurrences.bulkDelete(orphans);
    return orphans.length;
  });
}

/** 从 occurrences 全表重建术语统计（只统计论文和术语都存在的记录） */
export async function rebuildTermStats(): Promise<TermStatsRecord> {
  const [paperIds, termIds] = await Promise.all([db.papers.toCollection().primaryKeys(), db.terms.toCollection().primaryKeys()]);
  const papers = new Set(paperIds);
  const terms = new Set(termIds);
  return db.transaction("rw", db.occurrences, db.kv, async () => {
    const all = await db.occurrences.toArray();
    const rec: TermStatsRecord = { rows: all.length, stats: {} };
    for (const o of all) if (papers.has(o.paperId) && terms.has(o.termId)) bump(rec.stats, o.termId, 1, o.count);
    await db.kv.put({ key: TERM_STATS_KEY, value: rec });
    return rec;
  });
}

/** 统计记录缺失或行数对不上时重建；返回是否重建了 */
export async function ensureTermStats(): Promise<boolean> {
  const [rec, rows] = await Promise.all([getTermStatsRecord(), db.occurrences.count()]);
  if (rec && rec.rows === rows) return false;
  await rebuildTermStats();
  return true;
}
