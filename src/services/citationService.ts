// 查询论文的引用数（D17）：先按 DOI 查（论文填了 DOI，或从 PDF 前两页、文件名式的标题里识别出的 DOI / arXiv 编号），
// 查不到再按标题搜索，取正式发表、最新的版本。结果写进 Paper.citations；识别出并核对过的 DOI 写进 Paper.doi。
// 只在用户操作时调用，不会自动发请求。
import { getPaper, updatePaper, type PaperChanges } from "@/db/repo/papers";
import {
  OpenAlexError,
  TITLE_MATCH,
  arxivTitleCandidate,
  authorsAgree,
  findDoiCandidates,
  isPublished,
  lookupDois,
  normalizeDoi,
  pickWork,
  searchTitle,
  titleSimilarity,
  workIdOf,
  type DoiCandidate,
  type DoiLookup,
  type OpenAlexOptions,
  type OpenAlexWork,
} from "@/lib/openalex";
import type { Paper, PaperCitations } from "@/types/models";
import { readFirstPages } from "./pageTextService";
import { isMeaninglessTitle } from "./paperService";

/** 识别 DOI 时读前几页 */
const SCAN_PAGES = 2;
/** 唯一标了 "doi" 的候选：标题至少这么相似（或者论文标题本身没意义、作者对得上） */
const LABELED_TITLE_MATCH = 0.5;

export type CitationOutcome =
  | { paperId: string; status: "found"; citations: Extract<PaperCitations, { status: "found" }> }
  | { paperId: string; status: "notFound" }
  /** 额度用完、网络错误、查询期间论文被删除或改了 DOI，没有写入 */
  | { paperId: string; status: "skipped" };

export interface RefreshOptions extends OpenAlexOptions {
  /** 每篇论文有了结论时调用 */
  onProgress?: (done: number, total: number, last: CitationOutcome) => void;
  /** 识别 DOI 阶段（读 PDF 前几页）的进度 */
  onScan?: (done: number, total: number) => void;
  now?: () => number;
  /** 读论文前几页的文字（测试注入）。缺省用全文缓存，没有时只提取前几页 */
  readPages?: (paperId: string) => Promise<string>;
}

export interface RefreshResult {
  outcomes: CitationOutcome[];
  /** 中途停止的原因（额度用完、网络不通）；没查的论文是 skipped */
  stopped?: OpenAlexError;
}

function found(work: OpenAlexWork, matchedBy: "doi" | "title", at: number): Extract<PaperCitations, { status: "found" }> {
  const c: Extract<PaperCitations, { status: "found" }> = {
    status: "found",
    count: work.cited_by_count,
    workId: workIdOf(work),
    matchedBy,
    matchedTitle: work.display_name ?? "",
    fetchedAt: at,
  };
  if (work.publication_year) c.matchedYear = work.publication_year;
  const doi = normalizeDoi(work.doi);
  if (doi) c.matchedDoi = doi;
  if (!isPublished(work)) c.preprint = true;
  return c;
}

interface Plan {
  paper: Paper;
  /** 论文自己填了的 DOI：直接相信 */
  doi?: string;
  candidates: DoiCandidate[];
}

/**
 * 识别出的 DOI 是否可以当作这篇论文的：标题对得上；
 * 或者它是前几页唯一标了 "doi" 的，并且标题有几分相似、或论文标题没意义但作者对得上
 */
export function acceptCandidate(paper: Paper, c: DoiCandidate, all: readonly DoiCandidate[], work: OpenAlexWork): boolean {
  if (c.trusted) return true;
  const sim = work.display_name ? titleSimilarity(paper.title, work.display_name) : 0;
  if (sim >= TITLE_MATCH) return true;
  if (!c.labeled || all.filter((x) => x.labeled).length !== 1) return false;
  if (sim >= LABELED_TITLE_MATCH) return true;
  return isMeaninglessTitle(paper.title) && authorsAgree(paper, work) === true;
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
};

/**
 * 查询并保存一批论文的引用数。按 DOI 的查询免费、并发进行，标题搜索逐篇进行（较贵）。
 * 额度用完（429）或网络不通时停止，返回 stopped，没查的论文结果为 skipped；signal 中止时抛出 AbortError（已写入的保留）
 */
export async function refreshCitations(paperIds: readonly string[], opts: RefreshOptions = {}): Promise<RefreshResult> {
  const now = opts.now ?? Date.now;
  const readPages = opts.readPages ?? ((id: string) => readFirstPages(id, SCAN_PAGES));
  const outcomes: CitationOutcome[] = [];

  // 1. 每篇论文的 DOI：填了的直接用，否则从前几页（和标题里的 arXiv 编号）识别候选
  const plans: Plan[] = [];
  for (let i = 0; i < paperIds.length; i++) {
    throwIfAborted(opts.signal);
    opts.onScan?.(i, paperIds.length);
    const paper = await getPaper(paperIds[i]);
    if (!paper) continue;
    if (paper.doi) {
      plans.push({ paper, doi: paper.doi, candidates: [] });
      continue;
    }
    const text = await readPages(paper.id).catch(() => "");
    const fromTitle = arxivTitleCandidate(paper.title);
    plans.push({ paper, candidates: [...(fromTitle ? [fromTitle] : []), ...findDoiCandidates(text).filter((c) => c.doi !== fromTitle?.doi)] });
  }
  opts.onScan?.(paperIds.length, paperIds.length);

  const total = plans.length;
  const report = (o: CitationOutcome) => {
    outcomes.push(o);
    opts.onProgress?.(outcomes.length, total, o);
  };

  // 2. 先查所有 DOI；中途停止时，DOI 都有了结论的论文照常处理，其余的跳过
  throwIfAborted(opts.signal);
  const dois = [...new Set(plans.flatMap((p) => (p.doi ? [p.doi] : p.candidates.map((c) => c.doi))))];
  const lookup: DoiLookup = dois.length ? await lookupDois(dois, opts) : { found: new Map(), done: new Set() };
  let stopped: OpenAlexError | undefined = lookup.error;

  // 3. 逐篇：DOI 查到就用；否则按标题搜索
  for (const { paper, doi, candidates } of plans) {
    throwIfAborted(opts.signal);
    const mine = doi ? [doi] : candidates.map((c) => c.doi);
    if (stopped && !mine.every((d) => lookup.done.has(d))) {
      report({ paperId: paper.id, status: "skipped" });
      continue;
    }
    const at = now();
    const changes: PaperChanges = {};
    let work: OpenAlexWork | undefined | null = doi ? lookup.found.get(doi) : undefined;
    let matchedBy: "doi" | "title" = "doi";
    if (!doi) {
      for (const c of candidates) {
        const w = lookup.found.get(c.doi);
        if (w && acceptCandidate(paper, c, candidates, w)) {
          work = w;
          changes.doi = c.doi;
          break;
        }
      }
    }
    if (!work && !isMeaninglessTitle(paper.title)) {
      if (stopped) {
        report({ paperId: paper.id, status: "skipped" });
        continue;
      }
      try {
        work = pickWork(paper, await searchTitle(paper.title, opts));
        matchedBy = "title";
      } catch (e) {
        if (!(e instanceof OpenAlexError)) throw e;
        stopped = e;
        report({ paperId: paper.id, status: "skipped" });
        continue;
      }
    }
    // 写入前再读一次：查询期间论文可能被删除，或用户改了 DOI（这时结果对不上，不写）
    const latest = await getPaper(paper.id);
    if (!latest || latest.doi !== paper.doi) {
      report({ paperId: paper.id, status: "skipped" });
      continue;
    }
    if (work) {
      const citations = found(work, matchedBy, at);
      await updatePaper(paper.id, { ...changes, citations });
      report({ paperId: paper.id, status: "found", citations });
    } else {
      await updatePaper(paper.id, { citations: { status: "notFound", fetchedAt: at } });
      report({ paperId: paper.id, status: "notFound" });
    }
  }
  return stopped ? { outcomes, stopped } : { outcomes };
}

/** 批量查询时跳过最近查过的：找到的 7 天内、没找到的 30 天内不再查 */
export const FRESH_FOUND_MS = 7 * 24 * 3600_000;
export const FRESH_NOT_FOUND_MS = 30 * 24 * 3600_000;

export function needsRefresh(paper: Pick<Paper, "citations">, now = Date.now()): boolean {
  const c = paper.citations;
  if (!c) return true;
  return now - c.fetchedAt > (c.status === "found" ? FRESH_FOUND_MS : FRESH_NOT_FOUND_MS);
}
