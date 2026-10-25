// 笔记（画布上的自由笔记、领域笔记）的增删改。
// 删除时在同一事务中级联删除指向它的连线和各块画布上的节点，并返回快照供"撤销"恢复。
import { db } from "@/db/schema";
import { addNote, getNote, updateNote } from "@/db/repo/notes";
import { newId } from "@/lib/id";
import type { BoardNode, EntityRef, Link, Note } from "@/types/models";

export async function createNote(text = "", now = Date.now(), domainId?: string): Promise<Note> {
  const note: Note = { id: newId(), text, createdAt: now, updatedAt: now, ...(domainId ? { domainId } : {}) };
  await addNote(note);
  return note;
}

export async function setNoteText(id: string, text: string): Promise<void> {
  const cur = await getNote(id);
  if (!cur || cur.text === text) return;
  await updateNote(id, { text, updatedAt: Date.now() });
}

const isRefTo = (r: EntityRef, kind: EntityRef["kind"], id: string) => r.kind === kind && r.id === id;

/** 删除某个实体时要一起删掉的连线和画布节点（纯函数；links / nodes 可以是任意超集） */
export function entityCascade(ref: EntityRef, links: readonly Link[], nodes: readonly BoardNode[]): { linkIds: string[]; nodeIds: string[] } {
  const linkIds = new Set<string>();
  for (const l of links) if (isRefTo(l.from, ref.kind, ref.id) || isRefTo(l.to, ref.kind, ref.id)) linkIds.add(l.id);
  const nodeIds = nodes.filter((n) => isRefTo(n.ref, ref.kind, ref.id)).map((n) => n.id);
  return { linkIds: [...linkIds], nodeIds };
}

export interface DeletedNote {
  note: Note;
  links: Link[];
  boardNodes: BoardNode[];
}

/** 删除笔记，并删除与它相连的连线、它在所有画布上的节点 */
export async function deleteNote(id: string): Promise<DeletedNote | null> {
  return db.transaction("rw", [db.notes, db.links, db.boardNodes], async () => {
    const note = await db.notes.get(id);
    if (!note) return null;
    const links = [...(await db.links.where("from.id").equals(id).toArray()), ...(await db.links.where("to.id").equals(id).toArray())];
    const nodes = await db.boardNodes.where("ref.id").equals(id).toArray();
    const { linkIds, nodeIds } = entityCascade({ kind: "note", id }, links, nodes);
    await db.links.bulkDelete(linkIds);
    await db.boardNodes.bulkDelete(nodeIds);
    await db.notes.delete(id);
    const linkSet = new Set(linkIds);
    const nodeSet = new Set(nodeIds);
    const uniq = new Map(links.filter((l) => linkSet.has(l.id)).map((l) => [l.id, l]));
    return { note, links: [...uniq.values()], boardNodes: nodes.filter((n) => nodeSet.has(n.id)) };
  });
}

/** 撤销删除：另一端已不存在的连线、所在画布已不存在的节点不恢复 */
export async function restoreNote(snap: DeletedNote): Promise<void> {
  const tables = [db.notes, db.links, db.boardNodes, db.boards, db.annotations, db.terms, db.papers];
  await db.transaction("rw", tables, async () => {
    await db.notes.put(snap.note);
    const self = snap.note.id;
    const exists = async (r: EntityRef): Promise<boolean> => {
      if (r.kind === "note") return r.id === self || !!(await db.notes.get(r.id));
      if (r.kind === "annotation") return !!(await db.annotations.get(r.id));
      if (r.kind === "term") return !!(await db.terms.get(r.id));
      return !!(await db.papers.get(r.id));
    };
    const links: Link[] = [];
    for (const l of snap.links) if ((await exists(l.from)) && (await exists(l.to))) links.push(l);
    if (links.length) await db.links.bulkPut(links);
    const nodes: BoardNode[] = [];
    for (const n of snap.boardNodes) if (await db.boards.get(n.boardId)) nodes.push(n);
    if (nodes.length) await db.boardNodes.bulkPut(nodes);
  });
}
