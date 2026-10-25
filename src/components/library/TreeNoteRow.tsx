// 领域树里的一条领域笔记（D18）：排在所属领域的最前面。单击打开右侧的笔记面板；可拖到画布上成为节点；右键删除（可撤销）。
import { t } from "@/i18n";
import { memo } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useLibraryStore } from "@/app/stores/library";
import { REF_MIME, encodeRef } from "@/components/canvas/model";
import type { Note } from "@/types/models";
import { IconNote } from "./icons";
import { TREE_INDENT } from "./TreePaperRow";
import { deleteFieldNote, noteLabel } from "./fieldNotes";
import { cx, menuContent, menuItem, menuItemDanger } from "./ui";

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
  const open = () => {
    const store = useLibraryStore.getState();
    // 已经打开着：把焦点交给编辑器（面板不会重新挂载）
    if (store.openNoteId === note.id) document.querySelector<HTMLElement>(`[data-note-panel="${CSS.escape(note.id)}"] .cm-content`)?.focus();
    else store.openNote(note.id);
  };
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
            // 不带 text/plain：拖到编辑器里不会插入文字
            e.dataTransfer.setData(REF_MIME, encodeRef({ kind: "note", id: note.id }));
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={open}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter") open();
            else if (e.key === "ArrowLeft") focusFolder(parentId);
            // 只认 Delete（不认 Backspace：以为焦点在编辑器里时按退格会误删）；删后焦点回到所在领域
            else if (e.key === "Delete") void deleteFieldNote(note.id).then(() => focusFolder(parentId));
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
