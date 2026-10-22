// 出现位置相关的纯函数：当前论文内逐处导航、弹窗里"出现在哪些论文"的分组。
import { fromNormalizedText } from "@/engine/normalize";
import type { TermMatcher } from "@/engine/matcher";
import type { ScopeContext } from "@/engine/types";
import { buildDomainTree, domainPath, flattenTree } from "@/services/domainTree";
import type { Domain, Occurrence, Paper } from "@/types/models";

export interface OccurrencePos {
  page: number; // 从 1 开始
  start: number; // 该页规范化文本中的偏移
  end: number;
}

/** 一篇论文所有页的匹配结果 → 每个术语的出现位置（按页码、偏移升序） */
export function buildOccurrenceIndex(
  pages: readonly { page: number; text: string }[],
  matcher: TermMatcher,
  scope?: ScopeContext,
): Map<string, OccurrencePos[]> {
  const index = new Map<string, OccurrencePos[]>();
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  for (const { page, text } of sorted) {
    if (!text) continue;
    for (const m of matcher.match(fromNormalizedText(text), scope)) {
      for (const id of m.termIds) {
        const list = index.get(id);
        const pos = { page, start: m.start, end: m.end };
        if (list) list.push(pos);
        else index.set(id, [pos]);
      }
    }
  }
  return index;
}

const before = (a: { page: number; start: number }, b: { page: number; start: number }) =>
  a.page < b.page || (a.page === b.page && a.start < b.start);

/**
 * 从当前位置 cur 走到上一处 / 下一处，返回下标；列表为空返回 -1。
 * cur 不必恰好是某一处（如弹窗锚在一个已被删掉的位置）。wrap 为 true 时首尾相接。
 */
export function stepOccurrence(
  list: readonly OccurrencePos[],
  cur: { page: number; start: number },
  dir: 1 | -1,
  wrap = true,
): number {
  if (!list.length) return -1;
  if (dir === 1) {
    const i = list.findIndex((p) => before(cur, p));
    if (i >= 0) return i;
    return wrap ? 0 : -1;
  }
  for (let i = list.length - 1; i >= 0; i--) if (before(list[i], cur)) return i;
  return wrap ? list.length - 1 : -1;
}

/** cur 是第几处（恰好落在某一处上）；不在列表中返回 -1 */
export function occurrenceIndexOf(list: readonly OccurrencePos[], cur: { page: number; start: number }): number {
  return list.findIndex((p) => p.page === cur.page && p.start === cur.start);
}

export interface PaperOccurrence {
  paperId: string;
  title: string;
  count: number;
  /** 第一次出现的页码 */
  firstPage: number;
  /** 结果来自旧规则版本，后台重扫后会更新（次数、页码可能变化） */
  outdated: boolean;
}

export interface OccurrenceGroup {
  /** null = 未归类 */
  domainId: string | null;
  label: string;
  papers: PaperOccurrence[];
}

/**
 * "出现在哪些论文"按领域分组：一篇论文属于多个领域时在每个组里都出现；
 * 组按领域树先序排列，未归类的放最后；组内按次数降序、标题升序。
 * 规则版本过渡期间旧记录照常显示，outdated 中的论文标为"待更新"。
 */
export function groupOccurrences(
  occurrences: readonly Occurrence[],
  papers: ReadonlyMap<string, Pick<Paper, "id" | "title" | "domainIds">>,
  domains: readonly Domain[],
  outdated: ReadonlySet<string> = new Set(),
): OccurrenceGroup[] {
  const byId = new Map(domains.map((d) => [d.id, d]));
  const order = new Map(flattenTree(buildDomainTree([...domains])).map((n, i) => [n.domain.id, i]));
  const groups = new Map<string | null, PaperOccurrence[]>();
  for (const o of occurrences) {
    const p = papers.get(o.paperId);
    if (!p || o.count <= 0 || !o.pages.length) continue;
    const item: PaperOccurrence = { paperId: p.id, title: p.title, count: o.count, firstPage: Math.min(...o.pages), outdated: outdated.has(p.id) };
    const ds = p.domainIds.filter((d) => byId.has(d));
    for (const d of ds.length ? ds : [null]) {
      const list = groups.get(d);
      if (list) list.push(item);
      else groups.set(d, [item]);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : (order.get(a) ?? 0) - (order.get(b) ?? 0)))
    .map(([domainId, list]) => ({
      domainId,
      label: domainId === null ? "未归类" : domainPath(byId, domainId),
      papers: list.sort((x, y) => y.count - x.count || x.title.localeCompare(y.title, "zh-CN")),
    }));
}

/**
 * ↑/↓ 从哪里算起：上一次随弹窗移动的跨页导航还没落定（flash 未处理）时，从它的目标算起，
 * 否则从弹窗当前锚点算起。连按时不会丢步。
 */
export function navigationOrigin(
  anchor: { paperId: string; page: number; start: number },
  pending: { paperId: string; page: number; range?: { start: number }; movePopover?: boolean } | null | undefined,
): { page: number; start: number } {
  if (pending?.movePopover && pending.range && pending.paperId === anchor.paperId) return { page: pending.page, start: pending.range.start };
  return { page: anchor.page, start: anchor.start };
}

/**
 * 术语作用范围离论文领域有多近：论文所属领域本身为 0，其上级为 1，依此类推，取最近的；
 * 全局术语为 Infinity，不在范围内为 NaN。
 */
export function scopeDistance(
  scope: { kind: string; domainIds?: readonly string[] },
  paperDomainIds: readonly string[],
  parent: ReadonlyMap<string, string | null>,
): number {
  if (scope.kind !== "domains") return Infinity;
  const targets = new Set(scope.domainIds ?? []);
  let best = NaN;
  for (const d of paperDomainIds) {
    const seen = new Set<string>();
    let cur: string | null | undefined = d;
    for (let depth = 0; cur != null && !seen.has(cur); depth++) {
      if (targets.has(cur)) {
        if (!(best <= depth)) best = depth;
        break;
      }
      seen.add(cur);
      cur = parent.get(cur);
    }
  }
  return best;
}

/**
 * 多个候选术语时的显示顺序（第一个默认选中）：作用范围离论文领域越近越靠前（子领域的术语优先于上级领域的），
 * 全局术语在领域术语之后；同样近时按名称、再按原顺序。
 */
export function orderCandidates<T extends { id: string; name: string; scope: { kind: string; domainIds?: readonly string[] } }>(
  ids: readonly string[],
  byId: ReadonlyMap<string, T>,
  paperDomainIds: readonly string[] = [],
  parent: ReadonlyMap<string, string | null> = new Map(),
): string[] {
  const key = (id: string) => {
    const t = byId.get(id);
    if (!t) return Number.MAX_VALUE;
    const d = scopeDistance(t.scope, paperDomainIds, parent);
    return Number.isNaN(d) ? Number.MAX_VALUE / 2 : d;
  };
  return ids
    .map((id, i) => ({ id, i, k: key(id), name: byId.get(id)?.name ?? "" }))
    .sort((a, b) => (a.k === b.k ? 0 : a.k < b.k ? -1 : 1) || a.name.localeCompare(b.name, "zh-CN") || a.i - b.i)
    .map((x) => x.id);
}
