// 数据库记录 → React Flow 节点/边（纯函数）。
// 未变化的节点/边复用上一次的对象，React Flow 只重新渲染真正变化的那几个（500+ 节点时很关键）。
import { MarkerType, Position, type Edge, type Node, type NodeHandle } from "@xyflow/react";
import { refKey } from "@/services/linkService";
import type { Annotation, BoardNode, EntityKind, EntityRef, Link, Note, Paper, Term } from "@/types/models";
import { RELATION_STYLE, type EdgeSpec } from "./model";

export type EntityView =
  | { kind: "annotation"; annotation: Annotation; paperTitle?: string }
  | { kind: "term"; term: Term }
  | { kind: "paper"; paper: Paper }
  | { kind: "note"; note: Note };

export type CanvasNodeType = EntityKind | "missing";

export interface CanvasNodeData extends Record<string, unknown> {
  ref: EntityRef;
  /** null：实体已被删除 */
  view: EntityView | null;
  /** 另一端不在这块画布上的连线数 */
  external: number;
  /** 内容签名，相同则复用 data 对象 */
  sig: string;
}

export type CanvasFlowNode = Node<CanvasNodeData, CanvasNodeType>;

export interface RelationEdgeData extends Record<string, unknown> {
  link: Link;
  offset: number;
}

export type CanvasFlowEdge = Edge<RelationEdgeData, "relation">;

export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 四边各一个连线手柄（id 与节点组件里的 <Handle> 一致）。预先声明，未渲染（视口外）的节点也能算出边 */
export function nodeHandles(w: number, h: number): NodeHandle[] {
  return [
    { id: "t", type: "source", position: Position.Top, x: w / 2, y: 0, width: 1, height: 1 },
    { id: "r", type: "source", position: Position.Right, x: w, y: h / 2, width: 1, height: 1 },
    { id: "b", type: "source", position: Position.Bottom, x: w / 2, y: h, width: 1, height: 1 },
    { id: "l", type: "source", position: Position.Left, x: 0, y: h / 2, width: 1, height: 1 },
  ];
}

export function viewSignature(view: EntityView | null): string {
  return view ? JSON.stringify(view) : "";
}

/**
 * 用数据库里的节点更新 React Flow 节点列表。
 * - 正在拖动/缩放的节点保留本地位置和大小；
 * - pending 里是已提交但数据库尚未回显的几何（拖动结束到写入完成之间），优先使用；
 * - 选中状态沿用上一次。
 */
export function reconcileNodes(
  prev: readonly CanvasFlowNode[],
  boardNodes: readonly BoardNode[],
  views: ReadonlyMap<string, EntityView>,
  pending: ReadonlyMap<string, Partial<Geometry>> = new Map(),
  external: ReadonlyMap<string, number> = new Map(),
): CanvasFlowNode[] {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  return boardNodes.map((bn) => {
    const old = prevById.get(bn.id);
    const view = views.get(refKey(bn.ref)) ?? null;
    const type: CanvasNodeType = view ? bn.ref.kind : "missing";
    const p = pending.get(bn.id);
    let x = p?.x ?? bn.x;
    let y = p?.y ?? bn.y;
    let w = p?.w ?? bn.w;
    let h = p?.h ?? bn.h;
    if (old?.dragging) ({ x, y } = old.position);
    if (old?.resizing) {
      ({ x, y } = old.position);
      w = old.width ?? w;
      h = old.height ?? h;
    }
    const ext = external.get(bn.id) ?? 0;
    const sig = `${ext}|${viewSignature(view)}`;
    const data: CanvasNodeData = old && old.data.sig === sig && old.type === type ? old.data : { ref: bn.ref, view, external: ext, sig };
    if (
      old &&
      old.data === data &&
      old.type === type &&
      old.position.x === x &&
      old.position.y === y &&
      old.width === w &&
      old.height === h
    ) {
      return old;
    }
    const sameSize = old && old.width === w && old.height === h;
    return {
      id: bn.id,
      type,
      position: { x, y },
      width: w,
      height: h,
      measured: sameSize && old.measured ? old.measured : { width: w, height: h },
      handles: sameSize && old.handles ? old.handles : nodeHandles(w, h),
      selected: old?.selected ?? false,
      data,
    } satisfies CanvasFlowNode;
  });
}

/** 边：复用未变化的对象，保留选中状态 */
export function reconcileEdges(prev: readonly CanvasFlowEdge[], specs: readonly EdgeSpec[]): CanvasFlowEdge[] {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  return specs.map((s) => {
    const old = prevById.get(s.id);
    const l = s.link;
    if (
      old &&
      old.source === s.source &&
      old.target === s.target &&
      old.data?.offset === s.offset &&
      old.data.link.relation === l.relation &&
      (old.data.link.label ?? "") === (l.label ?? "")
    ) {
      return old;
    }
    const style = RELATION_STYLE[l.relation] ?? RELATION_STYLE.custom;
    return {
      id: s.id,
      type: "relation",
      source: s.source,
      target: s.target,
      sourceHandle: null,
      targetHandle: null,
      selected: old?.selected ?? false,
      data: { link: l, offset: s.offset },
      ...(style.arrow ? { markerEnd: { type: MarkerType.ArrowClosed, color: style.color, width: 16, height: 16 } } : {}),
    } satisfies CanvasFlowEdge;
  });
}
