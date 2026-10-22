// 批注的增删改。删除时级联清理指向它的连线、画布节点和术语出处，并返回快照供"撤销"恢复。
import { db } from "@/db/schema";
import { addAnnotation, getAnnotation, updateAnnotation } from "@/db/repo/annotations";
import { newId } from "@/lib/id";
import type { Annotation, BoardNode, EntityRef, Link, PdfRect, SelectionAnchor } from "@/types/models";

export async function createAnnotation(
  anchor: SelectionAnchor,
  opts: { color: string; note?: string; now?: number },
): Promise<Annotation> {
  const now = opts.now ?? Date.now();
  const ann: Annotation = {
    id: newId(),
    paperId: anchor.paperId,
    page: anchor.page,
    rects: anchor.rects.map((r) => [...r] as PdfRect),
    quote: { ...anchor.quote },
    fileHash: anchor.fileHash,
    anchorStatus: "ok",
    color: opts.color,
    note: opts.note ?? "",
    createdAt: now,
    updatedAt: now,
  };
  await addAnnotation(ann);
  return ann;
}

export async function setAnnotationNote(id: string, note: string): Promise<void> {
  const cur = await getAnnotation(id);
  if (!cur || cur.note === note) return;
  await updateAnnotation(id, { note, updatedAt: Date.now() });
}

export async function setAnnotationColor(id: string, color: string): Promise<void> {
  await updateAnnotation(id, { color, updatedAt: Date.now() });
}

/**
 * 重新锚定后由高亮层补算矩形（需要该页的字形映射）。
 * 只在批注仍属于同一文件且尚无矩形时写入，避免覆盖并发的修改。
 */
export async function fillAnnotationRects(id: string, fileHash: string, rects: PdfRect[]): Promise<void> {
  await db.transaction("rw", db.annotations, async () => {
    const a = await db.annotations.get(id);
    if (!a || a.fileHash !== fileHash || a.rects.length > 0) return;
    await db.annotations.update(id, { rects });
  });
}

/** 换文件后在该页仍找不到原文：标为未定位 */
export async function markAnnotationOrphaned(id: string, fileHash: string): Promise<void> {
  await db.transaction("rw", db.annotations, async () => {
    const a = await db.annotations.get(id);
    if (!a || a.fileHash !== fileHash || a.rects.length > 0) return;
    await db.annotations.update(id, { anchorStatus: "orphaned" });
  });
}

/** 删除前的快照，用于撤销 */
export interface DeletedAnnotation {
  annotation: Annotation;
  links: Link[];
  boardNodes: BoardNode[];
  /** sourceAnnotationId 曾指向它的术语 */
  termIds: string[];
}

/** 删除批注，并在同一事务中删除引用它的连线、画布节点，清空指向它的 Term.sourceAnnotationId */
export async function deleteAnnotation(id: string): Promise<DeletedAnnotation | null> {
  return db.transaction("rw", [db.annotations, db.links, db.boardNodes, db.terms], async () => {
    const annotation = await db.annotations.get(id);
    if (!annotation) return null;
    const isRef = (r: { kind: string; id: string }) => r.kind === "annotation" && r.id === id;

    const byId = new Map<string, Link>();
    for (const index of ["from.id", "to.id"] as const) {
      for (const l of await db.links.where(index).equals(id).toArray()) {
        if (isRef(l.from) || isRef(l.to)) byId.set(l.id, l);
      }
    }
    const links = [...byId.values()];
    const boardNodes = (await db.boardNodes.where("ref.id").equals(id).toArray()).filter((n) => isRef(n.ref));
    // terms 没有 sourceAnnotationId 索引；术语表规模（千级）全表过滤即可
    const terms = await db.terms.filter((t) => t.sourceAnnotationId === id).toArray();

    await db.links.bulkDelete(links.map((l) => l.id));
    await db.boardNodes.bulkDelete(boardNodes.map((n) => n.id));
    for (const t of terms) {
      await db.terms.where("id").equals(t.id).modify((x) => {
        delete x.sourceAnnotationId;
      });
    }
    await db.annotations.delete(id);
    return { annotation, links, boardNodes, termIds: terms.map((t) => t.id) };
  });
}

/**
 * 撤销删除：恢复批注、连线、画布节点和术语出处。
 * 删除后这段时间里被删掉的东西不复活：术语已不存在时去掉 termId；另一端已不存在的连线、所在画布已不存在的节点不恢复。
 */
export async function restoreAnnotation(snap: DeletedAnnotation): Promise<void> {
  const tables = [db.annotations, db.links, db.boardNodes, db.terms, db.papers, db.notes, db.boards];
  await db.transaction("rw", tables, async () => {
    // 论文在此期间被删除时不恢复
    if (!(await db.papers.get(snap.annotation.paperId))) return;
    const ann: Annotation = { ...snap.annotation };
    if (ann.termId && !(await db.terms.get(ann.termId))) delete ann.termId;
    await db.annotations.put(ann);

    const self = ann.id;
    const exists = async (ref: EntityRef): Promise<boolean> => {
      if (ref.kind === "annotation") return ref.id === self || !!(await db.annotations.get(ref.id));
      if (ref.kind === "term") return !!(await db.terms.get(ref.id));
      if (ref.kind === "paper") return !!(await db.papers.get(ref.id));
      return !!(await db.notes.get(ref.id));
    };
    const links: Link[] = [];
    for (const l of snap.links) if ((await exists(l.from)) && (await exists(l.to))) links.push(l);
    if (links.length) await db.links.bulkPut(links);
    const nodes: BoardNode[] = [];
    for (const n of snap.boardNodes) if (await db.boards.get(n.boardId)) nodes.push(n);
    if (nodes.length) await db.boardNodes.bulkPut(nodes);

    for (const termId of snap.termIds) {
      await db.terms
        .where("id")
        .equals(termId)
        .modify((t) => {
          if (!t.sourceAnnotationId) t.sourceAnnotationId = self;
        });
    }
  });
}
