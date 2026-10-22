// 画布数据的实时查询：节点 + 节点引用的实体 + 至少一端在画布上的连线。
// 画布记录（名称、视口）单独查询，保存视口时不会重新读取几百个实体。
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/schema";
import { refKey } from "@/services/linkService";
import type { BoardNode, EntityKind, Link } from "@/types/models";
import type { EntityView } from "./flow";

export interface BoardContent {
  boardId: string;
  nodes: BoardNode[];
  /** refKey → 实体；缺失表示已被删除 */
  views: Map<string, EntityView>;
  /** 至少一端在画布上的连线 */
  links: Link[];
}

export async function loadBoardContent(boardId: string): Promise<BoardContent> {
  const nodes = await db.boardNodes.where("boardId").equals(boardId).toArray();
  const ids = (kind: EntityKind) => [...new Set(nodes.filter((n) => n.ref.kind === kind).map((n) => n.ref.id))];
  const refIds = [...new Set(nodes.map((n) => n.ref.id))];
  const [anns, terms, papers, notes, outgoing, incoming] = await Promise.all([
    db.annotations.bulkGet(ids("annotation")),
    db.terms.bulkGet(ids("term")),
    db.papers.bulkGet(ids("paper")),
    db.notes.bulkGet(ids("note")),
    refIds.length ? db.links.where("from.id").anyOf(refIds).toArray() : Promise.resolve([] as Link[]),
    refIds.length ? db.links.where("to.id").anyOf(refIds).toArray() : Promise.resolve([] as Link[]),
  ]);
  // 两个方向都取：另一端不在画布上的连线也要统计（节点角上的"还有 k 条连线"）
  const links = [...new Map([...outgoing, ...incoming].map((l) => [l.id, l])).values()];
  const annPaperIds = [...new Set(anns.flatMap((a) => (a ? [a.paperId] : [])))];
  const annPapers = await db.papers.bulkGet(annPaperIds);
  const titles = new Map(annPapers.flatMap((p) => (p ? [[p.id, p.title] as const] : [])));
  const views = new Map<string, EntityView>();
  for (const a of anns) if (a) views.set(refKey({ kind: "annotation", id: a.id }), { kind: "annotation", annotation: a, paperTitle: titles.get(a.paperId) });
  for (const t of terms) if (t) views.set(refKey({ kind: "term", id: t.id }), { kind: "term", term: t });
  for (const p of papers) if (p) views.set(refKey({ kind: "paper", id: p.id }), { kind: "paper", paper: p });
  for (const n of notes) if (n) views.set(refKey({ kind: "note", id: n.id }), { kind: "note", note: n });
  return { boardId, nodes, views, links };
}

export function useBoardContent(boardId: string): BoardContent | undefined {
  const content = useLiveQuery(() => loadBoardContent(boardId), [boardId]);
  // 切换画布后、新查询返回前，不把上一块画布的数据当成这一块的
  return content?.boardId === boardId ? content : undefined;
}

export function useBoard(boardId: string | null) {
  return useLiveQuery(async () => (boardId ? ((await db.boards.get(boardId)) ?? null) : null), [boardId]);
}
