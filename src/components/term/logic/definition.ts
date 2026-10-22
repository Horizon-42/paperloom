// 从选区创建术语时的建议（纯函数）：识别缩写、识别 "Long Short-Term Memory (LSTM)" 式的定义。
// 缩写与全称的对应用 Schwartz & Hearst (2003) 的算法：缩写的字符按倒序依次出现在全称中，首字符须在词首。
import { isAcronymLike } from "@/engine/matcher";

/** 看起来像缩写：auto 规则下的"全大写"（允许数字、连字符和末尾复数 s），长度 2–10，至少一个字母 */
export function looksLikeAbbreviation(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 10 || /\s/.test(t)) return false;
  if (!/\p{L}/u.test(t)) return false;
  return isAcronymLike(t);
}

const isAlnum = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** 去掉缩写末尾的复数 s（LSTMs → LSTM） */
function singularShort(short: string): string {
  return short.length > 2 && short.endsWith("s") && /\p{Lu}/u.test(short[short.length - 2]) ? short.slice(0, -1) : short;
}

/**
 * Schwartz–Hearst findBestLongForm：在候选全称 candidate 中找与缩写对应的最短后缀全称。
 * 找不到返回 null。
 */
export function matchLongForm(short: string, candidate: string): string | null {
  const s = singularShort(short.trim());
  const long = candidate.trim();
  if (!s || !long || long.length <= s.length) return null;
  let si = s.length - 1;
  let li = long.length - 1;
  while (si >= 0) {
    const c = s[si].toLowerCase();
    if (!isAlnum(c)) {
      si--;
      continue;
    }
    // 首字符必须落在词首
    while (li >= 0 && (long[li].toLowerCase() !== c || (si === 0 && li > 0 && isAlnum(long[li - 1])))) li--;
    if (li < 0) return null;
    li--;
    si--;
  }
  // 扩到所在词的开头
  let start = li + 1;
  while (start > 0 && !/[\s([{"“]/u.test(long[start - 1])) start--;
  const out = long.slice(start).trim();
  // 全称至少两个词或比缩写长得多，且不能包含缩写本身
  if (!/\s|-/.test(out) && out.length < s.length * 2) return null;
  if (out.includes(s)) return null;
  return out;
}

/** 候选全称取括号前最多 min(|A|+5, 2|A|) 个词（Schwartz–Hearst 的窗口） */
function candidateBefore(before: string, short: string): string {
  const n = singularShort(short).replace(/[^\p{L}\p{N}]/gu, "").length;
  const max = Math.min(n + 5, n * 2);
  // 只看最后一个句末标点之后的部分
  // 句末标点含全角的 。；：！？（写成转义，界面文案检查只认字面中文）
  const clause = before.split(/[.;:!?\u3002\uff1b\uff1a\uff01\uff1f]\s|\n/).pop() ?? before;
  const words = clause.trim().split(/\s+/).filter(Boolean);
  return words.slice(-max).join(" ");
}

/** 在一段文本中查找 "全称 (缩写)" 定义，返回去重后的全称（按出现顺序） */
export function findDefinitions(text: string, short: string): string[] {
  const s = short.trim();
  if (!s) return [];
  const out: string[] = [];
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\(\\s*${esc}s?\\s*[),;]`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const long = matchLongForm(s, candidateBefore(text.slice(0, m.index), s));
    if (long && !out.includes(long)) out.push(long);
  }
  return out;
}

/**
 * 建议的依据（界面上据此生成说明）：selection 选区本身是定义句式，before / after 前文 / 后文给出定义，
 * page 本页其他地方的定义（text 为 "全称 (缩写)" 之类的原文）；abbreviation 后文给出缩写（text 为缩写）
 */
export interface DefinitionReason {
  kind: "selection" | "before" | "after" | "page" | "abbreviation";
  text: string;
}

export interface DefinitionSuggestion {
  name: string;
  aliases: string[];
  reason: DefinitionReason;
}

/**
 * 根据选中文字及其前后文给出"名称 + 别名"建议。识别：
 * - 选中 "Long Short-Term Memory (LSTM)" 整体；
 * - 选中缩写，前文以 "全称 (" 结尾，或后文以 " (全称)" 开头；
 * - 选中全称，后文以 " (缩写)" 开头；
 * - 选中缩写，页内其他地方有 "全称 (缩写)" 定义（pageText）。
 */
export function suggestFromSelection(selected: string, before = "", after = "", pageText = ""): DefinitionSuggestion | null {
  const sel = selected.replace(/\s+/g, " ").trim();
  if (!sel) return null;

  // 选区本身就是 "全称 (缩写)" 或 "缩写 (全称)"
  const whole = /^(.+?)\s*\(\s*([^()]+?)\s*\)$/u.exec(sel);
  if (whole) {
    const [, a, b] = whole;
    if (looksLikeAbbreviation(b)) {
      const long = matchLongForm(b, a);
      if (long) return { name: long, aliases: [b], reason: { kind: "selection", text: `${long} (${b})` } };
    }
    if (looksLikeAbbreviation(a)) {
      const long = matchLongForm(a, b);
      if (long) return { name: long, aliases: [a], reason: { kind: "selection", text: `${a} (${long})` } };
    }
  }

  if (looksLikeAbbreviation(sel)) {
    // 前文 "… 全称 (" + 缩写 + ")"
    const open = /\(\s*$/u.exec(before);
    if (open && /^\s*[),;]/u.test(after)) {
      const long = matchLongForm(sel, candidateBefore(before.slice(0, open.index), sel));
      if (long) return { name: long, aliases: [sel], reason: { kind: "before", text: `${long} (${sel})` } };
    }
    // 缩写 + " (全称)"
    const paren = /^\s*\(\s*([^()]{3,80}?)\s*\)/u.exec(after);
    if (paren) {
      const long = matchLongForm(sel, paren[1]);
      if (long) return { name: long, aliases: [sel], reason: { kind: "after", text: `${sel} (${long})` } };
    }
    // 页内其他地方的定义
    const defs = findDefinitions(pageText, sel);
    if (defs.length) return { name: defs[0], aliases: [sel], reason: { kind: "page", text: `${defs[0]} (${sel})` } };
    return null;
  }

  // 选中全称，后面紧跟 "(缩写)"
  const abbr = /^\s*\(\s*([^\s()]{2,10}?)s?\s*[),;]/u.exec(after);
  if (abbr && looksLikeAbbreviation(abbr[1])) {
    const long = matchLongForm(abbr[1], sel);
    if (long === sel) return { name: sel, aliases: [abbr[1]], reason: { kind: "abbreviation", text: abbr[1] } };
  }
  return null;
}
