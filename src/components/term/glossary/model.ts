// 术语表的纯逻辑：筛选、搜索、排序、计数、出现位置分组。不碰数据库和 DOM。
import type { GlossaryFilter, GlossarySort } from "@/app/stores/glossary";
import { matchesAll } from "@/components/library/search";
import { buildDomainTree, countPapersByDomain, domainPath, flattenTree, getSubtreeIds } from "@/services/domainTree";
import type { TermStatsRecord } from "@/db/repo/occurrences";
import { t } from "@/i18n";
import type { Domain, Occurrence, Paper, Term } from "@/types/models";

// ---------- 统计 ----------

export interface TermStats {
  /** 出现在多少篇论文 */
  papers: number;
  /** 全库总次数 */
  count: number;
}

/** 按术语汇总；给出 alivePapers 时忽略论文已不存在的记录（与详情里的分组一致） */
export function aggregateOccurrences(
  rows: readonly Pick<Occurrence, "termId" | "paperId" | "count">[],
  alivePapers?: ReadonlySet<string>,
): Map<string, TermStats> {
  const out = new Map<string, TermStats>();
  for (const r of rows) {
    if (alivePapers && !alivePapers.has(r.paperId)) continue;
    const s = out.get(r.termId);
    if (s) {
      s.papers++;
      s.count += r.count;
    } else out.set(r.termId, { papers: 1, count: r.count });
  }
  return out;
}

/** Worker 维护的统计记录 → Map */
export function statsFromRecord(rec: TermStatsRecord): Map<string, TermStats> {
  const out = new Map<string, TermStats>();
  for (const id in rec.stats) {
    const [papers, count] = rec.stats[id];
    if (papers > 0) out.set(id, { papers, count });
  }
  return out;
}

// ---------- 搜索与筛选 ----------

/** 小写、按空白切分 */
export function tokenize(raw: string): string[] {
  return raw.toLowerCase().split(/\s+/).filter(Boolean);
}

export function termHaystack(t: Pick<Term, "name" | "aliases" | "note">): string {
  return `${t.name}\n${(t.aliases ?? []).join("\n")}\n${t.note ?? ""}`;
}

/** 名称、别名、笔记中包含全部关键词（不区分大小写）；没有关键词时总是匹配 */
export function termMatchesQuery(t: Pick<Term, "name" | "aliases" | "note">, tokens: string[]): boolean {
  return tokens.length === 0 || matchesAll(termHaystack(t), tokens);
}

/** 限定领域、但领域列表为空或领域都已删除：不在任何论文中生效 */
export function isUnscoped(t: Pick<Term, "scope">, existingDomainIds: ReadonlySet<string>): boolean {
  return t.scope.kind === "domains" && !t.scope.domainIds.some((d) => existingDomainIds.has(d));
}

export interface FilterContext {
  existing: ReadonlySet<string>;
  /** 领域自身 + 子孙 */
  subtree(domainId: string): ReadonlySet<string>;
}

export function makeFilterContext(domains: Domain[]): FilterContext {
  const cache = new Map<string, Set<string>>();
  return {
    existing: new Set(domains.map((d) => d.id)),
    subtree(id) {
      let s = cache.get(id);
      if (!s) {
        s = new Set(getSubtreeIds(domains, id));
        cache.set(id, s);
      }
      return s;
    },
  };
}

/** 领域筛选：作用范围包含该领域或其任一子领域的术语 */
export function matchesFilter(t: Pick<Term, "scope">, filter: GlossaryFilter, ctx: FilterContext): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "global":
      return t.scope.kind === "global";
    case "unscoped":
      return isUnscoped(t, ctx.existing);
    case "domain": {
      if (t.scope.kind !== "domains") return false;
      const sub = ctx.subtree(filter.id);
      return t.scope.domainIds.some((d) => sub.has(d));
    }
  }
}

export function filterTerms<T extends Term>(terms: readonly T[], filter: GlossaryFilter, tokens: string[], ctx: FilterContext): T[] {
  return terms.filter((t) => matchesFilter(t, filter, ctx) && termMatchesQuery(t, tokens));
}

export interface FilterCounts {
  all: number;
  global: number;
  unscoped: number;
  /** 每个领域（含子领域）下的术语数 */
  byDomain: Map<string, number>;
}

export function countByFilter(terms: readonly Pick<Term, "scope">[], domains: Domain[]): FilterCounts {
  const existing = new Set(domains.map((d) => d.id));
  let global = 0;
  let unscoped = 0;
  const scoped: { domainIds: string[] }[] = [];
  for (const t of terms) {
    if (t.scope.kind === "global") global++;
    else {
      if (isUnscoped(t, existing)) unscoped++;
      scoped.push({ domainIds: t.scope.domainIds });
    }
  }
  return { all: terms.length, global, unscoped, byDomain: countPapersByDomain(domains, scoped) };
}

// ---------- 排序 ----------

const collator = new Intl.Collator("zh-CN", { sensitivity: "base", numeric: true });

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

/** 名称为次序键；desc 只反转主键 */
export function sortTerms<T extends Term>(terms: readonly T[], sort: GlossarySort, stats?: ReadonlyMap<string, TermStats>): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byName = (a: T, b: T) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let primary: (a: T, b: T) => number;
  switch (sort.key) {
    case "name":
      return [...terms].sort((a, b) => sign * byName(a, b));
    case "occurrences": {
      const get = (t: T) => stats?.get(t.id) ?? { papers: 0, count: 0 };
      primary = (a, b) => {
        const x = get(a);
        const y = get(b);
        return x.count - y.count || x.papers - y.papers;
      };
      break;
    }
    case "updated":
      primary = (a, b) => a.updatedAt - b.updatedAt;
      break;
  }
  return [...terms].sort((a, b) => sign * primary(a, b) || byName(a, b));
}

// ---------- 展示 ----------

export interface ScopeTag {
  id: string;
  path: string;
  color: string;
}

export type ScopeSummary = { kind: "global" } | { kind: "none" } | { kind: "domains"; tags: ScopeTag[] };

export function scopeSummary(t: Pick<Term, "scope">, domainById: ReadonlyMap<string, Domain>): ScopeSummary {
  if (t.scope.kind === "global") return { kind: "global" };
  const byId = domainById as Map<string, Domain>;
  const tags = t.scope.domainIds
    .filter((id) => byId.has(id))
    .map((id) => ({ id, path: domainPath(byId, id), color: byId.get(id)!.color }));
  return tags.length ? { kind: "domains", tags } : { kind: "none" };
}

/** 列表行里的别名摘要 */
export function aliasExcerpt(aliases: readonly string[], max = 4): string {
  if (!aliases.length) return "";
  const head = aliases.slice(0, max).join(", ");
  return aliases.length > max ? t.term.glossary.list.aliasMore(head, aliases.length) : head;
}

/** [1,2,3,7,9] → "1–3, 7, 9"；超过 max 段时截断 */
export function formatPages(pages: readonly number[], max = 6): string {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(j > i ? `${pages[i]}–${pages[j]}` : `${pages[i]}`);
    i = j + 1;
  }
  return parts.length > max ? `${parts.slice(0, max).join(", ")} …` : parts.join(", ");
}

/** 当天显示时刻，当年显示月日，否则显示年月日 */
export function formatShortDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const pad = (x: number) => String(x).padStart(2, "0");
  if (d.toDateString() === n.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear()) return t.term.glossary.list.monthDay(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 笔记里第一个关键词附近的片段（去掉 Markdown 标记的粗略版本） */
export function noteSnippet(note: string, tokens: string[], width = 72): string | undefined {
  const plain = note
    .replace(/[`*_#>[\]()$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  const lower = plain.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return undefined;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(plain.length, start + width);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
}

// ---------- 出现位置 ----------

export interface PaperOccurrence {
  paper: Paper;
  pages: number[];
  count: number;
  /** 结果来自旧版规则，后台更新后会被替换 */
  updating: boolean;
}

export interface OccurrenceGroup {
  /** 领域 id；未分类为 "" */
  key: string;
  label: string;
  color: string | null;
  papers: PaperOccurrence[];
  /** 组内总次数 */
  count: number;
}

export interface GroupedOccurrences {
  groups: OccurrenceGroup[];
  paperCount: number;
  total: number;
  /** 待更新的论文数 */
  updating: number;
}

/**
 * 按论文所属领域分组（与领域树顺序一致，未分类在最后）。属于多个领域的论文在每个组里各出现一次。
 * 组内按次数降序、标题升序。论文已不存在的记录忽略。
 */
export function groupOccurrencesByDomain(
  occs: readonly Occurrence[],
  paperById: ReadonlyMap<string, Paper>,
  domains: Domain[],
  isUpdating: (o: Occurrence) => boolean = () => false,
): GroupedOccurrences {
  const byId = new Map(domains.map((d) => [d.id, d]));
  const buckets = new Map<string, PaperOccurrence[]>();
  let paperCount = 0;
  let total = 0;
  let updating = 0;
  for (const o of occs) {
    const paper = paperById.get(o.paperId);
    if (!paper || o.count <= 0) continue;
    paperCount++;
    total += o.count;
    const item: PaperOccurrence = { paper, pages: o.pages, count: o.count, updating: isUpdating(o) };
    if (item.updating) updating++;
    const keys = [...new Set(paper.domainIds.filter((d) => byId.has(d)))];
    for (const k of keys.length ? keys : [""]) {
      const list = buckets.get(k);
      if (list) list.push(item);
      else buckets.set(k, [item]);
    }
  }
  const order = flattenTree(buildDomainTree(domains)).map((n) => n.domain.id);
  const groups: OccurrenceGroup[] = [];
  for (const k of [...order, ""]) {
    const list = buckets.get(k);
    if (!list) continue;
    list.sort((a, b) => b.count - a.count || compareNames(a.paper.title, b.paper.title));
    groups.push({
      key: k,
      label: k ? domainPath(byId, k) : t.term.glossary.detail.unfiled,
      color: k ? byId.get(k)!.color : null,
      papers: list,
      count: list.reduce((n, p) => n + p.count, 0),
    });
  }
  return { groups, paperCount, total, updating };
}
