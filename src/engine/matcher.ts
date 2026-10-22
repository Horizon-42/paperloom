// 第 6 节第 2 步：术语表面形式派生、两个 Aho-Corasick 自动机（区分 / 不区分大小写）、
// 词边界检查、作用范围过滤与重叠消解。
import { AhoCorasick } from "./ahoCorasick";
import {
  codePointAtIndex,
  codePointBeforeIndex,
  isLowerLetter,
  isSpacedWordChar,
  isUpperLetter,
  isLetter,
  normalizeString,
  toLowerAligned,
} from "./normalize";
import type { NormalizedText, ScopeContext, TermLike, TermMatch } from "./types";

export interface SurfaceForm {
  form: string;
  caseSensitive: boolean;
}

/**
 * auto 模式下是否区分大小写：至少有一个大写字母且没有小写字母（ATM、LSTM、4D-TP）。
 * 末尾的复数 s 不计入（LSTMs、CNNs 仍视为缩写）。
 */
export function isAcronymLike(form: string): boolean {
  let end = form.length;
  if (end >= 3 && form.charCodeAt(end - 1) === 0x73 && isUpperLetter(form.codePointAt(end - 2)!)) end--;
  let hasUpper = false;
  for (let i = 0; i < end; i++) {
    const cp = form.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (isLowerLetter(cp)) return false;
    if (isUpperLetter(cp)) hasUpper = true;
  }
  return hasUpper;
}

function collapseSpaces(s: string): string {
  return s.replace(/ {2,}/g, " ").trim();
}

/** 连字符变体：含 "-" 的派生"空格"和"直接相连"写法；含空格的多词形式派生连字符写法 */
function spellingVariants(base: string): string[] {
  const out = [base];
  if (base.includes("-")) {
    out.push(collapseSpaces(base.replace(/-/g, " ")));
    out.push(collapseSpaces(base.replace(/-/g, "")));
  }
  if (base.includes(" ")) out.push(base.replace(/ /g, "-"));
  return out.filter((s) => s.length > 0);
}

/**
 * 派生复数。以 s/x/z/ch/sh 结尾加 es，辅音 + y 结尾改 ies，否则加 s；缩写加小写 s（LSTM → LSTMs）。
 * 以数字、中日韩字符或符号结尾的形式不派生。
 */
function pluralOf(form: string): string | null {
  const last = codePointBeforeIndex(form, form.length);
  if (!isLetter(last) || !isSpacedWordChar(last)) return null;
  if (isAcronymLike(form)) {
    return form.endsWith("s") ? null : form + "s";
  }
  const lw = toLowerAligned(form);
  if (/(?:s|x|z|ch|sh)$/.test(lw)) return form + "es";
  if (form.endsWith("y") && /[^aeiou]y$/.test(lw)) return form.slice(0, -1) + "ies";
  return form + "s";
}

/** 术语的全部表面形式（已规范化、去重，顺序稳定：名称在前、别名在后） */
export function surfaceForms(term: TermLike): SurfaceForm[] {
  const out: SurfaceForm[] = [];
  const seen = new Set<string>();
  const add = (form: string, caseSensitive: boolean) => {
    if (!form || form.includes("\n")) return;
    const key = caseSensitive ? "S\u0000" + form : "I\u0000" + toLowerAligned(form);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ form, caseSensitive });
  };
  for (const raw of [term.name, ...(term.aliases ?? [])]) {
    const base = normalizeString(raw ?? "");
    if (!base) continue;
    const cs =
      term.matchMode === "caseSensitive" ? true : term.matchMode === "caseInsensitive" ? false : isAcronymLike(base);
    for (const v of spellingVariants(base)) {
      add(v, cs);
      const pl = pluralOf(v);
      if (pl) add(pl, cs);
    }
  }
  // 区分大小写的形式若已被同形的不区分大小写形式覆盖，就去掉
  return out.filter((f) => !f.caseSensitive || !seen.has("I\u0000" + toLowerAligned(f.form)));
}

/** 论文所属领域及其全部祖先（防环） */
export function domainClosure(scope: ScopeContext): Set<string> {
  const out = new Set<string>();
  for (const d of scope.paperDomainIds) {
    let cur: string | null | undefined = d;
    while (cur != null && !out.has(cur)) {
      out.add(cur);
      cur = scope.domainParent.get(cur);
    }
  }
  return out;
}

function inScopeWith(term: TermLike, closure: Set<string>): boolean {
  if (term.scope.kind !== "domains") return true;
  const ids = term.scope.domainIds;
  if (!ids || ids.length === 0) return false;
  for (const id of ids) if (closure.has(id)) return true;
  return false;
}

/** 论文属于术语的任一领域或其子孙领域时在范围内；domainIds 为空表示不在任何地方生效 */
export function isTermInScope(term: TermLike, scope: ScopeContext): boolean {
  if (term.scope.kind !== "domains") return true;
  return inScopeWith(term, domainClosure(scope));
}

/**
 * 词边界：命中首字符若是用空格分词的文字（拉丁、希腊、西里尔字母、数字等），前一个字符不能是这类字母或数字；
 * 末字符同理。首/末字符是中日韩字符或符号时不检查该侧。
 */
export function isWordBoundaryMatch(text: string, start: number, end: number): boolean {
  if (isSpacedWordChar(codePointAtIndex(text, start))) {
    const prev = codePointBeforeIndex(text, start);
    if (prev >= 0 && isSpacedWordChar(prev)) return false;
  }
  if (isSpacedWordChar(codePointBeforeIndex(text, end))) {
    const next = codePointAtIndex(text, end);
    if (next >= 0 && isSpacedWordChar(next)) return false;
  }
  return true;
}

/** 一个自动机及其模式 → 术语下标列表 */
interface FormIndex {
  ac: AhoCorasick;
  terms: number[][];
}

function buildIndex(map: Map<string, number[]>): FormIndex {
  const patterns = Array.from(map.keys());
  return { ac: new AhoCorasick(patterns), terms: Array.from(map.values()) };
}

export class TermMatcher {
  readonly terms: readonly TermLike[];
  private readonly sensitive: FormIndex;
  private readonly insensitive: FormIndex;

  constructor(terms: TermLike[]) {
    this.terms = terms.slice();
    const cs = new Map<string, number[]>();
    const ci = new Map<string, number[]>();
    this.terms.forEach((term, ti) => {
      for (const f of surfaceForms(term)) {
        const map = f.caseSensitive ? cs : ci;
        const key = f.caseSensitive ? f.form : toLowerAligned(f.form);
        const list = map.get(key);
        if (!list) map.set(key, [ti]);
        else if (list[list.length - 1] !== ti) list.push(ti);
      }
    });
    this.sensitive = buildIndex(cs);
    this.insensitive = buildIndex(ci);
  }

  /** 匹配一页规范化文本。不传 scope 时不做作用范围过滤 */
  match(nt: NormalizedText, scope?: ScopeContext): TermMatch[] {
    const text = nt.text;
    const lower = nt.lower && nt.lower.length === text.length ? nt.lower : toLowerAligned(text);

    // 作用范围：按需逐个术语计算并缓存（0 未知，1 在范围内，2 不在）
    let allowed: ((ti: number) => boolean) | null = null;
    if (scope) {
      const closure = domainClosure(scope);
      const state = new Uint8Array(this.terms.length);
      allowed = (ti) => {
        let s = state[ti];
        if (s === 0) {
          s = inScopeWith(this.terms[ti], closure) ? 1 : 2;
          state[ti] = s;
        }
        return s === 1;
      };
    }

    const starts: number[] = [];
    const ends: number[] = [];
    const lists: number[][] = [];
    const collect = (index: FormIndex, haystack: string) => {
      const { ac, terms } = index;
      ac.search(haystack, (p, end) => {
        const start = end - ac.lengths[p];
        if (!isWordBoundaryMatch(text, start, end)) return;
        let ts = terms[p];
        if (allowed) {
          ts = ts.filter(allowed);
          if (ts.length === 0) return;
        }
        starts.push(start);
        ends.push(end);
        lists.push(ts);
      });
    };
    collect(this.sensitive, text);
    collect(this.insensitive, lower);

    // 重叠消解：按起点排序，同起点最长优先；与已保留区间重叠的丢弃；完全相同的区间合并候选
    const order = starts.map((_, k) => k);
    order.sort((a, b) => starts[a] - starts[b] || ends[b] - ends[a]);
    const out: TermMatch[] = [];
    let curStart = -1;
    let curEnd = -1;
    let curTerms: number[] | null = null;
    const flush = () => {
      if (!curTerms) return;
      const uniq = Array.from(new Set(curTerms)).sort((a, b) => a - b);
      out.push({ termIds: uniq.map((ti) => this.terms[ti].id), start: curStart, end: curEnd });
      curTerms = null;
    };
    for (const k of order) {
      const s = starts[k];
      const e = ends[k];
      if (curTerms && s === curStart && e === curEnd) {
        curTerms.push(...lists[k]);
      } else if (s >= curEnd) {
        flush();
        curStart = s;
        curEnd = e;
        curTerms = lists[k].slice();
      }
    }
    flush();
    return out;
  }
}
