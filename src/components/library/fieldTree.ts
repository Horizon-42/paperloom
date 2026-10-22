// 领域树（文件夹视图）的行：领域是文件夹，论文是其中的文件。纯函数，供虚拟列表使用。
// 一篇论文属于几个领域，就在每个领域下各出现一次；不属于任何（现存）领域的放在末尾的「未分类」里。
import type { DomainNode } from "@/services/domainTree";
import type { Domain, Paper } from "@/types/models";

export type FieldTreeRow =
  | {
      kind: "folder";
      key: string;
      node: DomainNode;
      depth: number;
      /** 该领域及其子领域下的论文数（不重复计数，已按标签筛选） */
      count: number;
      /** 有可以展开的内容：子领域或论文 */
      expandable: boolean;
      expanded: boolean;
    }
  | {
      kind: "paper";
      key: string;
      paper: Paper;
      depth: number;
      /** 所在的领域；「未分类」里为 null */
      parentId: string | null;
      /** 也在其他领域里 */
      multi: boolean;
    }
  | { kind: "unfiled"; key: string; count: number; expanded: boolean };

export interface FieldTreeInput {
  tree: DomainNode[];
  /** 已按标签筛选、排好序的论文 */
  papers: readonly Paper[];
  domainById: ReadonlyMap<string, Domain>;
  isExpanded: (domainId: string) => boolean;
  unfiledOpen: boolean;
  /** 正在按标签筛选：没有匹配论文的领域不显示 */
  filtering: boolean;
  /** 「未分类」为空时也显示（例如正在拖论文，需要它作为放置目标） */
  showEmptyUnfiled: boolean;
  /** 筛选时也要显示的领域（及其上级），例如刚新建、正在重命名的领域 */
  keepVisible?: string | null;
}

export const UNFILED_ROW_KEY = "unfiled";
export const folderRowKey = (domainId: string) => `d:${domainId}`;
export const paperRowKey = (parentId: string | null, paperId: string) => `p:${parentId ?? "-"}:${paperId}`;

export function buildFieldTreeRows(input: FieldTreeInput): FieldTreeRow[] {
  const { tree, papers, domainById, isExpanded, unfiledOpen, filtering, showEmptyUnfiled } = input;
  const direct = new Map<string, Paper[]>();
  const unfiled: Paper[] = [];
  for (const p of papers) {
    let filed = false;
    for (const id of p.domainIds) {
      if (!domainById.has(id)) continue;
      filed = true;
      const list = direct.get(id);
      if (list) {
        if (list[list.length - 1] !== p) list.push(p); // domainIds 里重复的 id 只算一次
      } else direct.set(id, [p]);
    }
    if (!filed) unfiled.push(p);
  }
  const multi = (p: Paper) => new Set(p.domainIds.filter((id) => domainById.has(id))).size > 1;

  // 每个领域子树下的论文（去重）
  const subtree = new Map<string, Set<string>>();
  const collect = (node: DomainNode): Set<string> => {
    const ids = new Set<string>((direct.get(node.domain.id) ?? []).map((p) => p.id));
    for (const c of node.children) for (const id of collect(c)) ids.add(id);
    subtree.set(node.domain.id, ids);
    return ids;
  };
  tree.forEach(collect);
  // 筛选时只显示有匹配论文的领域，另加 keepVisible 及其上级
  const keep = new Set<string>();
  for (let id = input.keepVisible ?? null; id && !keep.has(id); id = domainById.get(id)?.parentId ?? null) keep.add(id);
  const shown = (id: string) => !filtering || keep.has(id) || (subtree.get(id)?.size ?? 0) > 0;

  const rows: FieldTreeRow[] = [];
  const walk = (nodes: DomainNode[], depth: number) => {
    for (const node of nodes) {
      const id = node.domain.id;
      const count = subtree.get(id)?.size ?? 0;
      if (!shown(id)) continue;
      const children = node.children.filter((c) => shown(c.domain.id));
      const own = direct.get(id) ?? [];
      const expandable = children.length > 0 || own.length > 0;
      // keepVisible 的上级总是展开，它才能出现（如筛选时在收起的领域下新建子领域）
      const expanded = expandable && (isExpanded(id) || (keep.has(id) && id !== input.keepVisible));
      rows.push({ kind: "folder", key: folderRowKey(id), node, depth, count, expandable, expanded });
      if (!expanded) continue;
      // 子领域在前，直接属于该领域的论文在后（与文件管理器一致）
      walk(children, depth + 1);
      for (const p of own) rows.push({ kind: "paper", key: paperRowKey(id, p.id), paper: p, depth: depth + 1, parentId: id, multi: multi(p) });
    }
  };
  walk(tree, 0);

  if (unfiled.length || showEmptyUnfiled) {
    rows.push({ kind: "unfiled", key: UNFILED_ROW_KEY, count: unfiled.length, expanded: unfiledOpen && unfiled.length > 0 });
    if (unfiledOpen) for (const p of unfiled) rows.push({ kind: "paper", key: paperRowKey(null, p.id), paper: p, depth: 1, parentId: null, multi: false });
  }
  return rows;
}

/**
 * 定位一篇论文时要展开的位置：它所在的第一个领域（按树的顺序）及其所有上级；不属于任何领域时为 null（在「未分类」里）
 */
export function revealPath(tree: DomainNode[], paper: Pick<Paper, "domainIds">): { folderId: string; ancestors: string[] } | null {
  const own = new Set(paper.domainIds);
  const stack: string[] = [];
  const find = (nodes: DomainNode[]): { folderId: string; ancestors: string[] } | null => {
    for (const n of nodes) {
      if (own.has(n.domain.id)) return { folderId: n.domain.id, ancestors: [...stack] };
      stack.push(n.domain.id);
      const r = find(n.children);
      stack.pop();
      if (r) return r;
    }
    return null;
  };
  return find(tree);
}
