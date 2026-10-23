// OpenAlex 查询引用数（D17）：DOI 规范化与识别、按 DOI 批量查询、按标题搜索并挑选版本。
// 不碰数据库；fetch 可注入，单元测试用假实现。接口文档 https://docs.openalex.org
// 计费（无 key 时每个 IP 每天共享一小笔免费额度，约 $0.1）：按 id/DOI 单条查询免费，标题搜索约 $0.001（每天约 100 次）。
import type { Paper } from "@/types/models";

const API = "https://api.openalex.org/works";
/** 按 DOI 查询的并发数（OpenAlex 限每秒 10 个请求） */
const CONCURRENCY = 4;
const FIELDS = "id,display_name,publication_year,publication_date,cited_by_count,doi,type,primary_location,authorships";

/** 只取用到的字段 */
export interface OpenAlexWork {
  id: string; // "https://openalex.org/W2963403868"
  display_name: string | null;
  publication_year: number | null;
  publication_date: string | null;
  cited_by_count: number;
  doi: string | null; // "https://doi.org/10.…"
  type: string | null; // "article" | "preprint" | …
  primary_location?: { version?: string | null; source?: { type?: string | null } | null } | null;
  authorships?: { author?: { display_name?: string | null } | null }[];
}

export interface OpenAlexOptions {
  fetch?: typeof fetch;
  /** 可选的 API key（每天独立额度） */
  apiKey?: string;
  signal?: AbortSignal;
}

export class OpenAlexError extends Error {
  /** quota：今日额度用完或请求太频繁（429）；network：网络不通；http：其他错误 */
  constructor(
    readonly kind: "quota" | "network" | "http",
    message: string,
  ) {
    super(message);
  }
}

// ---------- DOI ----------

const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>]+/i;

/** 从文字里截出的、或 OpenAlex 返回的 DOI → 规范形式（小写、去掉前缀和末尾标点）；不像 DOI 时返回 null。用户填写的用 parseDoiInput */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  const m = DOI_RE.exec(s);
  if (!m || m.index !== 0) return null;
  return trimDoi(m[0]).toLowerCase();
}

/**
 * 解析用户填写的 DOI（编辑信息、备份文件里的）：整串必须是一个 DOI，不截断。
 * 接受 https://doi.org/…、doi:…、"DOI 10.…" 和 URL 编码的写法；不像 DOI 时返回 null
 */
export function parseDoiInput(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  try {
    if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s);
  } catch {
    // 不是合法的 URL 编码：按原样
  }
  s = s
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi\s*[:\uff1a]?\s*/i, "")
    .trim();
  return /^10\.\d{4,9}\/\S+$/.test(s) ? s.toLowerCase() : null;
}

/** 去掉 DOI 末尾混进来的标点（句号、逗号、不成对的右括号） */
function trimDoi(doi: string): string {
  let d = doi.replace(/[.,;:]+$/, "");
  while (/[)\]}]$/.test(d)) {
    const close = d[d.length - 1];
    const open = close === ")" ? "(" : close === "]" ? "[" : "{";
    if (d.split(open).length >= d.split(close).length) break;
    d = d.slice(0, -1).replace(/[.,;:]+$/, "");
  }
  return d;
}

/** arXiv 编号对应的 DOI（DataCite 注册）：10.48550/arxiv.2104.09864 */
export const arxivDoi = (id: string) => `10.48550/arxiv.${id.toLowerCase()}`;

export interface DoiCandidate {
  doi: string;
  /** 前面写着 "doi" / doi.org：多半是论文自己的 DOI */
  labeled: boolean;
  /** 由 arXiv 编号换算 */
  arxiv?: boolean;
  /** 标题本身就是 arXiv 编号（导入时用了文件名）：无法核对标题，直接采用 */
  trusted?: boolean;
}

/** 标题本身是 arXiv 编号时返回对应的 DOI 候选 */
export function arxivTitleCandidate(title: string): DoiCandidate | null {
  const m = /^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(title.trim());
  return m ? { doi: arxivDoi(m[1]), labeled: false, arxiv: true, trusted: true } : null;
}

/**
 * 从论文前几页的文字里找 DOI 候选：带 "doi" 标记的在前，其次是其他 DOI，最后是 arXiv 编号换算的 DOI。
 * 只是候选：用之前要核对查到的标题
 */
export function findDoiCandidates(text: string): DoiCandidate[] {
  const out: DoiCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: DoiCandidate) => {
    if (seen.has(c.doi)) return;
    seen.add(c.doi);
    out.push(c);
  };
  const re = new RegExp(DOI_RE.source, "gi");
  for (const m of text.matchAll(re)) {
    const doi = normalizeDoi(m[0]);
    if (!doi) continue;
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    add({ doi, labeled: /(?:doi|doi\.org\/)\s*[:\uff1a]?\s*$/i.test(before) });
  }
  out.sort((a, b) => Number(b.labeled) - Number(a.labeled));
  // arXiv 页边的编号："arXiv:2104.09864v5 [cs.CL]"
  for (const m of text.matchAll(/\barxiv\s*:\s*(\d{4}\.\d{4,5})(?:v\d+)?/gi)) add({ doi: arxivDoi(m[1]), labeled: false, arxiv: true });
  return out;
}

// ---------- 标题比对 ----------

const titleTokens = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ") // OpenAlex 的标题里偶尔带 <i>…</i>
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** 两个标题的相似度（0–1）：词的 Dice 系数 */
export function titleSimilarity(a: string, b: string): number {
  const x = titleTokens(a);
  const y = titleTokens(b);
  if (!x.length || !y.length) return 0;
  const count = new Map<string, number>();
  for (const w of x) count.set(w, (count.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of y) {
    const n = count.get(w);
    if (n) {
      common++;
      count.set(w, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

/** 认为是同一篇论文的标题相似度下限 */
export const TITLE_MATCH = 0.85;

/** 作者名里的词（两个字母以上）：姓名顺序不固定（Zhang Wei / Wei Zhang），所以不分姓和名 */
const nameTokens = (name: string) => titleTokens(name).filter((w) => w.length >= 2);
const LATIN = /\p{Script=Latin}/u;

/**
 * 作者能对上（任一作者的名字有共同的词）。返回 null 表示无法判断：
 * 本地没有作者、作者不是拉丁字母（中文名对不上罗马拼音），或 OpenAlex 没有作者
 */
export function authorsAgree(paper: Pick<Paper, "authors">, work: OpenAlexWork): boolean | null {
  const ours = new Set(paper.authors.filter((a) => LATIN.test(a)).flatMap(nameTokens));
  const theirs = (work.authorships ?? []).flatMap((a) => nameTokens(a.author?.display_name ?? ""));
  if (!ours.size || !theirs.length) return null;
  return theirs.some((w) => ours.has(w));
}

/** 不是论文本身的作品类型：勘误、撤稿声明、目录等附属内容、审稿意见、数据集 */
const NOT_PAPER = new Set(["erratum", "retraction", "paratext", "peer-review", "dataset", "editorial", "supplementary-materials", "libguides"]);
/** 无法核对作者时，标题必须几乎完全相同 */
const TITLE_MATCH_NO_AUTHORS = 0.95;
/** 与最相似的结果差这么多以内的算同一个标题（同一篇的不同版本） */
const SAME_TITLE_SLACK = 0.02;

/** 是否是正式发表的版本（不是预印本、不在预印本库里） */
export function isPublished(work: OpenAlexWork): boolean {
  if (work.type === "preprint") return false;
  const loc = work.primary_location;
  if (loc?.source?.type === "repository") return false;
  return loc?.version !== "submittedVersion";
}

/**
 * 从标题搜索的结果里挑一篇：
 * 1. 排除勘误等附属内容；标题足够相似（作者对不上的排除；无法核对作者时要求标题几乎相同）；
 * 2. 只留与最相似者同样相似的（避免 "…: A Survey"、"Correction to: …" 这类标题更长的别的作品胜出）；
 * 3. 其中有正式发表的版本取正式版，同类里取最新的
 */
export function pickWork(paper: Pick<Paper, "title" | "authors">, works: readonly OpenAlexWork[]): OpenAlexWork | null {
  const scored = works
    .filter((w) => w.display_name && !NOT_PAPER.has(w.type ?? ""))
    .map((w) => ({ w, sim: titleSimilarity(paper.title, w.display_name!), authors: authorsAgree(paper, w) }))
    .filter((x) => x.authors !== false && x.sim >= (x.authors === null ? TITLE_MATCH_NO_AUTHORS : TITLE_MATCH));
  if (!scored.length) return null;
  const best = Math.max(...scored.map((x) => x.sim));
  const date = (w: OpenAlexWork) => w.publication_date ?? (w.publication_year ? `${w.publication_year}` : "");
  return scored
    .filter((x) => x.sim >= best - SAME_TITLE_SLACK)
    .map((x) => x.w)
    .sort((a, b) => Number(isPublished(b)) - Number(isPublished(a)) || (date(a) < date(b) ? 1 : date(a) > date(b) ? -1 : 0))[0];
}

// ---------- 请求 ----------

/** 两个请求开始的最小间隔：OpenAlex 限每秒 10 个，留些余量 */
const MIN_INTERVAL_MS = 125;
/** 每秒限流（不是每日额度）的 429 最多重试几次 */
const RATE_RETRIES = 2;
let nextSlot = 0;

const abortError = () => new DOMException("aborted", "AbortError");
export const isAbortError = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 所有请求共用的节流：按开始时间排队 */
async function throttle(signal?: AbortSignal) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_INTERVAL_MS;
  if (at > now) await sleep(at - now, signal);
}

/** 测试用：清空节流状态 */
export function resetThrottleForTest() {
  nextSlot = 0;
}

async function get(url: string, opts: OpenAlexOptions): Promise<unknown> {
  const u = new URL(url);
  if (opts.apiKey) u.searchParams.set("api_key", opts.apiKey);
  for (let attempt = 0; ; attempt++) {
    await throttle(opts.signal);
    let res: Response;
    try {
      res = await (opts.fetch ?? fetch)(u.toString(), { signal: opts.signal, headers: { Accept: "application/json" } });
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new OpenAlexError("network", String(e));
    }
    if (res.status === 429) {
      // 今日额度还有剩（或给了很短的 Retry-After）：是每秒限流，等一下再试
      const remaining = Number(res.headers.get("x-ratelimit-remaining-usd") ?? NaN);
      const retryAfter = Number(res.headers.get("retry-after") ?? NaN);
      const shortWait = retryAfter > 0 && retryAfter <= 5;
      if ((shortWait || remaining > 0) && attempt < RATE_RETRIES) {
        await sleep((shortWait ? retryAfter : 1) * 1000, opts.signal);
        continue;
      }
      throw new OpenAlexError("quota", await res.text().catch(() => ""));
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new OpenAlexError("http", `HTTP ${res.status}`);
    return res.json();
  }
}

export interface DoiLookup {
  /** DOI（规范形式）→ 作品 */
  found: Map<string, OpenAlexWork>;
  /** 已经有结论的 DOI（查到，或确定查不到） */
  done: Set<string>;
  /** 中途停止的原因（额度用完、网络不通）；没查的 DOI 不在 done 里 */
  error?: OpenAlexError;
}

/**
 * 按 DOI 查询。逐个按 id 查（免费，且能解析别名：arXiv 的 DOI 会落到 OpenAlex 合并后的作品上；filter 列表查询做不到），
 * 同时最多 CONCURRENCY 个。单个 DOI 的服务器错误当作查不到；额度用完或网络不通时停下，返回已经查到的部分
 */
export async function lookupDois(dois: readonly string[], opts: OpenAlexOptions = {}): Promise<DoiLookup> {
  const out: DoiLookup = { found: new Map(), done: new Set() };
  // 一个出错时让其他的也停下
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) stop.abort();
  const inner = { ...opts, signal: stop.signal };
  let next = 0;
  let unexpected: unknown;
  const worker = async () => {
    while (next < dois.length && !stop.signal.aborted) {
      const d = dois[next++];
      try {
        const w = (await get(`${API}/doi:${encodeURIComponent(d)}?select=${FIELDS}`, inner)) as OpenAlexWork | null;
        if (w) out.found.set(d, w);
        out.done.add(d);
      } catch (e) {
        if (e instanceof OpenAlexError && e.kind === "http") {
          out.done.add(d);
          continue;
        }
        if (e instanceof OpenAlexError) out.error ??= e;
        else if (!isAbortError(e)) unexpected ??= e;
        stop.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dois.length) }, worker));
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  if (unexpected) throw unexpected;
  if (opts.signal?.aborted) throw abortError();
  return out;
}

/** 按标题搜索（title.search，最多 10 条） */
export async function searchTitle(title: string, opts: OpenAlexOptions = {}): Promise<OpenAlexWork[]> {
  // filter 的值里逗号是分隔符、冒号有特殊含义：换成空格
  const q = title.replace(/[,:|]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return [];
  const data = (await get(`${API}?filter=title.search:${encodeURIComponent(q)}&per-page=10&select=${FIELDS}`, opts)) as {
    results?: OpenAlexWork[];
  } | null;
  return data?.results ?? [];
}

/** "https://openalex.org/W123" → "W123" */
export const workIdOf = (w: OpenAlexWork) => w.id.replace(/^https?:\/\/openalex\.org\//, "");
export const workUrl = (workId: string) => `https://openalex.org/works/${workId}`;
