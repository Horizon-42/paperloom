// notes 表的读写（画布上的自由笔记）
import { db } from "@/db/schema";
import type { Note } from "@/types/models";

export function getNote(id: string): Promise<Note | undefined> {
  return db.notes.get(id);
}

export function listNotes(): Promise<Note[]> {
  return db.notes.toArray();
}

/** 领域笔记（属于某个领域的笔记），按创建时间排序 */
export async function listFieldNotes(): Promise<Note[]> {
  return (await db.notes.filter((n) => !!n.domainId).toArray()).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export async function addNote(n: Note): Promise<void> {
  await db.notes.add(n);
}

export async function updateNote(id: string, changes: Partial<Omit<Note, "id" | "createdAt">>): Promise<number> {
  return db.notes.update(id, changes);
}
