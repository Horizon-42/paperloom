// 领域笔记（D18）的操作：新建、删除（可撤销）、列表里的名字；右侧面板登记"写入未保存的输入"的回调
import { t } from "@/i18n";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useLibraryStore } from "@/app/stores/library";
import { reportError } from "@/components/annotation/actions";
import { createNote, deleteNote, restoreNote } from "@/services/noteService";

/** 面板里还没写入的输入：删除笔记前先写入，撤销时才能恢复到最新内容 */
let flushOpen: (() => Promise<void>) | null = null;
export function registerNoteFlush(fn: (() => Promise<void>) | null, current?: () => Promise<void>) {
  if (fn) flushOpen = fn;
  else if (flushOpen === current) flushOpen = null;
}
export const flushOpenNote = () => flushOpen?.() ?? Promise.resolve();

/** 在领域下新建一条空白的领域笔记：展开该领域，在右侧面板打开 */
export async function createFieldNote(domainId: string) {
  try {
    const note = await createNote("", Date.now(), domainId);
    const store = useLibraryStore.getState();
    store.setExpanded(domainId, true);
    store.openNote(note.id);
  } catch (e) {
    reportError(t.library.fieldNotes.createFailed)(e);
  }
}

/** 一行去掉 Markdown 标记后的文字；代码块标记、$$、分隔线这类行为 "" */
function plainLine(line: string): string {
  if (/^\s*(?:```|~~~|\$\$|(?:[-*_]\s*){3,}$)/.test(line)) return "";
  return line
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`~]+/g, "")
    .replace(/(^|\W)_+|_+(?=\W|$)/g, "$1") // _强调_ 去掉下划线，snake_case 保留
    .trim();
}

/** 笔记在列表里的名字：第一行有内容的文字（去掉 Markdown 标记）；空白笔记返回 "" */
export function noteLabel(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const s = plainLine(line);
    if (s) return s;
  }
  return "";
}

/** 删除领域笔记（连线和画布节点一起删），给出可撤销的提示。面板里还没写入的输入先写入，撤销时恢复的是最新内容 */
export async function deleteFieldNote(id: string) {
  const store = useLibraryStore.getState();
  if (store.openNoteId === id) await flushOpenNote();
  const snap = await deleteNote(id);
  if (!snap) return;
  if (store.openNoteId === id) store.openNote(null);
  useAnnotationStore.getState().showToast(t.library.fieldNotes.deleted, { undo: () => restoreNote(snap) });
}

