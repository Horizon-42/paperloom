// 领域树里的一条领域笔记（D18）：排在所属领域的最前面。单击打开右侧的笔记面板；可拖到画布上成为节点；右键删除（可撤销）。
import { t } from "@/i18n";
import { memo } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useLibraryStore } from "@/app/stores/library";
import { REF_MIME, encodeRef } from "@/components/canvas/model";
import { deleteNote, restoreNote } from "@/services/noteService";
import type { Note } from "@/types/models";
import { IconNote } from "./icons";
import { TREE_INDENT } from "./TreePaperRow";
import { cx, menuContent, menuItem, menuItemDanger } from "./ui";

/** 笔记在列表里的名字：第一行非空文字（去掉 Markdown 标题、强调等标记）；空白笔记返回 "" */
export function noteLabel(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/** 删除领域笔记（连线和画布节点一起删），给出可撤销的提示 */
export async function deleteFieldNote(id: string) {
  const store = useLibraryStore.getState();
  const snap = await deleteNote(id);
  if (!snap) return;
  if (store.openNoteId === id) store.openNote(null);
  useAnnotationStore.getState().showToast(t.library.fieldNotes.deleted, { undo: () => restoreNote(snap) });
}

interface Props {
  note: Note;
  depth: number;
  parentId: string;
  active: boolean;
  height: number;
  /** 左方向键：焦点回到所在的领域 */
  focusFolder: (id: string | null) => void;
}

export const TreeNoteRow = memo(function TreeNoteRow({ note, depth, parentId, active, height, focusFolder }: Props) {
  const label = noteLabel(note.text);
  const open = () => useLibraryStore.getState().openNote(note.id);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          role="treeitem"
          aria-level={depth + 1}
          aria-current={active ? "true" : undefined}
          tabIndex={0}
          data-note-id={note.id}
          draggable
          onDragStart={(e) => {
            // 拖到画布上 = 放一个笔记节点
            e.dataTransfer.setData(REF_MIME, encodeRef({ kind: "note", id: note.id }));
            e.dataTransfer.setData("text/plain", label || t.library.fieldNotes.untitled);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={open}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter") open();
            else if (e.key === "ArrowLeft") focusFolder(parentId);
            else if (e.key === "Delete" || e.key === "Backspace") void deleteFieldNote(note.id);
          }}
          title={label || t.library.fieldNotes.untitled}
          style={{ height: height - 1, paddingLeft: 4 + depth * TREE_INDENT + 18 }}
          className={cx(
            "flex cursor-default select-none items-center gap-1.5 rounded-md pr-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-300 data-[state=open]:bg-neutral-100",
            active ? "bg-amber-50 text-amber-900" : "text-neutral-700 hover:bg-neutral-100",
          )}
        >
          <IconNote width={14} height={14} className={cx("shrink-0", active ? "text-amber-600" : "text-amber-500")} />
          <span className={cx("min-w-0 flex-1 truncate", !label && "text-neutral-400")}>{label || t.library.fieldNotes.untitled}</span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContent} onCloseAutoFocus={(e) => e.preventDefault()}>
          <ContextMenu.Item className={menuItem} onSelect={open}>
            {t.library.fieldNotes.open}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItemDanger} onSelect={() => void deleteFieldNote(note.id)} data-delete-note>
            {t.library.fieldNotes.delete}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
