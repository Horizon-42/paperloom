// 全局的撤销 / 重做快捷键（D20）：⌘/Ctrl + Z 撤销，⌘/Ctrl + Shift + Z 或 Ctrl + Y 重做。
// 焦点在输入框、编辑器、对话框里时不处理，交给它们自己（文字编辑有各自的撤销）。
import { useEffect } from "react";
import { useAnnotationStore } from "@/app/stores/annotation";
import { redo, undo } from "@/db/undo";
import { t } from "@/i18n";
import { reportError } from "@/components/annotation/actions";

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor, [role="dialog"]';

export function UndoShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || !(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || (key === "y" && e.ctrlKey && !e.metaKey);
      if (!isUndo && !isRedo) return;
      if ((e.target as Element | null)?.closest?.(EDITABLE)) return;
      e.preventDefault();
      const toast = useAnnotationStore.getState().showToast;
      const tx = t.common.undoRedo;
      void (isUndo ? undo() : redo())
        .then((did) => toast(did ? (isUndo ? tx.undone : tx.redone) : isUndo ? tx.nothingToUndo : tx.nothingToRedo))
        .catch(reportError(isUndo ? tx.undoFailed : tx.redoFailed));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
