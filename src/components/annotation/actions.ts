// 界面层共用的批注操作（卡片、列表都会用到）
import { useAnnotationStore } from "@/app/stores/annotation";
import { useReaderStore, type PaneId } from "@/app/stores/reader";
import { t } from "@/i18n";
import { deleteAnnotation, restoreAnnotation, setAnnotationNote } from "@/services/annotationService";
import type { Annotation } from "@/types/models";

// ---- 正在编辑的笔记草稿：删除时先保存，撤销能找回 ----

const drafts = new Map<string, () => string>();

/** 笔记编辑器挂载时登记读取草稿的函数；返回注销函数 */
export function registerDraft(id: string, read: () => string): () => void {
  drafts.set(id, read);
  return () => {
    if (drafts.get(id) === read) drafts.delete(id);
  };
}

/** 草稿规整：只有空白视为空，去掉末尾空白 */
export const cleanNote = (s: string) => (s.trim() ? s.replace(/\s+$/, "") : "");

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

/** 数据库写入失败时的统一反馈：控制台记录 + 红色提示条 */
export function reportError(what: string): (e: unknown) => void {
  return (e) => {
    console.error(what, e);
    useAnnotationStore.getState().showToast(t.common.failedWith(what, errorText(e)), { kind: "error" });
  };
}

/** 删除批注，并显示"已删除 · 撤销"提示。正在编辑的草稿先写入，撤销时一并恢复 */
export async function deleteWithUndo(id: string): Promise<void> {
  try {
    const read = drafts.get(id);
    if (read) await setAnnotationNote(id, cleanNote(read()));
    const snap = await deleteAnnotation(id);
    if (!snap) return;
    const st = useAnnotationStore.getState();
    if (st.selected?.id === id) st.select(null);
    if (st.editingId === id) st.stopEditing();
    st.showToast(t.reader.toast.deleted, { undo: () => restoreAnnotation(snap) });
  } catch (e) {
    reportError(t.reader.toast.deleteFailed)(e);
  }
}

/** 跳到批注在原文中的位置并闪烁；未定位的批注只打开到原来的页 */
export function jumpToAnnotation(a: Pick<Annotation, "id" | "paperId" | "page" | "rects" | "anchorStatus">, paneId?: PaneId): void {
  const r = a.rects[0];
  useReaderStore.getState().jumpTo({
    paperId: a.paperId,
    page: a.page,
    ...(r ? { pdfPoint: [Math.min(r[0], r[2]), Math.max(r[1], r[3])] as [number, number] } : {}),
    ...(a.anchorStatus === "orphaned" ? {} : { annotationId: a.id }),
    ...(paneId ? { paneId } : {}),
  });
}
