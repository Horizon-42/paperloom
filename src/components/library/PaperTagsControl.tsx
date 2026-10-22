// 阅读器工具栏上的标签按钮：显示这一栏论文的前两个标签（其余折叠为 "+N"），没有标签时显示"加标签"；
// 点击、或焦点在这一栏里时按 T，打开标签编辑弹层（弹层本身由侧栏的 TagEditorHost 渲染）。
import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useLibraryStore } from "@/app/stores/library";
import type { PaneId } from "@/app/stores/reader";
import { getPaper } from "@/db/repo/papers";
import { IconTag } from "./icons";
import { TagChip } from "./TagChips";
import { hasOpenLayer, isTagShortcut, isTextEntry } from "./tagKeys";
import { cx } from "./ui";

const MAX_SHOWN = 2;

function toggle(paneId: PaneId, paperId: string) {
  const st = useLibraryStore.getState();
  const cur = st.tagEditor;
  if (cur?.paperId === paperId && cur.anchor.kind === "toolbar" && cur.anchor.paneId === paneId) st.closeTagEditor();
  else st.openTagEditor(paperId, { kind: "toolbar", paneId });
}

export function PaperTagsControl({ paneId, paperId }: { paneId: PaneId; paperId: string }) {
  const tags = useLiveQuery(async () => (await getPaper(paperId))?.tags ?? [], [paperId]);
  const open = useLibraryStore((s) => s.tagEditor?.paperId === paperId && s.tagEditor.anchor.kind === "toolbar" && s.tagEditor.anchor.paneId === paneId);

  // 焦点在这一栏（页面、批注栏等）里时按 T；在输入框/编辑器里打字、或有其他弹层开着时不响应
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !isTagShortcut(e)) return;
      const active = document.activeElement;
      const paneEl = document.querySelector(`[data-pane="${paneId}"]`);
      if (!active || !paneEl?.contains(active) || isTextEntry(active) || hasOpenLayer()) return;
      e.preventDefault();
      useLibraryStore.getState().openTagEditor(paperId, { kind: "toolbar", paneId });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paneId, paperId]);

  if (!tags) return null;
  const shown = tags.slice(0, MAX_SHOWN);
  const more = tags.length - shown.length;
  const label = tags.length ? `标签：${tags.join("、")}（T 编辑）` : "加标签（T）";

  return (
    <button
      type="button"
      data-tag-control={paperId}
      aria-label={label}
      title={label}
      aria-expanded={open}
      onClick={() => toggle(paneId, paperId)}
      className={cx(
        "flex h-6 min-w-0 items-center gap-1 rounded px-1.5 hover:bg-neutral-100",
        open && "bg-neutral-100",
        !tags.length && "text-neutral-500",
      )}
    >
      <IconTag width={13} height={13} className="shrink-0" />
      {tags.length ? (
        <>
          {shown.map((t) => (
            <TagChip key={t} tag={t} style={{ maxWidth: 96 }} />
          ))}
          {more > 0 && <span className="shrink-0 text-[10.5px] tabular-nums text-neutral-400">+{more}</span>}
        </>
      ) : (
        <span className="whitespace-nowrap">加标签</span>
      )}
    </button>
  );
}
