// annotations 表的读写
import { db } from "@/db/schema";
import type { Annotation } from "@/types/models";

export type AnnotationChanges = Partial<Omit<Annotation, "id" | "paperId" | "createdAt">>;

export function getAnnotation(id: string): Promise<Annotation | undefined> {
  return db.annotations.get(id);
}

export function listAnnotationsByPaper(paperId: string): Promise<Annotation[]> {
  return db.annotations.where("paperId").equals(paperId).toArray();
}

export function listAnnotationsByPage(paperId: string, page: number): Promise<Annotation[]> {
  return db.annotations.where("[paperId+page]").equals([paperId, page]).toArray();
}

/** 属于任一给定论文的批注 */
export function listAnnotationsByPapers(paperIds: string[]): Promise<Annotation[]> {
  if (!paperIds.length) return Promise.resolve([]);
  return db.annotations.where("paperId").anyOf(paperIds).toArray();
}

export function listAllAnnotations(): Promise<Annotation[]> {
  return db.annotations.toArray();
}

export async function addAnnotation(a: Annotation): Promise<void> {
  await db.annotations.add(a);
}

/** 值为 undefined 的字段会从记录中删除 */
export async function updateAnnotation(id: string, changes: AnnotationChanges): Promise<number> {
  return db.annotations.update(id, changes);
}
