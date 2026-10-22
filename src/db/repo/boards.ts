// boards / boardNodes 表的读写（画布与画布上的节点位置）
import { db } from "@/db/schema";
import type { Board, BoardNode, EntityRef } from "@/types/models";

export type BoardChanges = Partial<Omit<Board, "id" | "createdAt">>;
export type BoardNodeGeometry = Pick<BoardNode, "x" | "y" | "w" | "h">;

export function listBoards(): Promise<Board[]> {
  return db.boards.toArray();
}

export function getBoard(id: string): Promise<Board | undefined> {
  return db.boards.get(id);
}

export async function addBoard(b: Board): Promise<void> {
  await db.boards.add(b);
}

/** 值为 undefined 的字段会从记录中删除 */
export async function updateBoard(id: string, changes: BoardChanges): Promise<number> {
  return db.boards.update(id, changes);
}

export function listBoardNodes(boardId: string): Promise<BoardNode[]> {
  return db.boardNodes.where("boardId").equals(boardId).toArray();
}

export function listAllBoardNodes(): Promise<BoardNode[]> {
  return db.boardNodes.toArray();
}

export function getBoardNode(id: string): Promise<BoardNode | undefined> {
  return db.boardNodes.get(id);
}

/** 引用某个实体的全部画布节点（各块画布） */
export async function listNodesForRef(ref: EntityRef): Promise<BoardNode[]> {
  const rows = await db.boardNodes.where("ref.id").equals(ref.id).toArray();
  return rows.filter((n) => n.ref.kind === ref.kind);
}

export async function addBoardNode(n: BoardNode): Promise<void> {
  await db.boardNodes.add(n);
}

export async function putBoardNodes(nodes: BoardNode[]): Promise<void> {
  if (nodes.length) await db.boardNodes.bulkPut(nodes);
}

export async function updateBoardNode(id: string, changes: Partial<BoardNodeGeometry>): Promise<number> {
  return db.boardNodes.update(id, changes);
}

export async function deleteBoardNodes(ids: string[]): Promise<void> {
  if (ids.length) await db.boardNodes.bulkDelete(ids);
}
