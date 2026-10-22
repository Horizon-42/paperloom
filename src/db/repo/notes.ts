// notes 表的读写（画布上的自由笔记）
import { db } from "@/db/schema";
import type { Note } from "@/types/models";

export function getNote(id: string): Promise<Note | undefined> {
  return db.notes.get(id);
}

export function listNotes(): Promise<Note[]> {
  return db.notes.toArray();
}

export async function addNote(n: Note): Promise<void> {
  await db.notes.add(n);
}

export async function updateNote(id: string, changes: Partial<Omit<Note, "id" | "createdAt">>): Promise<number> {
  return db.notes.update(id, changes);
}
