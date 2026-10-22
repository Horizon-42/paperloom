// 领域树纯逻辑：不碰数据库和 DOM，供 domainService 和界面共用。
import type { Domain, Paper } from "@/types/models";

export interface DomainNode {
  domain: Domain;
  depth: number;
  children: DomainNode[];
}

export type DropPosition = "before" | "after" | "inside";

/** 拖放目标：targetId 为 null 且 position 为 "inside" 表示移到顶层末尾 */
export interface DomainDrop {
  targetId: string | null;
  position: DropPosition;
}

export interface DomainPlacement {
  id: string;
  parentId: string | null;
  order: number;
}

export function compareDomains(a: Domain, b: Domain): number {
  return a.order - b.order || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id);
}

function indexById(domains: Domain[]): Map<string, Domain> {
  return new Map(domains.map((d) => [d.id, d]));
}

/** 父领域不存在时视为顶层，避免脏数据让节点"消失" */
export function effectiveParentId(byId: Map<string, Domain>, d: Domain): string | null {
  return d.parentId !== null && byId.has(d.parentId) && d.parentId !== d.id ? d.parentId : null;
}

/** 某个父领域下的直接子领域（已排序）；parentId 为 null 表示顶层 */
export function childrenOf(domains: Domain[], parentId: string | null): Domain[] {
  const byId = indexById(domains);
  return domains.filter((d) => effectiveParentId(byId, d) === parentId).sort(compareDomains);
}

export function buildDomainTree(domains: Domain[]): DomainNode[] {
  const byId = indexById(domains);
  const kids = new Map<string | null, Domain[]>();
  for (const d of domains) {
    const p = effectiveParentId(byId, d);
    const list = kids.get(p);
    if (list) list.push(d);
    else kids.set(p, [d]);
  }
  for (const list of kids.values()) list.sort(compareDomains);

  const visited = new Set<string>();
  const build = (d: Domain, depth: number): DomainNode => {
    visited.add(d.id);
    const children = (kids.get(d.id) ?? []).filter((c) => !visited.has(c.id)).map((c) => build(c, depth + 1));
    return { domain: d, depth, children };
  };
  const roots = (kids.get(null) ?? []).map((d) => build(d, 0));
  // 数据里若已存在环，环上的节点从顶层不可达：把它们挂到顶层，保证每个领域都能显示
  for (const d of [...domains].sort(compareDomains)) {
    if (!visited.has(d.id)) roots.push(build(d, 0));
  }
  return roots;
}

/** 按树的先序展开；expanded 判断哪些节点展开（缺省全部展开） */
export function flattenTree(tree: DomainNode[], isExpanded: (id: string) => boolean = () => true): DomainNode[] {
  const out: DomainNode[] = [];
  const walk = (nodes: DomainNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length && isExpanded(n.domain.id)) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** 所有子孙领域的 id（不含自身） */
export function getDescendantIds(domains: Domain[], id: string): Set<string> {
  const byId = indexById(domains);
  const kids = new Map<string, string[]>();
  for (const d of domains) {
    const p = effectiveParentId(byId, d);
    if (p !== null) kids.set(p, [...(kids.get(p) ?? []), d.id]);
  }
  const out = new Set<string>();
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === id || out.has(cur)) continue;
    out.add(cur);
    stack.push(...(kids.get(cur) ?? []));
  }
  return out;
}

/** 自身 + 子孙 */
export function getSubtreeIds(domains: Domain[], id: string): string[] {
  return [id, ...getDescendantIds(domains, id)];
}

/** 把 dragId 挂到 newParentId 下是否会形成环 */
export function wouldCreateCycle(domains: Domain[], dragId: string, newParentId: string | null): boolean {
  if (newParentId === null) return false;
  return newParentId === dragId || getDescendantIds(domains, dragId).has(newParentId);
}

/**
 * 计算拖放后需要写回的 parentId / order。
 * 返回 null 表示非法（目标不存在或会形成环）；返回空数组表示无需改动。
 * 目标父领域下的同级会重新编号为 0..n-1，只返回有变化的项。
 */
export function computeDomainMove(domains: Domain[], dragId: string, drop: DomainDrop): DomainPlacement[] | null {
  const byId = indexById(domains);
  const drag = byId.get(dragId);
  if (!drag) return null;

  let newParentId: string | null;
  let target: Domain | undefined;
  if (drop.position === "inside") {
    newParentId = drop.targetId;
    if (newParentId !== null && !byId.has(newParentId)) return null;
  } else {
    if (drop.targetId === null) return null;
    target = byId.get(drop.targetId);
    if (!target) return null;
    if (target.id === dragId) return [];
    newParentId = effectiveParentId(byId, target);
  }
  if (wouldCreateCycle(domains, dragId, newParentId)) return null;

  const siblings = childrenOf(domains, newParentId).filter((d) => d.id !== dragId);
  let index = siblings.length;
  if (target) {
    const i = siblings.findIndex((d) => d.id === target.id);
    index = drop.position === "before" ? i : i + 1;
  }
  siblings.splice(index, 0, drag);

  return siblings
    .map((d, i) => ({ id: d.id, parentId: newParentId, order: i }))
    .filter((p) => {
      const cur = byId.get(p.id)!;
      return cur.parentId !== p.parentId || cur.order !== p.order;
    });
}

/** 新建领域放在同级末尾 */
export function nextOrder(domains: Domain[], parentId: string | null): number {
  const sibs = childrenOf(domains, parentId);
  return sibs.length ? Math.max(...sibs.map((d) => d.order)) + 1 : 0;
}

/** 领域路径数组，从顶层到自身 */
export function domainPathNames(domains: Domain[] | Map<string, Domain>, id: string): string[] {
  const byId = domains instanceof Map ? domains : indexById(domains);
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined;
  }
  return names;
}

/** "ATM / 轨迹预测" */
export function domainPath(domains: Domain[] | Map<string, Domain>, id: string, sep = " / "): string {
  return domainPathNames(domains, id).join(sep);
}

/** 每个领域（含子领域）下的论文数；同一篇论文在一个子树里只计一次 */
export function countPapersByDomain(domains: Domain[], papers: Pick<Paper, "domainIds">[]): Map<string, number> {
  const byId = indexById(domains);
  const counts = new Map<string, number>();
  for (const p of papers) {
    const hit = new Set<string>();
    for (const did of p.domainIds) {
      let cur = byId.get(did);
      while (cur && !hit.has(cur.id)) {
        hit.add(cur.id);
        const parent = effectiveParentId(byId, cur);
        cur = parent !== null ? byId.get(parent) : undefined;
      }
    }
    for (const id of hit) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** 论文是否不属于任何现存领域 */
export function isUnfiled(paper: Pick<Paper, "domainIds">, existingIds: Set<string>): boolean {
  return !paper.domainIds.some((id) => existingIds.has(id));
}
