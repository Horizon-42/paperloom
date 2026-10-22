// 领域树里的一篇论文：单行（标题 + 年份），悬停看作者和标签。单击打开，拖到别的领域上是移动（记下从哪个领域拖出）。
// 加标签：行末的按钮（悬停/聚焦/当前论文时显示），或在行上按 T。右键菜单由外层 PaperContextMenu 统一提供。
import { t } from "@/i18n";
import { memo } from "react";
import { useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { domainPath } from "@/services/domainTree";
import type { Domain, Paper } from "@/types/models";
import { PAPER_FROM_MIME, PAPER_MIME } from "./dnd";
import { IconFile, IconLinked, IconTagPlus } from "./icons";
import { formatAuthorsShort } from "./paperQuery";
import { isRowEditing, toggleRowTagEditor } from "./PaperRow";
import { isTagShortcut } from "./tagKeys";
import { cx } from "./ui";

/** 行高（含 1px 行间距） */
export const TREE_PAPER_ROW_HEIGHT = 27;
/** 每层缩进 */
export const TREE_INDENT = 14;

interface Props {
  paper: Paper;
  depth: number;
  parentId: string | null;
  multi: boolean;
  domainById: ReadonlyMap<string, Domain>;
  active: boolean;
  flash: boolean;
  menuOpen: boolean;
  /** 左方向键：焦点回到所在的领域（null = 「未分类」） */
  focusFolder: (id: string | null) => void;
}

export const TreePaperRow = memo(function TreePaperRow({ paper, depth, parentId, multi, domainById, active, flash, menuOpen, focusFolder }: Props) {
  const editing = useLibraryStore((s) => isRowEditing(s.tagEditor, paper.id, parentId));
  const open = () => useReaderStore.getState().openPaper(paper.id);
  const authors = formatAuthorsShort(paper.authors);
  const tags = paper.tags ?? [];
  const tooltip = [paper.title, authors || t.library.paperRow.unknownAuthors, tags.length ? tags.map((x) => `#${x}`).join(" ") : ""]
    .filter(Boolean)
    .join("\n");
  const others = multi
    ? [...new Set(paper.domainIds)].filter((id) => id !== parentId && domainById.has(id)).map((id) => domainPath(domainById as Map<string, Domain>, id))
    : [];

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-current={active ? "true" : undefined}
      tabIndex={0}
      data-paper-id={paper.id}
      data-parent-domain-id={parentId ?? ""}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PAPER_MIME, paper.id);
        e.dataTransfer.setData(PAPER_FROM_MIME, parentId ?? "-");
        e.dataTransfer.setData("text/plain", paper.title);
        // 拖到领域上是移动，拖到画布上是放一张卡片（复制）
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // 行内按钮上的按键
        if (e.key === "Enter") open();
        else if (e.key === "ArrowLeft") focusFolder(parentId);
        else if (isTagShortcut(e)) {
          e.preventDefault();
          useLibraryStore.getState().openTagEditor(paper.id, { kind: "row", parentId });
        }
      }}
      title={tooltip}
      aria-keyshortcuts="T"
      style={{ height: TREE_PAPER_ROW_HEIGHT - 1, paddingLeft: 4 + depth * TREE_INDENT + 16 }}
      className={cx(
        "group flex cursor-default select-none items-center gap-1.5 rounded-md pr-1 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-300",
        flash
          ? "bg-amber-50 ring-1 ring-inset ring-amber-300"
          : menuOpen || editing
            ? "bg-neutral-100 ring-1 ring-inset ring-neutral-300"
            : active
              ? "bg-blue-50 text-blue-900"
              : "text-neutral-700 hover:bg-neutral-100",
      )}
    >
      <IconFile width={13} height={13} className={cx("shrink-0", active ? "text-blue-500" : "text-neutral-400")} />
      <span className="min-w-0 flex-1 truncate">{paper.title}</span>
      {multi && (
        <span role="img" className="flex shrink-0 text-neutral-400" title={t.library.tree.alsoIn(others)} aria-label={t.library.tree.alsoIn(others)} data-multi-field>
          <IconLinked width={12} height={12} />
        </span>
      )}
      {paper.year !== undefined && <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">{paper.year}</span>}
      <button
        type="button"
        tabIndex={-1}
        draggable={false}
        data-tag-trigger={paper.id}
        aria-label={t.library.paperRow.editTags}
        title={t.library.paperRow.editTags}
        onClick={(e) => {
          e.stopPropagation(); // 不打开论文
          toggleRowTagEditor(paper.id, parentId);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cx(
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-white hover:text-neutral-700 hover:shadow-sm",
          editing && "bg-white text-neutral-700 shadow-sm",
          editing || active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
        )}
      >
        <IconTagPlus width={13} height={13} />
      </button>
    </div>
  );
});
