// 笔记画布（开发文档第 9 节）：画布的增删改、节点的放入/移动/移除。
// 连线属于实体之间（links 表，见 linkService），位置属于画布（boardNodes）；这里不改实体本身。
// 视口（平移/缩放）是每个浏览器自己的查看状态，存在 localStorage（components/canvas/viewportMemory.ts），不写 boards 表。
import { db } from "@/db/schema";
import {
  addBoard,
  addBoardNode,
  deleteBoardNodes,
  getBoard,
  listBoardNodes,
  listBoards,
  listNodesForRef,
  putBoardNodes,
  updateBoard,
  updateBoardNode,
  type BoardNodeGeometry,
} from "@/db/repo/boards";
import { newId } from "@/lib/id";
import type { Annotation, Board, BoardNode, EntityKind, EntityRef, Link, Note, Paper, Term } from "@/types/models";

/** 新放入的节点默认大小（画布坐标） */
export const DEFAULT_NODE_SIZE: Record<EntityKind, { w: number; h: number }> = {
  annotation: { w: 260, h: 150 },
  term: { w: 220, h: 110 },
  paper: { w: 260, h: 96 },
  note: { w: 240, h: 130 },
};
export const MIN_NODE_SIZE = { w: 140, h: 56 };

export const DEFAULT_BOARD_NAME = "未命名画布";

export function cleanBoardName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 120);
}

const sameRef = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.id === b.id;

/** 纯函数：同一实体在同一块画布上最多出现一次，返回已有的节点 */
export function findNodeForRef(nodes: readonly BoardNode[], boardId: string, ref: EntityRef): BoardNode | undefined {
  return nodes.find((n) => n.boardId === boardId && sameRef(n.ref, ref));
}

/**
 * 纯函数：删除画布时可以一并删除的自由笔记——在这块画布上、不在其他画布上、也没有任何连线。
 * nodes 至少包含引用这些笔记的全部节点；links 至少包含与这些笔记相连的全部连线。
 */
export function orphanNotesOfBoard(boardId: string, nodes: readonly BoardNode[], links: readonly Link[]): string[] {
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  for (const n of nodes) {
    if (n.ref.kind !== "note") continue;
    (n.boardId === boardId ? here : elsewhere).add(n.ref.id);
  }
  const linked = new Set<string>();
  for (const l of links) for (const r of [l.from, l.to]) if (r.kind === "note") linked.add(r.id);
  return [...here].filter((id) => !elsewhere.has(id) && !linked.has(id));
}

// ---------- 画布 ----------

export async function createBoard(name: string, domainIds: string[] = [], now = Date.now()): Promise<Board> {
  const board: Board = {
    id: newId(),
    name: cleanBoardName(name) || DEFAULT_BOARD_NAME,
    domainIds: [...new Set(domainIds)],
    createdAt: now,
    updatedAt: now,
  };
  await addBoard(board);
  return board;
}

export async function renameBoard(id: string, name: string): Promise<void> {
  const clean = cleanBoardName(name);
  if (!clean) throw new Error("画布名称不能为空");
  await updateBoard(id, { name: clean, updatedAt: Date.now() });
}

export async function setBoardDomains(id: string, domainIds: string[]): Promise<void> {
  await updateBoard(id, { domainIds: [...new Set(domainIds)], updatedAt: Date.now() });
}

async function touchBoard(id: string): Promise<void> {
  await updateBoard(id, { updatedAt: Date.now() });
}

/** 按最近修改排序的画布列表 */
export async function listBoardsByRecent(): Promise<Board[]> {
  return (await listBoards()).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, "zh-CN"));
}

export interface BoardDeletionPlan {
  board: Board;
  nodeCount: number;
  /** 只在这块画布上、没有连线的自由笔记 */
  orphanNoteIds: string[];
}

export async function planBoardDeletion(boardId: string): Promise<BoardDeletionPlan | null> {
  return db.transaction("r", [db.boards, db.boardNodes, db.links], async () => {
    const board = await getBoard(boardId);
    if (!board) return null;
    const nodes = await listBoardNodes(boardId);
    const orphanNoteIds = await findOrphanNotes(boardId, nodes);
    return { board, nodeCount: nodes.length, orphanNoteIds };
  });
}

async function findOrphanNotes(boardId: string, nodes: BoardNode[]): Promise<string[]> {
  const noteIds = [...new Set(nodes.filter((n) => n.ref.kind === "note").map((n) => n.ref.id))];
  if (!noteIds.length) return [];
  const [others, out, inc] = await Promise.all([
    db.boardNodes.where("ref.id").anyOf(noteIds).toArray(),
    db.links.where("from.id").anyOf(noteIds).toArray(),
    db.links.where("to.id").anyOf(noteIds).toArray(),
  ]);
  return orphanNotesOfBoard(boardId, [...nodes, ...others], [...out, ...inc]);
}

/**
 * 删除画布：删除它的全部节点；批注、术语、论文、连线不受影响。
 * deleteOrphanNotes 为 true 时，只在这块画布上且没有连线的自由笔记一并删除；否则它们回到"未整理"。
 */
export async function deleteBoard(boardId: string, opts: { deleteOrphanNotes: boolean }): Promise<{ removedNodes: number; deletedNotes: number }> {
  return db.transaction("rw", [db.boards, db.boardNodes, db.notes, db.links], async () => {
    if (!(await getBoard(boardId))) return { removedNodes: 0, deletedNotes: 0 };
    const nodes = await listBoardNodes(boardId);
    const orphans = opts.deleteOrphanNotes ? await findOrphanNotes(boardId, nodes) : [];
    await deleteBoardNodes(nodes.map((n) => n.id));
    if (orphans.length) await db.notes.bulkDelete(orphans);
    await db.boards.delete(boardId);
    return { removedNodes: nodes.length, deletedNotes: orphans.length };
  });
}

// ---------- 节点 ----------

export interface PlaceResult {
  node: BoardNode;
  /** 该实体已在画布上，没有新建 */
  existed: boolean;
}

async function entityExists(ref: EntityRef): Promise<boolean> {
  if (ref.kind === "annotation") return !!(await db.annotations.get(ref.id));
  if (ref.kind === "term") return !!(await db.terms.get(ref.id));
  if (ref.kind === "paper") return !!(await db.papers.get(ref.id));
  return !!(await db.notes.get(ref.id));
}

/** 把实体放到画布上（pos 为节点左上角）。已在该画布上时返回已有节点，不重复放入 */
export async function addNodeToBoard(
  boardId: string,
  ref: EntityRef,
  pos: { x: number; y: number },
  size: { w: number; h: number } = DEFAULT_NODE_SIZE[ref.kind],
): Promise<PlaceResult> {
  const tables = [db.boards, db.boardNodes, db.annotations, db.terms, db.papers, db.notes];
  return db.transaction("rw", tables, async () => {
    if (!(await getBoard(boardId))) throw new Error("画布不存在");
    const existing = findNodeForRef(await listNodesForRef(ref), boardId, ref);
    if (existing) return { node: existing, existed: true };
    if (!(await entityExists(ref))) throw new Error("条目已被删除");
    const node: BoardNode = { id: newId(), boardId, ref: { kind: ref.kind, id: ref.id }, x: pos.x, y: pos.y, w: size.w, h: size.h };
    await addBoardNode(node);
    await touchBoard(boardId);
    return { node, existed: false };
  });
}

/** 批量放入（例如"放入这篇论文的全部批注"）。已在画布上或已被删除的跳过，返回新建的节点 */
export async function addNodesToBoard(boardId: string, items: { ref: EntityRef; x: number; y: number }[]): Promise<BoardNode[]> {
  const tables = [db.boards, db.boardNodes, db.annotations, db.terms, db.papers, db.notes];
  return db.transaction("rw", tables, async () => {
    if (!(await getBoard(boardId))) throw new Error("画布不存在");
    const here = await listBoardNodes(boardId);
    const added: BoardNode[] = [];
    for (const { ref, x, y } of items) {
      if (findNodeForRef(here, boardId, ref) || findNodeForRef(added, boardId, ref) || !(await entityExists(ref))) continue;
      const { w, h } = DEFAULT_NODE_SIZE[ref.kind];
      added.push({ id: newId(), boardId, ref: { kind: ref.kind, id: ref.id }, x, y, w, h });
    }
    await putBoardNodes(added);
    if (added.length) await touchBoard(boardId);
    return added;
  });
}

/** 删除某个实体会连带删掉的连线数，以及它在几块画布上（删除确认框用） */
export async function entityDeleteImpact(ref: EntityRef): Promise<{ links: number; boards: number }> {
  const [out, inc, nodes] = await Promise.all([
    db.links.where("from.id").equals(ref.id).toArray(),
    db.links.where("to.id").equals(ref.id).toArray(),
    listNodesForRef(ref),
  ]);
  const links = new Set([...out, ...inc].filter((l) => sameRef(l.from, ref) || sameRef(l.to, ref)).map((l) => l.id));
  return { links: links.size, boards: new Set(nodes.map((n) => n.boardId)).size };
}

/** 在画布上新建一条自由笔记 */
export async function createNoteOnBoard(boardId: string, pos: { x: number; y: number }, text = ""): Promise<{ note: Note; node: BoardNode }> {
  return db.transaction("rw", [db.boards, db.boardNodes, db.notes], async () => {
    if (!(await getBoard(boardId))) throw new Error("画布不存在");
    const now = Date.now();
    const note: Note = { id: newId(), text, createdAt: now, updatedAt: now };
    await db.notes.add(note);
    const { w, h } = DEFAULT_NODE_SIZE.note;
    const node: BoardNode = { id: newId(), boardId, ref: { kind: "note", id: note.id }, x: pos.x, y: pos.y, w, h };
    await addBoardNode(node);
    await touchBoard(boardId);
    return { note, node };
  });
}

/** 拖动结束时一次性写入位置 */
export async function moveBoardNodes(boardId: string, moves: { id: string; x: number; y: number }[]): Promise<void> {
  if (!moves.length) return;
  await db.transaction("rw", [db.boards, db.boardNodes], async () => {
    for (const m of moves) {
      if (Number.isFinite(m.x) && Number.isFinite(m.y)) await updateBoardNode(m.id, { x: m.x, y: m.y });
    }
    await touchBoard(boardId);
  });
}

export async function resizeBoardNode(boardId: string, id: string, g: BoardNodeGeometry): Promise<void> {
  if (![g.x, g.y, g.w, g.h].every(Number.isFinite)) return;
  await db.transaction("rw", [db.boards, db.boardNodes], async () => {
    await updateBoardNode(id, { x: g.x, y: g.y, w: Math.max(MIN_NODE_SIZE.w, g.w), h: Math.max(MIN_NODE_SIZE.h, g.h) });
    await touchBoard(boardId);
  });
}

/** 从画布上移除节点（只删 boardNode，实体和连线保留）。返回被移除的节点，供撤销 */
export async function removeNodesFromBoard(ids: string[]): Promise<BoardNode[]> {
  if (!ids.length) return [];
  return db.transaction("rw", [db.boards, db.boardNodes], async () => {
    const nodes = (await db.boardNodes.bulkGet(ids)).filter((n): n is BoardNode => !!n);
    await deleteBoardNodes(nodes.map((n) => n.id));
    for (const b of new Set(nodes.map((n) => n.boardId))) await touchBoard(b);
    return nodes;
  });
}

/** 撤销移除：画布已删除、或实体已在该画布上（撤销前又放了进去）的节点跳过 */
export async function restoreBoardNodes(nodes: BoardNode[]): Promise<void> {
  const tables = [db.boards, db.boardNodes, db.annotations, db.terms, db.papers, db.notes];
  await db.transaction("rw", tables, async () => {
    const keep: BoardNode[] = [];
    for (const n of nodes) {
      if (!(await getBoard(n.boardId)) || !(await entityExists(n.ref))) continue;
      if (findNodeForRef(await listNodesForRef(n.ref), n.boardId, n.ref)) continue;
      keep.push(n);
    }
    await putBoardNodes(keep);
  });
}

/** 放有该实体的画布，最近修改的在前 */
export async function boardsContaining(ref: EntityRef): Promise<Board[]> {
  const nodes = await listNodesForRef(ref);
  const boards = (await db.boards.bulkGet([...new Set(nodes.map((n) => n.boardId))])).filter((b): b is Board => !!b);
  return boards.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------- 导出用的数据快照 ----------

export interface CanvasExportData {
  boards: Board[];
  nodes: BoardNode[];
  annotations: Annotation[];
  terms: Term[];
  papers: Paper[];
  notes: Note[];
  links: Link[];
  /** 全库的论文与术语（只用来按存储模块的规则算 Markdown 文件名，给导出的节点加双链） */
  library?: { papers: Pick<Paper, "id" | "title" | "addedAt">[]; terms: Pick<Term, "id" | "name" | "createdAt">[] };
}

/** 读取若干块画布（缺省全部）及其上的实体与连线，供 JSON Canvas 导出 */
export async function loadCanvasExportData(boardIds?: string[]): Promise<CanvasExportData> {
  const tables = [db.boards, db.boardNodes, db.annotations, db.terms, db.papers, db.notes, db.links];
  return db.transaction("r", tables, async () => {
    const boards = boardIds ? (await db.boards.bulkGet(boardIds)).filter((b): b is Board => !!b) : await db.boards.toArray();
    const ids = boards.map((b) => b.id);
    const nodes = ids.length ? await db.boardNodes.where("boardId").anyOf(ids).toArray() : [];
    const of = (kind: EntityKind) => [...new Set(nodes.filter((n) => n.ref.kind === kind).map((n) => n.ref.id))];
    const defined = <T>(xs: (T | undefined)[]) => xs.filter((x): x is T => !!x);
    const annotations = defined(await db.annotations.bulkGet(of("annotation")));
    const paperIds = [...new Set([...of("paper"), ...annotations.map((a) => a.paperId)])];
    const refIds = [...new Set(nodes.map((n) => n.ref.id))];
    const links = refIds.length ? await db.links.where("from.id").anyOf(refIds).toArray() : [];
    const [allPapers, allTerms] = await Promise.all([db.papers.toArray(), db.terms.toArray()]);
    return {
      library: {
        papers: allPapers.map(({ id, title, addedAt }) => ({ id, title, addedAt })),
        terms: allTerms.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
      },
      boards,
      nodes,
      annotations,
      terms: defined(await db.terms.bulkGet(of("term"))),
      papers: defined(await db.papers.bulkGet(paperIds)),
      notes: defined(await db.notes.bulkGet(of("note"))),
      links,
    };
  });
}
