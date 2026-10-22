// 术语冲突检测（纯函数）：另一个术语有相同的表面形式（会命中同一段文字）且作用范围重叠。
// 冲突不阻止保存：重叠处的弹窗会列出全部候选（开发文档第 8 节"同一缩写在不同领域含义不同"）。
import { surfaceForms, type SurfaceForm } from "@/engine/matcher";
import { toLowerAligned } from "@/engine/normalize";
import type { TermLike } from "@/engine/types";
import type { TermScope } from "@/types/models";

export interface FormEntry {
  termId: string;
  form: string;
  caseSensitive: boolean;
}

/** 全部术语的表面形式索引：小写形式 → 条目 */
export type FormIndex = Map<string, FormEntry[]>;

export function buildFormIndex(terms: readonly TermLike[]): FormIndex {
  const index: FormIndex = new Map();
  for (const t of terms) {
    for (const f of surfaceForms(t)) {
      const key = toLowerAligned(f.form);
      const list = index.get(key);
      const entry = { termId: t.id, form: f.form, caseSensitive: f.caseSensitive };
      if (list) list.push(entry);
      else index.set(key, [entry]);
    }
  }
  return index;
}

/** 两个表面形式能否命中同一段文字。都区分大小写时须完全相同，否则小写相同即可 */
export function formsCollide(a: Pick<SurfaceForm, "form" | "caseSensitive">, b: Pick<SurfaceForm, "form" | "caseSensitive">): boolean {
  if (a.caseSensitive && b.caseSensitive) return a.form === b.form;
  return toLowerAligned(a.form) === toLowerAligned(b.form);
}

/** d 本身及其全部祖先（防环） */
function selfAndAncestors(d: string, parent: ReadonlyMap<string, string | null>): Set<string> {
  const out = new Set<string>();
  let cur: string | null | undefined = d;
  while (cur != null && !out.has(cur)) {
    out.add(cur);
    cur = parent.get(cur);
  }
  return out;
}

/** 每篇论文的领域闭包（所属领域及其全部祖先）。预先算好，供判断"有没有论文同时落在两个作用范围内" */
export function paperDomainClosures(
  papers: readonly (readonly string[])[],
  parent: ReadonlyMap<string, string | null>,
): ReadonlySet<string>[] {
  return papers
    .filter((ids) => ids.length > 0)
    .map((ids) => {
      const out = new Set<string>();
      for (const d of ids) for (const x of selfAndAncestors(d, parent)) out.add(x);
      return out;
    });
}

/** tree：领域相同或互为祖先 / 全局；paper：领域互不相干，但有论文同时属于两边 */
export type OverlapKind = "tree" | "paper";

const empty = (s: TermScope) => s.kind === "domains" && (!s.domainIds || s.domainIds.length === 0);
const covers = (s: TermScope, closure: ReadonlySet<string>) => s.kind !== "domains" || s.domainIds.some((d) => closure.has(d));

/**
 * 两个作用范围是否可能同时生效，以及原因。领域 a 与 b 相同、或一个是另一个的祖先时重叠（子领域继承上级的术语）；
 * 否则若给了论文的领域闭包，有论文同时落在两个范围内（一篇论文属于多个领域）也算重叠。
 * domains 为空的范围不在任何地方生效，与谁都不重叠。
 */
export function scopeOverlap(
  a: TermScope,
  b: TermScope,
  parent: ReadonlyMap<string, string | null>,
  paperClosures?: readonly ReadonlySet<string>[],
): OverlapKind | null {
  if (empty(a) || empty(b)) return null;
  if (a.kind === "global" || b.kind === "global") return "tree";
  for (const x of a.domainIds) {
    const xUp = selfAndAncestors(x, parent);
    for (const y of b.domainIds) {
      if (xUp.has(y) || selfAndAncestors(y, parent).has(x)) return "tree";
    }
  }
  if (paperClosures?.some((c) => covers(a, c) && covers(b, c))) return "paper";
  return null;
}

export function scopesOverlap(
  a: TermScope,
  b: TermScope,
  parent: ReadonlyMap<string, string | null>,
  paperClosures?: readonly ReadonlySet<string>[],
): boolean {
  return scopeOverlap(a, b, parent, paperClosures) !== null;
}

/** 同时落在两个作用范围内的论文数 */
export function countSharedPapers(a: TermScope, b: TermScope, paperClosures: readonly ReadonlySet<string>[]): number {
  return paperClosures.reduce((n, c) => n + (covers(a, c) && covers(b, c) ? 1 : 0), 0);
}

export interface TermConflict {
  termId: string;
  /** 草稿中与该术语冲突的表面形式 */
  forms: string[];
  /** 重叠原因；paper 时 sharedPapers 为同时落在两个范围内的论文数 */
  via: OverlapKind;
  sharedPapers?: number;
}

/**
 * 草稿与已有术语的冲突。草稿的 id 用于排除自身（编辑时）。
 * 结果按 termsById 的迭代顺序无关的稳定顺序：先按第一个冲突形式在草稿中的位置，再按 id。
 */
export function findConflicts(
  draft: TermLike,
  index: FormIndex,
  termsById: ReadonlyMap<string, TermLike>,
  parent: ReadonlyMap<string, string | null>,
  paperClosures?: readonly ReadonlySet<string>[],
): TermConflict[] {
  const byTerm = new Map<string, { order: number; forms: string[]; via: OverlapKind }>();
  surfaceForms(draft).forEach((f, order) => {
    for (const e of index.get(toLowerAligned(f.form)) ?? []) {
      if (e.termId === draft.id || !formsCollide(f, e)) continue;
      const other = termsById.get(e.termId);
      if (!other) continue;
      const c = byTerm.get(e.termId);
      if (c) {
        if (!c.forms.includes(f.form)) c.forms.push(f.form);
        continue;
      }
      const via = scopeOverlap(draft.scope, other.scope, parent, paperClosures);
      if (via) byTerm.set(e.termId, { order, forms: [f.form], via });
    }
  });
  return [...byTerm.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([termId, c]) => {
      const out: TermConflict = { termId, forms: c.forms, via: c.via };
      if (c.via === "paper" && paperClosures) out.sharedPapers = countSharedPapers(draft.scope, termsById.get(termId)!.scope, paperClosures);
      return out;
    });
}
