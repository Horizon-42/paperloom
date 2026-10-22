// 画布的纯逻辑：收件箱筛选、拖入数据、连线 → 边、关系样式、浮动边几何。不碰数据库和 DOM。
import { t } from "@/i18n";
import { refKey } from "@/services/linkService";
import type { Annotation, BoardNode, Domain, EntityKind, EntityRef, Link, LinkRelation, Note, Paper } from "@/types/models";
import { getSubtreeIds } from "@/services/domainTree";

// ---------- 拖入画布 ----------

/** 从左侧面板拖到画布上的 dataTransfer 类型，内容为 JSON 编码的 EntityRef */
export const REF_MIME = "application/x-paperlens-ref";

const KINDS: readonly EntityKind[] = ["annotation", "term", "paper", "note"];

export function encodeRef(ref: EntityRef): string {
  return JSON.stringify({ kind: ref.kind, id: ref.id });
}

export function decodeRef(raw: string | null | undefined): EntityRef | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { kind?: unknown; id?: unknown };
    if (typeof v.id === "string" && v.id && KINDS.includes(v.kind as EntityKind)) return { kind: v.kind as EntityKind, id: v.id };
  } catch {
    // 非本应用的拖放数据
  }
  return null;
}

// ---------- 收件箱 ----------

export type InboxItem =
  | { ref: EntityRef & { kind: "annotation" }; annotation: Annotation; paperTitle: string; updatedAt: number }
  | { ref: EntityRef & { kind: "note" }; note: Note; updatedAt: number };

export interface InboxQuery {
  paperId?: string | null;
  /** 已展开子孙的领域集合；null 表示不限 */
  domainIds?: ReadonlySet<string> | null;
  color?: string | null;
}

/** 放在任意画布上的实体（refKey 集合） */
export function placedRefKeys(nodes: readonly Pick<BoardNode, "ref">[]): Set<string> {
  return new Set(nodes.map((n) => refKey(n.ref)));
}

/** 领域筛选展开为领域集合（含子孙）。"board" 用当前画布关联的领域，画布未关联领域时不限 */
export function resolveDomainFilter(domain: string | null, boardDomainIds: readonly string[], domains: Domain[]): Set<string> | null {
  const roots = domain === "board" ? boardDomainIds : domain ? [domain] : [];
  if (!roots.length) return null;
  const out = new Set<string>();
  for (const r of roots) for (const id of getSubtreeIds(domains, r)) out.add(id);
  return out;
}

export interface InboxResult {
  items: InboxItem[];
  /** 被论文/颜色筛选隐藏的自由笔记数 */
  hiddenNotes: number;
}

/**
 * "未整理"收件箱（开发文档 9.2 第 1 步）：placed 之外的批注和自由笔记。
 * placed 可以是"任意画布上的实体"（默认：不在任何画布上），也可以是"本画布上的实体"（不在本画布上）。
 * 论文/领域/颜色筛选只作用于批注；自由笔记没有论文和颜色，按论文或颜色筛选时隐藏并计数，领域筛选不影响它们。
 * 论文已不存在的批注丢弃。最近修改的在前。
 */
export function buildInbox(
  input: {
    annotations: readonly Annotation[];
    notes: readonly Note[];
    placed: ReadonlySet<string>;
    papers: ReadonlyMap<string, Pick<Paper, "title" | "domainIds">>;
  },
  q: InboxQuery = {},
): InboxResult {
  const color = q.color?.toLowerCase() ?? null;
  const hideNotes = !!(q.paperId || color);
  const items: InboxItem[] = [];
  let hiddenNotes = 0;
  for (const a of input.annotations) {
    if (input.placed.has(`annotation:${a.id}`)) continue;
    const paper = input.papers.get(a.paperId);
    if (!paper) continue;
    if (q.paperId && a.paperId !== q.paperId) continue;
    if (q.domainIds && !paper.domainIds.some((d) => q.domainIds!.has(d))) continue;
    if (color && a.color.toLowerCase() !== color) continue;
    items.push({ ref: { kind: "annotation", id: a.id }, annotation: a, paperTitle: paper.title, updatedAt: a.updatedAt });
  }
  for (const n of input.notes) {
    if (input.placed.has(`note:${n.id}`)) continue;
    if (hideNotes) hiddenNotes++;
    else items.push({ ref: { kind: "note", id: n.id }, note: n, updatedAt: n.updatedAt });
  }
  items.sort((x, y) => y.updatedAt - x.updatedAt || x.ref.id.localeCompare(y.ref.id));
  return { items, hiddenNotes };
}

/** 网格排布：从 origin 开始每行 cols 个，返回每个格子的左上角 */
export function gridLayout(origin: { x: number; y: number }, count: number, cell: { w: number; h: number }, cols = 4, gap = 24) {
  return Array.from({ length: count }, (_, i) => ({
    x: origin.x + (i % cols) * (cell.w + gap),
    y: origin.y + Math.floor(i / cols) * (cell.h + gap),
  }));
}

// ---------- 连线 → 边 ----------

export interface EdgeSpec {
  /** 等于 link.id（同一块画布上同一实体只有一个节点，所以每条连线至多一条边） */
  id: string;
  source: string; // boardNode id
  target: string;
  link: Link;
  /** 同一对节点之间有多条连线时，沿边方向左侧法线的偏移量（画布像素） */
  offset: number;
}

export const PARALLEL_GAP = 30;

/** 只保留两端都在画布上的连线；同一对节点之间的多条连线错开排列 */
export function linksToEdges(links: readonly Link[], nodes: readonly Pick<BoardNode, "id" | "ref">[]): EdgeSpec[] {
  const nodeOf = new Map<string, string>();
  for (const n of nodes) nodeOf.set(refKey(n.ref), n.id);
  const seen = new Set<string>();
  const groups = new Map<string, EdgeSpec[]>();
  const out: EdgeSpec[] = [];
  const sorted = [...links].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const link of sorted) {
    if (seen.has(link.id)) continue;
    seen.add(link.id);
    const source = nodeOf.get(refKey(link.from));
    const target = nodeOf.get(refKey(link.to));
    if (!source || !target || source === target) continue;
    const e: EdgeSpec = { id: link.id, source, target, link, offset: 0 };
    const pair = source < target ? `${source}|${target}` : `${target}|${source}`;
    const g = groups.get(pair);
    if (g) g.push(e);
    else groups.set(pair, [e]);
    out.push(e);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.forEach((e, i) => {
      const o = (i - (g.length - 1) / 2) * PARALLEL_GAP;
      // 偏移以"小 id → 大 id"方向为准，反向的边取反，保证同一对节点间的边不重叠
      e.offset = e.source < e.target ? o : -o;
    });
  }
  return out;
}

/**
 * 只有一端在画布上的连线（另一端不在这块画布上），按画布节点分组。
 * 节点角上显示"还有 k 条连线"，点开可以把另一端放进来。
 */
export function externalLinks(links: readonly Link[], nodes: readonly Pick<BoardNode, "id" | "ref">[]): Map<string, { link: Link; other: EntityRef }[]> {
  const nodeOf = new Map<string, string>();
  for (const n of nodes) nodeOf.set(refKey(n.ref), n.id);
  const out = new Map<string, { link: Link; other: EntityRef }[]>();
  const seen = new Set<string>();
  for (const link of [...links].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    if (seen.has(link.id)) continue;
    seen.add(link.id);
    const s = nodeOf.get(refKey(link.from));
    const t = nodeOf.get(refKey(link.to));
    if (!!s === !!t) continue;
    const nodeId = (s ?? t)!;
    const other = s ? link.to : link.from;
    const list = out.get(nodeId);
    if (list) list.push({ link, other });
    else out.set(nodeId, [{ link, other }]);
  }
  return out;
}

// ---------- 关系样式 ----------

export interface RelationStyle {
  color: string;
  /** SVG stroke-dasharray；缺省为实线 */
  dash?: string;
  /** 终点是否画箭头（"对比"是对称关系，不画） */
  arrow: boolean;
}

export const RELATION_STYLE: Record<LinkRelation, RelationStyle> = {
  supports: { color: "#16a34a", arrow: true },
  contradicts: { color: "#dc2626", dash: "7 5", arrow: true },
  extends: { color: "#2563eb", arrow: true },
  compares: { color: "#d97706", dash: "2 5", arrow: false },
  partOf: { color: "#7c3aed", dash: "12 4", arrow: true },
  custom: { color: "#525252", dash: "5 4", arrow: true },
};

/** 边上显示的文字：关系名；自定义关系显示自定义文字；非自定义关系带备注时附在后面 */
export function relationText(link: Pick<Link, "relation" | "label">): string {
  const label = link.label?.trim();
  const names = t.canvas.relations;
  if (link.relation === "custom") return label || names.custom;
  const name = names[link.relation] ?? names.custom;
  return label ? `${name} · ${label}` : name;
}

// ---------- 浮动边几何 ----------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 从矩形中心朝 (tx, ty) 方向的射线与矩形边界的交点 */
export function borderPoint(b: Box, tx: number, ty: number): [number, number] {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx !== 0 ? b.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? b.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return [cx + dx * s, cy + dy * s];
}

export interface EdgeGeometry {
  path: string;
  labelX: number;
  labelY: number;
}

/**
 * 两个节点之间的边：端点在两个矩形边界上（朝向对方的控制点），offset ≠ 0 时用二次曲线向左侧法线方向弯出。
 * 标签放在曲线中点。
 */
export function edgeGeometry(src: Box, tgt: Box, offset = 0): EdgeGeometry {
  const sc: [number, number] = [src.x + src.w / 2, src.y + src.h / 2];
  const tc: [number, number] = [tgt.x + tgt.w / 2, tgt.y + tgt.h / 2];
  const dx = tc[0] - sc[0];
  const dy = tc[1] - sc[1];
  const len = Math.hypot(dx, dy) || 1;
  // 左侧法线（屏幕坐标 y 向下）
  const nx = dy / len;
  const ny = -dx / len;
  const mx = (sc[0] + tc[0]) / 2;
  const my = (sc[1] + tc[1]) / 2;
  if (!offset) {
    const [sx, sy] = borderPoint(src, tc[0], tc[1]);
    const [tx, ty] = borderPoint(tgt, sc[0], sc[1]);
    return { path: `M ${sx},${sy} L ${tx},${ty}`, labelX: (sx + tx) / 2, labelY: (sy + ty) / 2 };
  }
  // 二次贝塞尔：控制点在中点外 2×offset，曲线中点恰好偏出 offset
  const cx = mx + nx * offset * 2;
  const cy = my + ny * offset * 2;
  const [sx, sy] = borderPoint(src, cx, cy);
  const [tx, ty] = borderPoint(tgt, cx, cy);
  const labelX = 0.25 * sx + 0.5 * cx + 0.25 * tx;
  const labelY = 0.25 * sy + 0.5 * cy + 0.25 * ty;
  return { path: `M ${sx},${sy} Q ${cx},${cy} ${tx},${ty}`, labelX, labelY };
}

// ---------- 文本 ----------

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Markdown → 纯文本摘要（缩小显示、导出摘要用；不求完全准确） */
export function plainExcerpt(md: string, n: number): string {
  const t = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]/g, "");
  return clip(t, n);
}
