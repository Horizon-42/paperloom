// 后台索引的核心：纯计算（computeOccurrences 等）+ 一次扫描任务（runIndexJob）。
// indexer.worker.ts 在 Worker 里调用 runIndexJob；Worker 不可用时 services/indexer.ts 在主线程调用；单元测试直接调用。
import { db } from "@/db/schema";
import {
  clearPaperOccurrences,
  countOccurrencesForPaper,
  deleteIndexStamps,
  deleteOrphanOccurrences,
  ensureTermStats,
  getIndexStamps,
  listPaperIdsWithStaleOccurrences,
  replacePaperOccurrences,
  type IndexStamp,
} from "@/db/repo/occurrences";
import { TermMatcher, domainClosure } from "@/engine/matcher";
import { fromNormalizedText } from "@/engine/normalize";
import { MATCH_VERSION, NORMALIZE_VERSION, type TermLike } from "@/engine/types";
import type { Domain, Occurrence, PageText, Paper } from "@/types/models";

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export interface PageTextLike {
  page: number;
  text: string;
}

/**
 * 计算一篇论文里每个（在作用范围内的）术语出现的页码（升序）和次数。
 * 一处命中有多个候选术语（同一缩写分属不同领域且都生效）时，每个候选各记一次。
 * terms 可以直接传已构建的 TermMatcher，扫描多篇论文时复用自动机。
 */
export function computeOccurrences(
  terms: readonly TermLike[] | TermMatcher,
  paper: Pick<Paper, "id" | "domainIds">,
  domainParent: ReadonlyMap<string, string | null>,
  pageTexts: readonly PageTextLike[],
): Occurrence[] {
  const matcher = terms instanceof TermMatcher ? terms : new TermMatcher([...terms]);
  const scope = { paperDomainIds: paper.domainIds ?? [], domainParent };
  const acc = new Map<string, { pages: number[]; count: number }>();
  const sorted = [...pageTexts].sort((a, b) => a.page - b.page);
  for (const pt of sorted) {
    if (!pt.text) continue;
    for (const m of matcher.match(fromNormalizedText(pt.text), scope)) {
      for (const id of m.termIds) {
        let a = acc.get(id);
        if (!a) {
          a = { pages: [], count: 0 };
          acc.set(id, a);
        }
        a.count++;
        if (a.pages[a.pages.length - 1] !== pt.page) a.pages.push(pt.page);
      }
    }
  }
  return [...acc]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([termId, a]) => ({ termId, paperId: paper.id, pages: a.pages, count: a.count, engineVersion: MATCH_VERSION }));
}

/** cyrb53：快速 53 位字符串哈希（非加密），用于变化检测 */
export function hashString(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 术语中影响匹配的字段（名称、别名、匹配方式、作用范围）；笔记、时间戳不在内 */
export function termMatchSignature(t: TermLike): string {
  const scope = t.scope.kind === "domains" ? "d:" + [...t.scope.domainIds].sort().join(",") : "g";
  return [t.id, t.name, (t.aliases ?? []).join("\u0002"), t.matchMode, scope].join("\u0001");
}

/** 全部术语影响匹配的部分的摘要；与顺序无关 */
export function termsMatchKey(terms: readonly TermLike[]): string {
  return hashString(terms.map(termMatchSignature).sort().join("\u0000"));
}

export function buildDomainParent(domains: readonly Pick<Domain, "id" | "parentId">[]): Map<string, string | null> {
  return new Map(domains.map((d) => [d.id, d.parentId]));
}

/** 领域树结构的摘要（只看父子关系） */
export function domainTreeKey(domains: readonly Pick<Domain, "id" | "parentId">[]): string {
  return domains
    .map((d) => `${d.id}:${d.parentId ?? ""}`)
    .sort()
    .join(",");
}

/** 影响扫描结果的论文字段：文件和所属领域 */
export function paperIndexSignature(p: Pick<Paper, "fileHash" | "domainIds">): string {
  return `${p.fileHash}|${[...(p.domainIds ?? [])].sort().join(",")}`;
}

/**
 * 对这篇论文生效的"限定领域"术语集合的摘要。全局术语总是生效，已包含在 termsKey 里。
 * 论文换领域、领域树调整只有在改变了这个集合时才需要重扫。
 */
export function paperScopeKey(
  paper: Pick<Paper, "domainIds">,
  domainParent: ReadonlyMap<string, string | null>,
  scopedTerms: readonly TermLike[],
): string {
  if (!scopedTerms.length) return "";
  const closure = domainClosure({ paperDomainIds: paper.domainIds ?? [], domainParent });
  const ids: string[] = [];
  for (const t of scopedTerms) {
    if (t.scope.kind === "domains" && t.scope.domainIds.some((d) => closure.has(d))) ids.push(t.id);
  }
  return ids.length ? hashString(ids.sort().join(",")) : "-";
}

/** 全文缓存是否对论文当前的文件和规范化规则版本有效（与 pageTextService 的判断一致） */
export function isPageTextFresh(rows: readonly Pick<PageText, "fileHash" | "engineVersion">[], paper: Pick<Paper, "fileHash" | "pageCount">): boolean {
  return (
    rows.length > 0 &&
    rows.length === paper.pageCount &&
    rows.every((r) => r.fileHash === paper.fileHash && r.engineVersion === NORMALIZE_VERSION)
  );
}

export function sameStamp(a: IndexStamp | undefined, b: Omit<IndexStamp, "occCount" | "at">): boolean {
  return (
    !!a &&
    a.fileHash === b.fileHash &&
    a.normalizeVersion === b.normalizeVersion &&
    a.matchVersion === b.matchVersion &&
    a.termsKey === b.termsKey &&
    a.scopeKey === b.scopeKey
  );
}

/** 扫描顺序：priority 中的论文在前（按 priority 顺序），其余按最近打开、最近导入 */
export function orderPapers<P extends Pick<Paper, "id" | "addedAt" | "lastOpenedAt">>(papers: P[], priority: readonly string[] = []): P[] {
  const rank = new Map(priority.map((id, i) => [id, i]));
  return [...papers].sort((a, b) => {
    const ra = rank.get(a.id) ?? Infinity;
    const rb = rank.get(b.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.addedAt - a.addedAt || (a.id < b.id ? -1 : 1);
  });
}

// ---------------------------------------------------------------------------
// 扫描任务
// ---------------------------------------------------------------------------

export interface IndexJobRequest {
  /** null 表示全库 */
  paperIds: string[] | null;
  /** 优先扫描的论文（通常是阅读器里打开的） */
  priority?: string[];
}

export interface IndexJobStats {
  /** 本次检查的论文数 */
  papers: number;
  /** 实际重新匹配的论文数 */
  scanned: number;
  /** 扫描戳一致、跳过的论文数 */
  skipped: number;
  pages: number;
  termCount: number;
  /** 本次算出的 occurrences 行数 */
  rows: number;
  written: number;
  deleted: number;
  /** 全库任务清掉的孤儿记录（论文或术语已不存在） */
  orphans: number;
  buildMs: number;
  matchMs: number;
  ms: number;
}

export interface IndexJobResult {
  cancelled: boolean;
  /** 缺少有效全文的论文，需要主线程先提取；missingFile 表示 files 表里没有这份 PDF，提取必然失败 */
  needsText: { paperId: string; fileHash: string; missingFile?: boolean }[];
  errors: { paperId: string; message: string }[];
  stats: IndexJobStats;
}

export interface IndexJobHooks {
  isCancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

// 主线程 → Worker
// dbName：页面的数据库名，Worker 核对自己打开的是同一个（Worker 按自己的名字确定项目，见 lib/project.ts）
export type IndexerRequestMessage = { type: "run"; jobId: number; req: IndexJobRequest; dbName: string } | { type: "cancel"; jobId: number };
// Worker → 主线程；wrong-db：Worker 打开的数据库与页面不一致（不应发生），主线程改为自己扫描
export type IndexerResponseMessage =
  | { type: "progress"; jobId: number; done: number; total: number }
  | { type: "result"; jobId: number; result: IndexJobResult }
  | { type: "error"; jobId: number; message: string }
  | { type: "wrong-db"; jobId: number; message: string };

/** 术语未变时复用自动机（2000 条约几十毫秒） */
let matcherCache: { key: string; matcher: TermMatcher } | null = null;
/**
 * 含旧版本记录的论文要强制重扫。全表扫描较慢，每次会话只在第一次全库任务里做；
 * 结果留在这里，直到这些论文被处理（任务被取消也不丢）。
 */
let staleChecked = false;
const forcedPapers = new Set<string>();

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * 扫描给定论文（或全库），把结果写入 occurrences。
 * 扫描戳与当前输入一致的论文跳过；缺少有效全文的论文放进 needsText，不阻塞其他论文；单篇出错只记录。
 * 每篇论文一个写事务，取消检查在论文之间进行。
 */
export async function runIndexJob(req: IndexJobRequest, hooks: IndexJobHooks = {}): Promise<IndexJobResult> {
  const t0 = now();
  const stats: IndexJobStats = {
    papers: 0,
    scanned: 0,
    skipped: 0,
    pages: 0,
    termCount: 0,
    rows: 0,
    written: 0,
    deleted: 0,
    orphans: 0,
    buildMs: 0,
    matchMs: 0,
    ms: 0,
  };
  const needsText: IndexJobResult["needsText"] = [];
  const errors: IndexJobResult["errors"] = [];
  const full = req.paperIds === null;

  const [terms, domains] = await Promise.all([db.terms.toArray(), db.domains.toArray()]);
  stats.termCount = terms.length;
  const termsKey = termsMatchKey(terms);
  if (matcherCache?.key !== termsKey) {
    const tb = now();
    matcherCache = { key: termsKey, matcher: new TermMatcher(terms) };
    stats.buildMs = now() - tb;
  }
  const matcher = matcherCache.matcher;
  const domainParent = buildDomainParent(domains);
  const scopedTerms = terms.filter((t) => t.scope.kind === "domains");

  let papers: Paper[];
  if (full) {
    papers = await db.papers.toArray();
  } else {
    const ids = [...new Set(req.paperIds)];
    papers = (await db.papers.bulkGet(ids)).filter((p): p is Paper => !!p);
  }
  papers = orderPapers(papers, req.priority);
  stats.papers = papers.length;

  const stamps = await getIndexStamps(full ? undefined : papers.map((p) => p.id));
  if (full) {
    // 启动自检：旧版本的记录视为缺失；清掉孤儿记录和已不存在的论文的扫描戳
    if (!staleChecked) {
      for (const id of await listPaperIdsWithStaleOccurrences()) forcedPapers.add(id);
      staleChecked = true;
    }
    stats.orphans = await deleteOrphanOccurrences();
    const alive = new Set(papers.map((p) => p.id));
    await deleteIndexStamps([...stamps.keys()].filter((id) => !alive.has(id)));
  }
  // 术语统计：别的模块删过记录（删论文、删术语、换文件）时行数对不上，重建
  await ensureTermStats();

  let cancelled = false;
  let done = 0;
  hooks.onProgress?.(0, papers.length);
  for (const paper of papers) {
    if (hooks.isCancelled?.()) {
      cancelled = true;
      break;
    }
    try {
      const base = {
        fileHash: paper.fileHash,
        normalizeVersion: NORMALIZE_VERSION,
        matchVersion: MATCH_VERSION,
        termsKey,
        scopeKey: paperScopeKey(paper, domainParent, scopedTerms),
      };
      const stored = stamps.get(paper.id);
      if (!forcedPapers.has(paper.id) && sameStamp(stored, base) && (await countOccurrencesForPaper(paper.id)) === stored!.occCount) {
        stats.skipped++;
      } else {
        const rows = await db.pageTexts.where("paperId").equals(paper.id).toArray();
        if (!isPageTextFresh(rows, paper)) {
          // 只数主键，不读出 PDF 二进制
          const hasFile = (await db.files.where(":id").equals(paper.fileHash).count()) > 0;
          needsText.push(hasFile ? { paperId: paper.id, fileHash: paper.fileHash } : { paperId: paper.id, fileHash: paper.fileHash, missingFile: true });
          // 换过文件：旧文件的出现位置作废。规范化规则变化则保留旧结果（界面标为待更新），重新提取后覆盖
          if (stored && stored.fileHash !== paper.fileHash) await clearPaperOccurrences(paper.id);
        } else {
          const tm = now();
          const occ = computeOccurrences(matcher, paper, domainParent, rows);
          stats.matchMs += now() - tm;
          const w = await replacePaperOccurrences(paper, occ, { ...base, occCount: occ.length, at: Date.now() });
          forcedPapers.delete(paper.id);
          stats.scanned++;
          stats.pages += rows.length;
          stats.rows += occ.length;
          if (w) {
            stats.written += w.written;
            stats.deleted += w.deleted;
          }
        }
      }
    } catch (e) {
      errors.push({ paperId: paper.id, message: e instanceof Error ? e.message : String(e) });
    }
    hooks.onProgress?.(++done, papers.length);
  }

  stats.ms = now() - t0;
  return { cancelled, needsText, errors, stats };
}

/** 测试用：模拟重新启动（丢弃缓存的自动机和会话内的自检状态） */
export function resetIndexCoreState(): void {
  matcherCache = null;
  staleChecked = false;
  forcedPapers.clear();
}
