// 论文列表中的一项：单击打开，可拖到领域上。右键菜单由外层 PaperContextMenu 统一提供。
// 行高由 paperRowHeight 给出（有标签的行多一行标签），供虚拟列表使用；标题最多两行。
// 加标签：作者行末尾的按钮（悬停/聚焦/当前论文时显示），或在行上按 T。
import { t } from "@/i18n";
import { memo } from "react";
import { useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { domainPath } from "@/services/domainTree";
import type { Domain, Paper } from "@/types/models";
import { PAPER_MIME } from "./dnd";
import { IconTagPlus } from "./icons";
import { formatAuthorsShort } from "./paperQuery";
import { TagLine } from "./TagChips";
import { isTagShortcut } from "./tagKeys";
import { cx } from "./ui";

/** 没有标签的行占用的高度（含 1px 行间距） */
export const PAPER_ROW_HEIGHT = 72;
/** 有标签的行多出的标签行高度 */
export const PAPER_TAG_LINE_HEIGHT = 20;

/** 一行论文占用的高度（含 1px 行间距） */
export function paperRowHeight(paper: Pick<Paper, "tags">): number {
  return paper.tags?.length ? PAPER_ROW_HEIGHT + PAPER_TAG_LINE_HEIGHT : PAPER_ROW_HEIGHT;
}

interface Props {
  paper: Paper;
  domainById: Map<string, Domain>;
  active: boolean;
  flash: boolean;
  /** 右键菜单正指向这一行 */
  menuOpen?: boolean;
}

const MAX_DOTS = 5;

/** 打开（或在已为这篇论文打开时关闭）锚定在论文行上的标签编辑 */
export function toggleRowTagEditor(paperId: string) {
  const st = useLibraryStore.getState();
  if (st.tagEditor?.paperId === paperId && st.tagEditor.anchor.kind === "row") st.closeTagEditor();
  else st.openTagEditor(paperId, { kind: "row" });
}

export const PaperRow = memo(function PaperRow({ paper, domainById, active, flash, menuOpen }: Props) {
  const domains = paper.domainIds.map((id) => domainById.get(id)).filter((d): d is Domain => !!d);
  const authors = formatAuthorsShort(paper.authors);
  const tags = paper.tags ?? [];
  const editing = useLibraryStore((s) => s.tagEditor?.paperId === paper.id && s.tagEditor.anchor.kind === "row");
  const open = () => useReaderStore.getState().openPaper(paper.id);

  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={0}
      data-paper-id={paper.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(PAPER_MIME, paper.id);
        e.dataTransfer.setData("text/plain", paper.title);
        // 拖到领域上是移动，拖到画布上是放一张卡片（复制）
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // 行内按钮上的按键
        if (e.key === "Enter") open();
        else if (isTagShortcut(e)) {
          e.preventDefault();
          useLibraryStore.getState().openTagEditor(paper.id, { kind: "row" });
        }
      }}
      title={paper.title}
      aria-keyshortcuts="T"
      style={{ height: paperRowHeight(paper) - 1 }}
      className={cx(
        "group flex cursor-default select-none flex-col justify-center rounded-md px-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-300",
        flash
          ? "bg-amber-50 ring-1 ring-inset ring-amber-300"
          : menuOpen || editing
            ? "bg-neutral-100 ring-1 ring-inset ring-neutral-300"
            : active
              ? "bg-blue-50"
              : "hover:bg-neutral-100",
      )}
    >
      <div className={cx("line-clamp-2 text-[13px] font-medium leading-snug", active ? "text-blue-900" : "text-neutral-800")}>
        {paper.title}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11.5px] leading-4 text-neutral-500">
        <span className={cx("min-w-0 flex-1 truncate", !authors && "text-neutral-300")}>{authors || t.library.paperRow.unknownAuthors}</span>
        {paper.year !== undefined && <span className="shrink-0 tabular-nums">{paper.year}</span>}
        {domains.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5" aria-label={t.library.paperRow.domains(domains.map((d) => d.name))}>
            {domains.slice(0, MAX_DOTS).map((d) => (
              <span key={d.id} title={domainPath(domainById, d.id)} className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
            ))}
            {domains.length > MAX_DOTS && <span className="text-[10px] text-neutral-400">+{domains.length - MAX_DOTS}</span>}
          </span>
        )}
        {/* 加标签按钮：在作者行末尾占固定位置（悬停/聚焦/当前论文时才显示），不盖住标题、不改变行高 */}
        <button
          type="button"
          tabIndex={-1}
          draggable={false}
          data-tag-trigger={paper.id}
          aria-label={t.library.paperRow.editTags}
          title={t.library.paperRow.editTags}
          onClick={(e) => {
            e.stopPropagation(); // 不打开论文
            toggleRowTagEditor(paper.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cx(
            "-my-0.5 -mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-white hover:text-neutral-700 hover:shadow-sm",
            editing && "bg-white text-neutral-700 shadow-sm",
            editing || active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
          )}
        >
          <IconTagPlus width={14} height={14} />
        </button>
      </div>
      {tags.length > 0 && <TagLine tags={tags} />}
    </div>
  );
});
