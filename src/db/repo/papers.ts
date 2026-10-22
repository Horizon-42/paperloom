// papers 表的读写
import { db } from "@/db/schema";
import type { Paper } from "@/types/models";

export type PaperChanges = Partial<Omit<Paper, "id" | "fileHash">>;

export function listPapers(): Promise<Paper[]> {
  return db.papers.toArray();
}

export function getPaper(id: string): Promise<Paper | undefined> {
  return db.papers.get(id);
}

export function getPaperByHash(fileHash: string): Promise<Paper | undefined> {
  return db.papers.where("fileHash").equals(fileHash).first();
}

export function countPapersByHash(fileHash: string): Promise<number> {
  return db.papers.where("fileHash").equals(fileHash).count();
}

/** 属于任一给定领域的论文（去重） */
export function listPapersInDomains(domainIds: string[]): Promise<Paper[]> {
  if (!domainIds.length) return Promise.resolve([]);
  return db.papers.where("domainIds").anyOf(domainIds).distinct().toArray();
}

export async function addPaper(paper: Paper): Promise<void> {
  await db.papers.add(paper);
}

/** 值为 undefined 的字段会从记录中删除（如清空年份） */
export async function updatePaper(id: string, changes: PaperChanges): Promise<void> {
  await db.papers.update(id, changes);
}

/** 从多篇论文的 domainIds 中移除给定领域 */
export async function removeDomainsFromAllPapers(domainIds: string[]): Promise<number> {
  if (!domainIds.length) return 0;
  const drop = new Set(domainIds);
  return db.papers
    .where("domainIds")
    .anyOf(domainIds)
    .distinct()
    .modify((p) => {
      p.domainIds = p.domainIds.filter((id) => !drop.has(id));
    });
}

export async function deletePaperRecord(id: string): Promise<void> {
  await db.papers.delete(id);
}
