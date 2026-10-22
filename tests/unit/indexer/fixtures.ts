// 索引测试共用的数据构造
import { db } from "@/db/schema";
import { NORMALIZE_VERSION } from "@/engine/types";
import type { Domain, Paper, Term, TermScope } from "@/types/models";

export function mkTerm(id: string, name: string, aliases: string[] = [], opts: Partial<Term> & { domains?: string[] } = {}): Term {
  const scope: TermScope = opts.domains ? { kind: "domains", domainIds: opts.domains } : (opts.scope ?? { kind: "global" });
  return {
    id,
    name,
    aliases,
    matchMode: opts.matchMode ?? "auto",
    scope,
    note: opts.note ?? "",
    createdAt: opts.createdAt ?? 1,
    updatedAt: opts.updatedAt ?? 1,
  };
}

export function mkPaper(id: string, opts: Partial<Paper> = {}): Paper {
  return {
    id,
    fileHash: opts.fileHash ?? `hash-${id}`,
    title: opts.title ?? `Paper ${id}`,
    authors: [],
    domainIds: opts.domainIds ?? [],
    pageCount: opts.pageCount ?? 1,
    addedAt: opts.addedAt ?? 1,
    ...(opts.lastOpenedAt !== undefined ? { lastOpenedAt: opts.lastOpenedAt } : {}),
  };
}

export function mkDomain(id: string, parentId: string | null = null, name = id): Domain {
  return { id, name, parentId, color: "#3b82f6", order: 0 };
}

/** 写入论文及其每页文本（文本缓存与论文的 fileHash、当前规则版本一致） */
export async function putPaperWithTexts(paper: Paper, pages: string[], opts: { fileHash?: string; normalizeVersion?: number } = {}) {
  await db.papers.put({ ...paper, pageCount: pages.length });
  await db.pageTexts.bulkPut(
    pages.map((text, i) => ({
      paperId: paper.id,
      page: i + 1,
      text,
      fileHash: opts.fileHash ?? paper.fileHash,
      engineVersion: opts.normalizeVersion ?? NORMALIZE_VERSION,
    })),
  );
}

export async function occOf(paperId: string) {
  const rows = await db.occurrences.where("paperId").equals(paperId).toArray();
  return Object.fromEntries(rows.map((r) => [r.termId, { pages: r.pages, count: r.count }]));
}
