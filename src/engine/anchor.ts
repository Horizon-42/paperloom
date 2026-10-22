// 第 6 节第 4 步：批注的原文引用（exact + 前后各 32 字符）与换文件后的重新锚定。
import type { QuoteSelector } from "@/types/models";
import { charReplacement } from "./normalize";

export const QUOTE_CONTEXT = 32;

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** 从规范化页面文本 [start, end) 生成引用；prefix/suffix 各取 32 个字符（不拆开代理对） */
export function makeQuote(text: string, start: number, end: number): QuoteSelector {
  const n = text.length;
  let s = Math.max(0, Math.min(n, Math.floor(start)));
  let e = Math.max(0, Math.min(n, Math.ceil(end)));
  if (e < s) [s, e] = [e, s];
  let ps = Math.max(0, s - QUOTE_CONTEXT);
  if (ps > 0 && ps < s && isLow(text.charCodeAt(ps))) ps++;
  let se = Math.min(n, e + QUOTE_CONTEXT);
  if (se > e && se < n && isLow(text.charCodeAt(se)) && isHigh(text.charCodeAt(se - 1))) se--;
  return { exact: text.slice(s, e), prefix: text.slice(ps, s), suffix: text.slice(e, se) };
}

// ---------------------------------------------------------------------------
// 宽松形式：去掉空白和连字符，并做与 normalize 相同的字符替换（连字、全角等），用于容忍版本间的排版差异
// ---------------------------------------------------------------------------

function isLooseSkip(c: number): boolean {
  if (c <= 0x20) return true;
  if (c < 0x80) return c === 0x2d || c === 0x7f;
  return (
    c === 0x85 ||
    c === 0xa0 ||
    c === 0xad ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200d) ||
    c === 0x2010 ||
    c === 0x2011 ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x2060 ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

interface Loose {
  /** 生成它的原文，用于校验缓存 */
  src: string;
  text: string;
  /** 宽松下标 → 原文下标 */
  toRaw: Int32Array;
  /** 原文下标 i（0..n）→ 原文 [0, i) 产生的宽松字符数 */
  fromRaw: Int32Array;
}

function loosen(raw: string): Loose {
  const n = raw.length;
  const parts: string[] = [];
  const toRaw: number[] = [];
  const fromRaw = new Int32Array(n + 1);
  let runStart = 0; // 当前未跳过的连续片段起点
  for (let i = 0; i < n; i++) {
    fromRaw[i] = toRaw.length;
    const c = raw.charCodeAt(i);
    const rep = isLooseSkip(c) ? undefined : charReplacement(c);
    if (rep !== undefined || isLooseSkip(c)) {
      if (runStart < i) parts.push(raw.slice(runStart, i));
      runStart = i + 1;
      if (rep !== undefined) {
        for (let m = 0; m < rep.length; m++) {
          if (isLooseSkip(rep.charCodeAt(m))) continue;
          parts.push(rep[m]);
          toRaw.push(i);
        }
      }
      continue;
    }
    toRaw.push(i);
  }
  if (runStart < n) parts.push(raw.slice(runStart));
  fromRaw[n] = toRaw.length;
  return { src: raw, text: parts.join(""), toRaw: Int32Array.from(toRaw), fromRaw };
}

/** 按页面对象缓存宽松形式：批量重新锚定同一篇论文的批注时，调用方复用同一个 pages 数组即可命中 */
const looseCache = new WeakMap<object, Loose>();

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 0..1 的相似度；过长时退化为长度比，避免平方级开销 */
function similarity(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  if (m === 0) return 1;
  if (a.length * b.length > 4_000_000) return Math.min(a.length, b.length) / m;
  return 1 - levenshtein(a, b) / m;
}

// 各层命中的基础分：精确 > 宽松 > 靠上下文桥接
const SCORE_EXACT = 0.5;
const SCORE_LOOSE = 0.4;
const SCORE_CONTEXT_WEIGHT = 0.5;
const BRIDGE_MIN_CONTEXT = 8;
const BRIDGE_CONTEXT = 16;
const BRIDGE_MIN_SIM = 0.5;

/**
 * hint.page 参与排序：候选的排序分 = score + HINT_BONUS × HINT_DECAY^|页码 − hint.page|，
 * 即同页 +0.15、相邻页 +0.03、隔两页 +0.006，再远可忽略。
 * - 足以压过别处的精确重复（页眉页脚、重复的段落）：hint 页上下文完全一致的宽松命中（0.9 + 0.15）
 *   胜过相邻页上下文完全一致的精确命中（1.0 + 0.03）；上下文只差页码的页眉也是 hint 页胜出。
 * - 压不过别处明显更好的命中：别处的基础分比 hint 页高出 0.15 − 该页加分（相邻页 0.12、远处约 0.15）以上时选别处，
 *   相当于上下文相似度高出约 0.25–0.3。
 * 返回的 score 仍是不含加分的基础分。
 */
const HINT_BONUS = 0.15;
const HINT_DECAY = 0.2;

interface Candidate {
  k: number; // pages 数组下标
  start: number;
  end: number;
  score: number;
}

export interface QuoteMatch {
  page: number;
  start: number;
  end: number;
  /**
   * 0..1，不含 hint 加分。精确命中为 0.5 + 0.5 × 上下文相似度（上下文完全一致时为 1）；
   * 忽略空白/连字符差异的宽松命中为 0.4 + 0.5 × 上下文相似度；
   * exact 本身有改动、靠前后文定位的命中为 0.2 + 0.3 × exact 相似度。
   */
  score: number;
}

/**
 * 在多页规范化文本中重新定位引用。先精确查找；多处命中按 prefix/suffix 相似度选最优，
 * hint.page 及其附近的页有少量加分（规则见 HINT_BONUS）；精确命中都不够好时再忽略空白与连字符差异查找；
 * 仍找不到时用前后文夹出改动过的 exact。都失败返回 null。加分后仍平局时取页码小、位置靠前的。
 */
export function findQuote(
  pages: { page: number; text: string }[],
  quote: QuoteSelector,
  hint?: { page?: number },
): QuoteMatch | null {
  const exact = quote.exact ?? "";
  const exactLoose = loosen(exact).text;
  if (!exactLoose) return null;
  const prefLoose = loosen(quote.prefix ?? "").text;
  const sufLoose = loosen(quote.suffix ?? "").text;

  const getLoose = (k: number): Loose => {
    const pg = pages[k];
    const text = pg.text ?? "";
    let l = looseCache.get(pg);
    if (!l || l.src !== text) {
      l = loosen(text);
      looseCache.set(pg, l);
    }
    return l;
  };

  /** 宽松坐标 [ls, le) 处的上下文相似度 */
  const contextSim = (L: Loose, ls: number, le: number): number => {
    let total = 0;
    let weight = 0;
    if (prefLoose.length) {
      const before = L.text.slice(Math.max(0, ls - prefLoose.length), ls);
      total += similarity(prefLoose, before) * prefLoose.length;
      weight += prefLoose.length;
    }
    if (sufLoose.length) {
      const after = L.text.slice(le, le + sufLoose.length);
      total += similarity(sufLoose, after) * sufLoose.length;
      weight += sufLoose.length;
    }
    return weight ? total / weight : 1;
  };

  const cands: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Candidate) => {
    const key = `${c.k}:${c.start}:${c.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    cands.push(c);
  };
  const hp = hint?.page;
  let bestCtx = -1; // 精确命中的最佳上下文相似度（有 hint 时只看 hint 页）

  // 1. 精确查找
  if (exact.length) {
    pages.forEach((pg, k) => {
      const text = pg.text ?? "";
      for (let i = text.indexOf(exact); i >= 0; i = text.indexOf(exact, i + 1)) {
        const L = getLoose(k);
        const ctx = contextSim(L, L.fromRaw[i], L.fromRaw[i + exact.length]);
        if (hp === undefined || pg.page === hp) bestCtx = Math.max(bestCtx, ctx);
        push({ k, start: i, end: i + exact.length, score: SCORE_EXACT + SCORE_CONTEXT_WEIGHT * ctx });
      }
    });
  }

  // 2. 宽松查找：精确命中的上下文都不太像时（有 hint 时指 hint 页上没有好的精确命中，
  //    这样 hint 页上排版略有变化的原位置也能参与比较，不被别处的页眉等精确重复挡住）
  if (bestCtx < 0.9) {
    pages.forEach((_, k) => {
      const L = getLoose(k);
      for (let i = L.text.indexOf(exactLoose); i >= 0; i = L.text.indexOf(exactLoose, i + 1)) {
        const le = i + exactLoose.length;
        const ctx = contextSim(L, i, le);
        push({ k, start: L.toRaw[i], end: L.toRaw[le - 1] + 1, score: SCORE_LOOSE + SCORE_CONTEXT_WEIGHT * ctx });
      }
    });
  }

  // 3. exact 本身改过：用紧邻的前后文夹出中间文本，要求长度和内容都相近
  if (cands.length === 0) {
    const pTail = prefLoose.slice(-BRIDGE_CONTEXT);
    const sHead = sufLoose.slice(0, BRIDGE_CONTEXT);
    if (pTail.length >= BRIDGE_MIN_CONTEXT && sHead.length >= BRIDGE_MIN_CONTEXT) {
      const el = exactLoose.length;
      pages.forEach((_, k) => {
        const L = getLoose(k);
        for (let i = L.text.indexOf(pTail); i >= 0; i = L.text.indexOf(pTail, i + 1)) {
          const from = i + pTail.length;
          const j = L.text.indexOf(sHead, from);
          if (j <= from) continue;
          const gap = j - from;
          if (gap > el * 1.5 + 8 || gap < el * 0.5 - 8) continue;
          const sim = similarity(exactLoose, L.text.slice(from, j));
          if (sim < BRIDGE_MIN_SIM) continue;
          push({ k, start: L.toRaw[from], end: L.toRaw[j - 1] + 1, score: 0.2 + 0.3 * sim });
        }
      });
    }
  }

  if (cands.length === 0) return null;

  const rank = (c: Candidate) =>
    hp === undefined ? c.score : c.score + HINT_BONUS * Math.pow(HINT_DECAY, Math.abs(pages[c.k].page - hp));
  const EPS = 1e-9;
  let best = cands[0];
  let bestRank = rank(best);
  for (let m = 1; m < cands.length; m++) {
    const c = cands[m];
    const r = rank(c);
    if (r > bestRank + EPS) {
      best = c;
      bestRank = r;
      continue;
    }
    if (r < bestRank - EPS) continue;
    // 平局：页码小、位置靠前的优先
    const pc = pages[c.k].page;
    const pb = pages[best.k].page;
    if (pc < pb || (pc === pb && c.start < best.start)) {
      best = c;
      bestRank = r;
    }
  }
  return { page: pages[best.k].page, start: best.start, end: best.end, score: best.score };
}
