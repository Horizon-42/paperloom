// 在 IndexedDB 与 DataTables 之间读写（可在 Worker 中运行）。
import { skipUndo } from "@/db/undo";
import type { PaperLensDB } from "@/db/schema";
import { t } from "@/i18n";
import { STAMP_PREFIX } from "@/db/repo/occurrences";
import { DATA_TABLE_NAMES, fingerprint, isDerivedKvKey, serializeTables, type DataCounts, type DataTables } from "./format";

/**
 * kv：本数据库实例的随机标识。IndexedDB 被清空（例如清除站点数据）后重建的数据库没有它，
 * 与本源 localStorage 里记下的不一致，据此发现"本地数据库被重置"，不会把残缺的数据当成新版本写进 data/。
 */
export const DB_INSTANCE_KEY = "storage:dbInstance";

/** 替换本地数据时发现数据在决定替换之后又被改过（例如载入期间用户新建了内容）：放弃替换 */
export class LocalChangedError extends Error {
  override name = "LocalChangedError";
  constructor() {
    super(t.data.format.localChanged);
  }
}

function dataTables(db: PaperLensDB) {
  return [db.domains, db.papers, db.annotations, db.terms, db.links, db.notes, db.boards, db.boardNodes, db.kv];
}

/** 一个只读事务里读出全部需要保存的数据（得到一致的快照） */
export async function readDataTables(db: PaperLensDB): Promise<DataTables> {
  return (await readDataSnapshot(db)).tables;
}

/** 同上，另外带出数据库实例标识 */
export async function readDataSnapshot(db: PaperLensDB): Promise<{ tables: DataTables; dbInstance: string | null }> {
  return db.transaction("r", dataTables(db), async () => {
    const [domains, papers, annotations, terms, links, notes, boards, boardNodes, kv] = await Promise.all([
      db.domains.toArray(),
      db.papers.toArray(),
      db.annotations.toArray(),
      db.terms.toArray(),
      db.links.toArray(),
      db.notes.toArray(),
      db.boards.toArray(),
      db.boardNodes.toArray(),
      db.kv.toArray(),
    ]);
    const stamp = kv.find((r) => r.key === DB_INSTANCE_KEY)?.value;
    return {
      tables: { domains, papers, annotations, terms, links, notes, boards, boardNodes, kv: kv.filter((r) => !isDerivedKvKey(r.key)) },
      dbInstance: typeof stamp === "string" ? stamp : null,
    };
  });
}

export async function stampDbInstance(db: PaperLensDB, id: string): Promise<void> {
  await db.kv.put({ key: DB_INSTANCE_KEY, value: id });
}

/** 各表记录数（只数主键，不读内容） */
export async function localCounts(db: PaperLensDB): Promise<DataCounts> {
  const out = {} as DataCounts;
  await db.transaction("r", dataTables(db), async () => {
    for (const name of DATA_TABLE_NAMES) {
      if (name === "kv") {
        const keys = (await db.kv.toCollection().primaryKeys()) as string[];
        out.kv = keys.filter((k) => !isDerivedKvKey(k)).length;
      } else {
        out[name] = await db.table(name).count();
      }
    }
  });
  return out;
}

/**
 * 用 tables 替换本地全部数据（一个事务）。PDF 文件（files）不动：同哈希的论文可以直接打开。
 * 派生数据只清掉已不存在或换了文件的论文的那部分，其余留给索引器按扫描戳判断是否重扫。
 * kv 中的派生记录（indexer:、storage:）保留。
 */
export async function replaceAllData(db: PaperLensDB, tables: DataTables, opts: { expectFingerprint?: string } = {}): Promise<void> {
  const keep = new Set(tables.papers.map((p) => `${p.id}\u0000${p.fileHash}`));
  const termIds = new Set(tables.terms.map((t) => t.id));
  await db.transaction("rw", [...dataTables(db), db.occurrences, db.pageTexts], async () => {
    // 整个数据库换成另一份：不进撤销记录（D20）
    skipUndo();
    // 在同一个写事务里确认本地数据还是决定替换时的样子（指纹是同步计算的，不会让事务提前提交）
    if (opts.expectFingerprint !== undefined) {
      const { tables: current } = await readDataSnapshot(db);
      if (fingerprint(serializeTables(current)) !== opts.expectFingerprint) throw new LocalChangedError();
    }
    const old = await db.papers.toArray();
    const stale = old.filter((p) => !keep.has(`${p.id}\u0000${p.fileHash}`)).map((p) => p.id);
    if (stale.length) {
      await db.pageTexts.where("paperId").anyOf(stale).delete();
      await db.occurrences.where("paperId").anyOf(stale).delete();
      await db.kv.bulkDelete(stale.map((id) => STAMP_PREFIX + id));
    }
    const oldTermIds = (await db.terms.toCollection().primaryKeys()) as string[];
    const goneTerms = oldTermIds.filter((id) => !termIds.has(id));
    if (goneTerms.length) await db.occurrences.where("termId").anyOf(goneTerms).delete();

    await Promise.all([db.domains, db.papers, db.annotations, db.terms, db.links, db.notes, db.boards, db.boardNodes].map((t) => t.clear()));
    const userKeys = ((await db.kv.toCollection().primaryKeys()) as string[]).filter((k) => !isDerivedKvKey(k));
    await db.kv.bulkDelete(userKeys);

    await db.domains.bulkPut(tables.domains);
    await db.papers.bulkPut(tables.papers);
    await db.annotations.bulkPut(tables.annotations);
    await db.terms.bulkPut(tables.terms);
    await db.links.bulkPut(tables.links);
    await db.notes.bulkPut(tables.notes);
    await db.boards.bulkPut(tables.boards);
    await db.boardNodes.bulkPut(tables.boardNodes);
    await db.kv.bulkPut(tables.kv.filter((r) => !isDerivedKvKey(r.key)));
  });
}

/** 论文引用的 PDF 哈希（去重） */
export async function referencedFileHashes(db: PaperLensDB): Promise<Map<string, string[]>> {
  const papers = await db.papers.toArray();
  const out = new Map<string, string[]>();
  for (const p of papers) {
    const list = out.get(p.fileHash);
    if (list) list.push(p.id);
    else out.set(p.fileHash, [p.id]);
  }
  return out;
}

/** db.files 里已有的哈希（只读主键） */
export async function localFileHashes(db: PaperLensDB): Promise<Set<string>> {
  return new Set((await db.files.toCollection().primaryKeys()) as string[]);
}
