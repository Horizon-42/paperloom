// 批注模块的全局挂载点：选区工具栏、撤销提示、朗读播放条、替换 PDF 对话框；Esc 取消选中批注
import { useEffect } from "react";
import { useAnnotationStore } from "@/app/stores/annotation";
import { ReadAloudBar } from "./ReadAloudBar";
import { ReplacePdfDialog } from "./ReplacePdfDialog";
import { SelectionToolbar } from "./SelectionToolbar";
import { UndoToast } from "./UndoToast";

export function AnnotationHost() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 编辑器里的 Esc（取消编辑）会 preventDefault
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const st = useAnnotationStore.getState();
      if (st.selected && !st.editingId) st.select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <SelectionToolbar />
      <UndoToast />
      <ReadAloudBar />
      <ReplacePdfDialog />
    </>
  );
}
