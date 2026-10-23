// 领域树里的一篇论文：内容和样式与全部论文列表相同（PaperRowContent），按层级缩进；也在其他领域里时带标记。
// 单击打开，拖到别的领域上是移动（记下从哪个领域拖出）。加标签：作者行末的按钮或在行上按 T。右键菜单由外层 PaperContextMenu 统一提供。
import { t } from "@/i18n";
import { memo } from "react";
import { useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { domainPath } from "@/services/domainTree";
import type { Domain, Paper } from "@/types/models";
import { PAPER_FROM_MIME, PAPER_MIME } from "./dnd";
import { IconLinked } from "./icons";
import { PaperRowContent, isRowEditing, paperRowClass, paperRowHeight, toggleRowTagEditor } from "./PaperRow";
import { isTagShortcut } from "./tagKeys";

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
      title={paper.title}
      aria-keyshortcuts="T"
      // 标题与领域名对齐（领域行：缩进 + 展开箭头）
      style={{ height: paperRowHeight(paper) - 1, paddingLeft: 4 + depth * TREE_INDENT + 18 }}
      className={paperRowClass({ active, flash, highlighted: menuOpen || editing }, "pr-2.5")}
    >
      <PaperRowContent
        paper={paper}
        active={active}
        editing={editing}
        onTagClick={() => toggleRowTagEditor(paper.id, parentId)}
        marker={
          multi && (
            <span role="img" className="flex shrink-0 text-neutral-400" title={t.library.tree.alsoIn(others)} aria-label={t.library.tree.alsoIn(others)} data-multi-field>
              <IconLinked width={12} height={12} />
            </span>
          )
        }
      />
    </div>
  );
});
