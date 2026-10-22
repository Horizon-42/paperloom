// 领域树（按领域浏览）：领域是可展开的文件夹，论文在其中；末尾是「未分类」。
// 拖放：领域拖到领域上调整层级；论文拖到领域（或该领域里的论文）上是移动——移出拖出时所在的领域（D14）。
// 行数可能很多（每个展开的领域的论文都在里面），用虚拟列表渲染。
import { t } from "@/i18n";
import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useLibraryStore } from "@/app/stores/library";
import { filterPapersByTags } from "@/lib/tags";
import { DOMAIN_COLORS, createDomain, moveDomain, renameDomain, setDomainColor } from "@/services/domainService";
import { computeDomainMove, type DomainDrop, type DropPosition } from "@/services/domainTree";
import { movePaperOutOfDomains, movePaperToDomain, restorePaperDomains } from "@/services/paperService";
import type { Domain } from "@/types/models";
import { DOMAIN_MIME, PAPER_FROM_MIME, PAPER_MIME, hasType } from "./dnd";
import { UNFILED_ROW_KEY, buildFieldTreeRows, folderRowKey, revealPath, type FieldTreeRow } from "./fieldTree";
import { IconCheck, IconChevronRight, IconInbox, IconMore, IconPlus } from "./icons";
import { useLibraryData } from "./libraryData";
import { PaperContextMenu } from "./PaperContextMenu";
import { useActivePaperId } from "./PaperList";
import { sortPapers } from "./paperQuery";
import { TREE_INDENT, TREE_PAPER_ROW_HEIGHT, TreePaperRow } from "./TreePaperRow";
import { cx, iconBtn, menuContent, menuItem, menuItemDanger, menuSeparator } from "./ui";
import { VirtualList, type VirtualListHandle } from "./VirtualList";

const INDENT = TREE_INDENT;
const FOLDER_ROW_HEIGHT = 29;
/** 放置提示里「未分类」的 id */
const UNFILED = "__unfiled__";
const NO_IDS: ReadonlySet<string> = new Set();

interface DropHint {
  /** 领域 id；UNFILED 是「未分类」；null 是顶层末尾的放置区 */
  targetId: string | null;
  position: DropPosition;
}

/** 新建领域并进入重命名状态 */
export async function createAndRename(parentId: string | null) {
  const store = useLibraryStore.getState();
  if (parentId) store.setExpanded(parentId, true);
  const d = await createDomain({ parentId });
  store.setRenamingDomain(d.id);
}

const rowHeight = (r: FieldTreeRow) => (r.kind === "paper" ? TREE_PAPER_ROW_HEIGHT : FOLDER_ROW_HEIGHT);
const rowKey = (r: FieldTreeRow) => r.key;

/**
 * 拖动结束时调用 onEnd。被拖的行可能已被虚拟列表卸载（拖动中滚动了），这时 dragend 到不了 window，
 * 所以再加一道：结束后第一次没有按键的指针移动也算结束（拖动期间按着键，且 Chromium 根本不派发 pointermove）
 */
function useDragEnd(onEnd: () => void) {
  const ref = useRef(onEnd);
  ref.current = onEnd;
  useEffect(() => {
    const end = () => ref.current();
    const move = (e: PointerEvent) => e.buttons === 0 && ref.current();
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
      window.removeEventListener("pointermove", move);
    };
  }, []);
}

/** 正在拖动页面里的论文（拖到「未分类」上要用到它，即使「未分类」为空） */
function usePaperDragging(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const start = (e: globalThis.DragEvent) => hasType(e, PAPER_MIME) && setDragging(true);
    window.addEventListener("dragstart", start);
    return () => window.removeEventListener("dragstart", start);
  }, []);
  useDragEnd(() => setDragging((d) => (d ? false : d)));
  return dragging;
}

export function DomainTree() {
  const { tree, domains, domainById, papers, paperById, loaded } = useLibraryData();
  const selection = useLibraryStore((s) => s.selection);
  const expanded = useLibraryStore((s) => s.expanded);
  const unfiledOpen = useLibraryStore((s) => s.unfiledOpen);
  const renamingId = useLibraryStore((s) => s.renamingDomainId);
  const draggingDomainId = useLibraryStore((s) => s.draggingDomainId);
  const sort = useLibraryStore((s) => s.sort);
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const reveal = useLibraryStore((s) => s.reveal);
  const activePaperId = useActivePaperId();
  const paperDragging = usePaperDragging();

  // 按标签筛选时：有匹配论文的领域都自动展开；在这次筛选里手动收起的记在这里
  const filtering = tagFilter.length > 0;
  const filterKey = tagFilter.join("\u0000");
  const [collapsedState, setCollapsedState] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: "", ids: new Set() });
  const filterCollapsed = collapsedState.key === filterKey ? collapsedState.ids : NO_IDS;

  const visiblePapers = useMemo(() => sortPapers(filterPapersByTags(papers, tagFilter), sort), [papers, tagFilter, sort]);
  const rows = useMemo(
    () =>
      buildFieldTreeRows({
        tree,
        papers: visiblePapers,
        domainById,
        isExpanded: filtering ? (id) => !filterCollapsed.has(id) : (id) => !!expanded[id],
        unfiledOpen: filtering ? !filterCollapsed.has(UNFILED) : unfiledOpen,
        filtering,
        showEmptyUnfiled: paperDragging && domains.length > 0,
        keepVisible: renamingId,
      }),
    [tree, visiblePapers, domainById, filtering, filterCollapsed, expanded, unfiledOpen, paperDragging, domains.length, renamingId],
  );

  const setOpen = (id: string, open: boolean) => {
    if (filtering) {
      setCollapsedState((cur) => {
        const ids = cur.key === filterKey ? cur.ids : NO_IDS;
        if (ids.has(id) === !open) return cur;
        const next = new Set(ids);
        if (open) next.delete(id);
        else next.add(id);
        return { key: filterKey, ids: next };
      });
    } else if (id === UNFILED) useLibraryStore.getState().setUnfiledOpen(open);
    else useLibraryStore.getState().setExpanded(id, open);
  };

  const [hint, setHint] = useState<DropHint | null>(null);
  const [flashFolder, setFlashFolder] = useState<string | null>(null);
  const [flashPaper, setFlashPaper] = useState<string | null>(null);
  const expandTimer = useRef<{ id: string; timer: number } | null>(null);
  const listRef = useRef<VirtualListHandle>(null);

  // 拖动结束（包括拖到窗口外取消）时清除提示
  useDragEnd(() => {
    setHint((h) => (h ? null : h));
    const st = useLibraryStore.getState();
    if (st.draggingDomainId) st.setDraggingDomain(null);
    if (expandTimer.current) window.clearTimeout(expandTimer.current.timer);
    expandTimer.current = null;
  });

  useEffect(() => {
    if (!flashFolder) return;
    const timer = window.setTimeout(() => setFlashFolder(null), 900);
    return () => window.clearTimeout(timer);
  }, [flashFolder]);
  useEffect(() => {
    if (!flashPaper) return;
    const timer = window.setTimeout(() => setFlashPaper(null), 1800);
    return () => window.clearTimeout(timer);
  }, [flashPaper]);

  // 新建的领域进入重命名：它可能排在很多论文之后、不在已渲染的行里，滚动过去，输入框才会挂载并获得焦点
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!renamingId) {
      scrolledFor.current = null;
      return;
    }
    if (scrolledFor.current === renamingId) return;
    const index = rows.findIndex((r) => r.kind === "folder" && r.node.domain.id === renamingId);
    if (index < 0) return; // 等实时查询带回新领域
    scrolledFor.current = renamingId;
    listRef.current?.scrollToIndex(index);
  }, [renamingId, rows]);

  // 定位请求（导入完成、点导入结果）：展开论文所在的领域（或「未分类」）、清除挡住它的标签筛选，然后滚动到它并闪烁
  useEffect(() => {
    if (!reveal || !loaded) return;
    const paper = paperById.get(reveal.paperId);
    if (!paper) return; // 等实时查询带回新论文
    const index = rows.findIndex((r) => r.kind === "paper" && r.paper.id === paper.id);
    const st = useLibraryStore.getState();
    if (index >= 0) {
      st.clearReveal();
      setFlashPaper(paper.id);
      listRef.current?.scrollToIndex(index);
      return;
    }
    if (!filterPapersByTags([paper], st.tagFilter).length) {
      st.setTagFilter([]);
      return;
    }
    const path = revealPath(tree, paper);
    const open = path ? [...path.ancestors, path.folderId] : [UNFILED];
    const closed = open.filter((id) =>
      filtering ? filterCollapsed.has(id) : id === UNFILED ? !st.unfiledOpen : !st.expanded[id],
    );
    if (!closed.length) {
      st.clearReveal(); // 不应发生；避免反复重试
      return;
    }
    for (const id of closed) setOpen(id, true);
  }, [reveal, rows, paperById, tree, loaded]); // 其他状态都随 rows 变化

  const setHintIfChanged = (h: DropHint | null) =>
    setHint((cur) => (cur?.targetId === h?.targetId && cur?.position === h?.position ? cur : h));

  /** 拖着悬停在折叠的领域上一会儿后自动展开 */
  const scheduleExpand = (id: string, expandable: boolean, isOpen: boolean) => {
    if (!expandable || isOpen) return;
    if (expandTimer.current?.id === id) return;
    if (expandTimer.current) window.clearTimeout(expandTimer.current.timer);
    expandTimer.current = { id, timer: window.setTimeout(() => setOpen(id, true), 700) };
  };

  /** 根据指针位置算出领域的放置方式；不合法时返回 null */
  const resolveDomainDrop = (e: DragEvent, row: FolderRowData): { position: DropPosition; drop: DomainDrop } | null => {
    const dragId = useLibraryStore.getState().draggingDomainId;
    if (!dragId) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    let position: DropPosition = y < 0.3 ? "before" : y > 0.7 ? "after" : "inside";
    // 展开、只有论文没有子领域的领域：下沿紧挨着它自己的论文，放在"之后"会落到这些论文的后面，看起来不对，按"放进去"处理
    if (position === "after" && row.expanded && !row.node.children.length) position = "inside";
    let drop: DomainDrop = { targetId: row.node.domain.id, position };
    // 展开节点的下沿在视觉上是"第一个子领域之前"
    if (position === "after" && row.expanded && row.node.children.length) {
      drop = { targetId: row.node.children[0].domain.id, position: "before" };
    }
    return computeDomainMove(domains, dragId, drop) === null ? null : { position, drop };
  };

  /**
   * 论文拖到领域上 = 移动：从领域树里拖时移出它所在的那个领域；从「未分类」、全部论文列表或搜索结果里拖时移出所有领域。
   * 拖到「未分类」上 = 移出拖出时所在的领域。要保留原领域、再加一个，用右键菜单的「添加到领域」
   */
  const dropPaper = async (e: DragEvent, targetId: string) => {
    const paperId = e.dataTransfer.getData(PAPER_MIME);
    if (!paperId) return;
    const fromRaw = e.dataTransfer.getData(PAPER_FROM_MIME);
    const fromDomain = fromRaw && fromRaw !== "-" ? fromRaw : null;
    const from = fromDomain ? [fromDomain] : "all";
    const toast = useAnnotationStore.getState().showToast;
    if (targetId === UNFILED) {
      if (fromRaw === "-") return; // 本来就在「未分类」里
      const before = await movePaperOutOfDomains(paperId, from);
      if (!before) return;
      const left = before.filter((id) => (fromDomain ? id !== fromDomain : false) && domainById.has(id));
      if (!left.length) setFlashFolder(UNFILED); // 还在别的领域里时它不会出现在「未分类」
      const fromName = fromDomain ? domainById.get(fromDomain)?.name : undefined;
      toast(fromName ? t.library.movePaper.removedFrom(fromName) : t.library.movePaper.movedToUnfiled, {
        undo: () => restorePaperDomains(paperId, before),
      });
      return;
    }
    const target = domainById.get(targetId);
    if (!target || fromDomain === targetId) return;
    const before = await movePaperToDomain(paperId, targetId, from);
    if (!before) return;
    setFlashFolder(targetId);
    toast(t.library.movePaper.moved(target.name), { undo: () => restorePaperDomains(paperId, before) });
  };

  const onFolderDragOver = (e: DragEvent, row: FolderRowData) => {
    const id = row.node.domain.id;
    if (hasType(e, PAPER_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setHintIfChanged({ targetId: id, position: "inside" });
      scheduleExpand(id, row.expandable, row.expanded);
      return;
    }
    if (!hasType(e, DOMAIN_MIME)) return;
    const r = resolveDomainDrop(e, row);
    if (!r) {
      setHintIfChanged(null);
      return; // 不 preventDefault → 浏览器显示禁止放置
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHintIfChanged({ targetId: id, position: r.position });
    if (r.position === "inside") scheduleExpand(id, row.expandable, row.expanded);
  };

  const onFolderDrop = (e: DragEvent, row: FolderRowData) => {
    const id = row.node.domain.id;
    if (hasType(e, PAPER_MIME)) {
      e.preventDefault();
      void dropPaper(e, id);
    } else if (hasType(e, DOMAIN_MIME)) {
      const r = resolveDomainDrop(e, row);
      const dragId = useLibraryStore.getState().draggingDomainId;
      if (!r || !dragId) return;
      e.preventDefault();
      void moveDomain(dragId, r.drop).then((ok) => {
        if (ok && r.drop.position === "inside") setOpen(id, true);
      });
    }
    setHint(null);
  };

  /** 论文拖到「未分类」上，或拖到某个领域里的论文上（= 拖到那个领域上） */
  const onPaperTargetDragOver = (e: DragEvent, targetId: string) => {
    if (!hasType(e, PAPER_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHintIfChanged({ targetId, position: "inside" });
  };
  const onPaperTargetDrop = (e: DragEvent, targetId: string) => {
    if (!hasType(e, PAPER_MIME)) return;
    e.preventDefault();
    void dropPaper(e, targetId);
    setHint(null);
  };

  const onDragLeave = (e: DragEvent, targetId: string) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setHint((cur) => (cur?.targetId === targetId ? null : cur));
    // 只是经过：不再自动展开
    if (expandTimer.current?.id === targetId) {
      window.clearTimeout(expandTimer.current.timer);
      expandTimer.current = null;
    }
  };

  /** 把焦点移到某个领域（null = 「未分类」）的行上：它可能不在已渲染的行里，先滚动过去 */
  const focusFolder = (id: string | null) => {
    const index = rows.findIndex((r) => r.key === (id ? folderRowKey(id) : UNFILED_ROW_KEY));
    if (index < 0) return;
    listRef.current?.scrollToIndex(index);
    const sel = id ? `[data-domain-id="${CSS.escape(id)}"]` : "[data-unfiled]";
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-library-sidebar] [role="tree"] ${sel}`)?.focus());
  };

  // 行组件用 memo；处理函数通过 ref 取最新闭包，保持引用稳定
  const latest = useRef({ onFolderDragOver, onFolderDrop, onPaperTargetDragOver, onPaperTargetDrop, onDragLeave, setOpen, focusFolder });
  latest.current = { onFolderDragOver, onFolderDrop, onPaperTargetDragOver, onPaperTargetDrop, onDragLeave, setOpen, focusFolder };
  const handlers = useMemo<RowHandlers>(
    () => ({
      onFolderDragOver: (e, row) => latest.current.onFolderDragOver(e, row),
      onFolderDrop: (e, row) => latest.current.onFolderDrop(e, row),
      onTargetDragOver: (e, id) => latest.current.onPaperTargetDragOver(e, id),
      onTargetDrop: (e, id) => latest.current.onPaperTargetDrop(e, id),
      onDragLeave: (e, id) => latest.current.onDragLeave(e, id),
      setOpen: (id, open) => latest.current.setOpen(id, open),
      focusFolder: (id) => latest.current.focusFolder(id),
    }),
    [],
  );

  const onRootZoneDragOver = (e: DragEvent) => {
    const dragId = useLibraryStore.getState().draggingDomainId;
    if (!hasType(e, DOMAIN_MIME) || !dragId) return;
    if (computeDomainMove(domains, dragId, { targetId: null, position: "inside" }) === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHintIfChanged({ targetId: null, position: "inside" });
  };

  const onRootZoneDrop = (e: DragEvent) => {
    const dragId = useLibraryStore.getState().draggingDomainId;
    if (!hasType(e, DOMAIN_MIME) || !dragId) return;
    e.preventDefault();
    void moveDomain(dragId, { targetId: null, position: "inside" });
    setHint(null);
  };

  /** 上下方向键在相邻的行之间移动焦点（虚拟列表前后多渲染几行，相邻行总在 DOM 里） */
  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && useLibraryStore.getState().selection.kind !== "all") {
      useLibraryStore.getState().select({ kind: "all" }); // 取消选中的领域（导入目标）
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // 焦点在行内的按钮上（如点过的展开箭头）时按所在的行算
    const cur = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!cur) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const next = items[items.indexOf(cur) + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const empty =
    loaded && rows.length === 0 ? (
      <EmptyState libraryEmpty={papers.length === 0} noDomains={domains.length === 0} filtering={filtering} tagFilter={tagFilter} />
    ) : null;

  return (
    <nav className="relative flex min-h-0 flex-1 flex-col" aria-label={t.library.domains.navLabel}>
      {/* 有论文但还没有领域：提示怎么建 */}
      {loaded && domains.length === 0 && papers.length > 0 && !filtering && (
        <p className="px-4 pb-1 pt-0.5 text-[11.5px] leading-relaxed text-neutral-400">{t.library.domains.empty}</p>
      )}
      {/* 拖动领域时：移到顶层的放置区浮在树的底部（不能放在列表末尾：可能隔着很长的「未分类」；也不能挤开列表，否则拖动中行会移位） */}
      {draggingDomainId && (
        <div
          onDragOver={onRootZoneDragOver}
          onDragLeave={() => setHint((cur) => (cur?.targetId === null ? null : cur))}
          onDrop={onRootZoneDrop}
          className={cx(
            "absolute inset-x-2 bottom-2 z-10 rounded-md border border-dashed px-2 py-1.5 text-center text-[11px] shadow-sm",
            hint?.targetId === null ? "border-blue-400 bg-blue-50 text-blue-600" : "border-neutral-300 bg-neutral-50 text-neutral-500",
          )}
        >
          {t.library.domains.dropToRoot}
        </div>
      )}
      <PaperContextMenu>
        {(menuTarget) => (
          <VirtualList
            role="tree"
            onKeyDown={onTreeKeyDown}
            aria-label={t.library.domains.treeLabel}
            className="min-h-0 flex-1 overflow-y-auto"
            items={rows}
            rowHeight={rowHeight}
            getKey={rowKey}
            handleRef={listRef}
            paddingTop={4}
            paddingBottom={draggingDomainId ? 52 : 12} // 拖领域时底部浮着"移到顶层"的放置区，留出位置，最后一行仍可放置
            renderItem={(row) => {
              if (row.kind === "folder") {
                const id = row.node.domain.id;
                return (
                  <FolderRow
                    row={row}
                    selected={selection.kind === "domain" && selection.id === id}
                    renaming={renamingId === id}
                    hint={hint?.targetId === id ? hint.position : null}
                    flash={flashFolder === id}
                    handlers={handlers}
                  />
                );
              }
              if (row.kind === "unfiled") {
                return (
                  <UnfiledRow
                    count={row.count}
                    expanded={row.expanded}
                    selected={selection.kind === "unfiled"}
                    hint={hint?.targetId === UNFILED}
                    flash={flashFolder === UNFILED}
                    handlers={handlers}
                  />
                );
              }
              const target = row.parentId ?? UNFILED;
              return (
                <div
                  onDragOver={(e) => handlers.onTargetDragOver(e, target)}
                  onDragLeave={(e) => handlers.onDragLeave(e, target)}
                  onDrop={(e) => handlers.onTargetDrop(e, target)}
                >
                  <TreePaperRow
                    paper={row.paper}
                    depth={row.depth}
                    parentId={row.parentId}
                    multi={row.multi}
                    domainById={domainById}
                    active={row.paper.id === activePaperId}
                    flash={row.paper.id === flashPaper}
                    menuOpen={menuTarget?.paperId === row.paper.id && menuTarget.parentId === row.parentId}
                    focusFolder={handlers.focusFolder}
                  />
                </div>
              );
            }}
            footer={empty}
          />
        )}
      </PaperContextMenu>
    </nav>
  );
}

function EmptyState(props: { libraryEmpty: boolean; noDomains: boolean; filtering: boolean; tagFilter: string[] }) {
  if (props.filtering && !props.libraryEmpty) {
    return (
      <div className="px-2.5 py-6 text-center text-xs leading-relaxed text-neutral-400">
        <p>{t.library.paperList.noTagged(props.tagFilter)}</p>
        <button
          type="button"
          onClick={() => useLibraryStore.getState().setTagFilter([])}
          className="mt-1.5 rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-50"
        >
          {t.library.paperList.clearTagFilter}
        </button>
      </div>
    );
  }
  const text = props.libraryEmpty && props.noDomains ? t.library.paperList.emptyLibrary : t.library.domains.empty;
  return <p className="px-4 py-6 text-center text-xs leading-relaxed text-neutral-400">{text}</p>;
}

type FolderRowData = Extract<FieldTreeRow, { kind: "folder" }>;

interface RowHandlers {
  onFolderDragOver: (e: DragEvent, row: FolderRowData) => void;
  onFolderDrop: (e: DragEvent, row: FolderRowData) => void;
  /** 只接受论文的放置目标：「未分类」、领域里的论文行 */
  onTargetDragOver: (e: DragEvent, targetId: string) => void;
  onTargetDrop: (e: DragEvent, targetId: string) => void;
  onDragLeave: (e: DragEvent, targetId: string) => void;
  setOpen: (id: string, open: boolean) => void;
  focusFolder: (id: string | null) => void;
}

interface FolderRowProps {
  row: FolderRowData;
  selected: boolean;
  renaming: boolean;
  hint: DropPosition | null;
  flash: boolean;
  handlers: RowHandlers;
}

const FolderRow = memo(function FolderRow({ row, selected, renaming, hint, flash, handlers }: FolderRowProps) {
  const { node, depth, count, expandable, expanded } = row;
  const { domain } = node;
  const [menuOpen, setMenuOpen] = useState(false);
  const store = useLibraryStore.getState;
  const indent = 4 + depth * INDENT;
  // 展开节点的"之后"提示线画在子领域的缩进处
  const afterIndent = node.children.length && expanded ? indent + INDENT : indent;
  // 再点一次已选中的领域：取消选中（之后导入不归类）；否则选中并展开
  const activate = () => {
    if (selected) {
      store().select({ kind: "all" });
      return;
    }
    store().select({ kind: "domain", id: domain.id });
    if (expandable && !expanded) handlers.setOpen(domain.id, true);
  };

  return (
    <ContextMenu.Root onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger asChild>
        <div
          role="treeitem"
          aria-selected={selected}
          aria-expanded={expandable ? expanded : undefined}
          aria-level={depth + 1}
          data-domain-id={domain.id}
          tabIndex={0}
          draggable={!renaming}
          onDragStart={(e) => {
            e.dataTransfer.setData(DOMAIN_MIME, domain.id);
            e.dataTransfer.setData("text/plain", domain.name);
            e.dataTransfer.effectAllowed = "move";
            store().setDraggingDomain(domain.id);
          }}
          onDragEnd={() => store().setDraggingDomain(null)}
          onDragOver={(e) => handlers.onFolderDragOver(e, row)}
          onDragLeave={(e) => handlers.onDragLeave(e, domain.id)}
          onDrop={(e) => handlers.onFolderDrop(e, row)}
          onClick={activate}
          onKeyDown={(e) => {
            if (renaming || e.target !== e.currentTarget) return;
            if (e.key === "Enter") activate();
            else if (e.key === "F2") store().setRenamingDomain(domain.id);
            else if (e.key === "ArrowRight" && expandable) handlers.setOpen(domain.id, true);
            else if (e.key === "ArrowLeft" && expandable && expanded) handlers.setOpen(domain.id, false);
            else if (e.key === "ArrowLeft" && domain.parentId) handlers.focusFolder(domain.parentId);
          }}
          style={{ paddingLeft: indent, height: FOLDER_ROW_HEIGHT - 1 }}
          className={cx(
            "group relative flex cursor-default select-none items-center gap-1 rounded-md pr-1 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-300",
            hint === "inside"
              ? "bg-blue-50 ring-2 ring-blue-400"
              : flash
                ? "bg-emerald-50"
                : selected
                  ? "bg-blue-50 font-medium text-blue-900"
                  : "text-neutral-700 hover:bg-neutral-100",
          )}
        >
          {hint === "before" && <DropLine className="-top-px" left={indent + 18} />}
          {hint === "after" && <DropLine className="-bottom-px" left={afterIndent + 18} />}

          <button
            type="button"
            tabIndex={-1}
            aria-label={expanded ? t.library.domains.collapse : t.library.domains.expand}
            onClick={(e) => {
              e.stopPropagation();
              handlers.setOpen(domain.id, !expanded);
            }}
            className={cx("flex h-5 w-4 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-700", !expandable && "invisible")}
          >
            <IconChevronRight width={13} height={13} className={cx("transition-transform", expanded && "rotate-90")} />
          </button>

          <ColorDot domain={domain} />

          {renaming ? (
            <RenameInput domain={domain} />
          ) : (
            <span
              className="min-w-0 flex-1 truncate"
              title={domain.name}
              onDoubleClick={(e) => {
                e.stopPropagation();
                store().setRenamingDomain(domain.id);
              }}
            >
              {domain.name}
            </span>
          )}

          {!renaming && (
            <>
              <span className={cx("px-1 text-[11px] tabular-nums text-neutral-400", menuOpen ? "hidden" : "group-hover:hidden")}>
                {count || ""}
              </span>
              <div className={cx("items-center", menuOpen ? "flex" : "hidden group-hover:flex")}>
                <button
                  type="button"
                  tabIndex={-1}
                  className={iconBtn}
                  title={t.library.domains.newSubdomain}
                  aria-label={t.library.domains.newSubdomain}
                  onClick={(e) => {
                    e.stopPropagation();
                    void createAndRename(domain.id);
                  }}
                >
                  <IconPlus width={13} height={13} />
                </button>
                <DropdownMenu.Root onOpenChange={setMenuOpen}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      tabIndex={-1}
                      className={iconBtn}
                      title={t.library.domains.more}
                      aria-label={t.library.domains.actions}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <IconMore width={14} height={14} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      sideOffset={4}
                      className={menuContent}
                      onCloseAutoFocus={(e) => e.preventDefault()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DomainMenuItems parts={DROPDOWN_PARTS} domain={domain} />
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContent} onCloseAutoFocus={(e) => e.preventDefault()}>
          <DomainMenuItems parts={CONTEXT_PARTS} domain={domain} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

interface UnfiledRowProps {
  count: number;
  expanded: boolean;
  selected: boolean;
  hint: boolean;
  flash: boolean;
  handlers: RowHandlers;
}

/** 末尾的「未分类」：不属于任何领域的论文。论文拖到这里 = 移出拖出时所在的领域 */
const UnfiledRow = memo(function UnfiledRow({ count, expanded, selected, hint, flash, handlers }: UnfiledRowProps) {
  const toggle = () => count > 0 && handlers.setOpen(UNFILED, !expanded);
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={count > 0 ? expanded : undefined}
      aria-level={1}
      tabIndex={0}
      data-unfiled
      onDragOver={(e) => handlers.onTargetDragOver(e, UNFILED)}
      onDragLeave={(e) => handlers.onDragLeave(e, UNFILED)}
      onDrop={(e) => handlers.onTargetDrop(e, UNFILED)}
      onClick={() => {
        useLibraryStore.getState().select({ kind: "unfiled" });
        toggle();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          useLibraryStore.getState().select({ kind: "unfiled" });
          toggle();
        }
        else if (e.key === "ArrowRight" && count > 0) handlers.setOpen(UNFILED, true);
        else if (e.key === "ArrowLeft" && count > 0) handlers.setOpen(UNFILED, false);
      }}
      style={{ paddingLeft: 4, height: FOLDER_ROW_HEIGHT - 1 }}
      className={cx(
        "flex cursor-default select-none items-center gap-1 rounded-md pr-1 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-300",
        hint
          ? "bg-blue-50 ring-2 ring-blue-400"
          : flash
            ? "bg-emerald-50"
            : selected
              ? "bg-blue-50 font-medium text-blue-900"
              : "text-neutral-700 hover:bg-neutral-100",
      )}
    >
      <span className={cx("flex h-5 w-4 shrink-0 items-center justify-center text-neutral-400", count === 0 && "invisible")}>
        <IconChevronRight width={13} height={13} className={cx("transition-transform", expanded && "rotate-90")} />
      </span>
      <IconInbox width={14} height={14} className="shrink-0 text-neutral-400" />
      <span className="min-w-0 flex-1 truncate">{t.library.domains.unfiled}</span>
      <span className="px-1 text-[11px] tabular-nums text-neutral-400">{count || ""}</span>
    </div>
  );
});

function DropLine({ className, left }: { className: string; left: number }) {
  return (
    <div className={cx("pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-blue-500", className)} style={{ left }}>
      <div className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full border-2 border-blue-500 bg-white" />
    </div>
  );
}

function ColorDot({ domain }: { domain: Domain }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          tabIndex={-1}
          title={t.library.domains.changeColor}
          aria-label={t.library.domains.changeColor}
          onClick={(e) => e.stopPropagation()}
          className="flex h-5 w-4 shrink-0 items-center justify-center"
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: domain.color }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          onClick={(e) => e.stopPropagation()}
          className="z-50 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg shadow-neutral-900/10"
        >
          <div className="grid grid-cols-6 gap-1.5">
            {DOMAIN_COLORS.map((c) => (
              <Popover.Close asChild key={c.value}>
                <button
                  type="button"
                  title={t.library.domains.colors[c.key]}
                  aria-label={t.library.domains.colors[c.key]}
                  onClick={() => void setDomainColor(domain.id, c.value)}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-white ring-offset-1 hover:ring-2 hover:ring-neutral-300"
                  style={{ backgroundColor: c.value }}
                >
                  {c.value === domain.color && <IconCheck width={12} height={12} strokeWidth={3} />}
                </button>
              </Popover.Close>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RenameInput({ domain }: { domain: Domain }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    // 等菜单关闭、焦点归位之后再聚焦
    const timer = window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
      ref.current?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && ref.current) void renameDomain(domain.id, ref.current.value);
    useLibraryStore.getState().setRenamingDomain(null);
  };

  return (
    <input
      ref={ref}
      defaultValue={domain.name}
      aria-label={t.library.domains.nameLabel}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded border border-blue-400 bg-white px-1.5 text-[13px] font-normal text-neutral-800 outline-none ring-2 ring-blue-100"
    />
  );
}

// ---- 领域菜单：右键菜单和"更多"下拉菜单共用同一组菜单项 ----

interface ItemProps {
  className?: string;
  children?: ReactNode;
  onSelect?: (e: Event) => void;
}
interface MenuParts {
  Item: ComponentType<ItemProps>;
  Separator: ComponentType<{ className?: string }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; children?: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children?: ReactNode; sideOffset?: number }>;
  Portal: ComponentType<{ children?: ReactNode }>;
}

const CONTEXT_PARTS: MenuParts = {
  Item: ContextMenu.Item,
  Separator: ContextMenu.Separator,
  Sub: ContextMenu.Sub,
  SubTrigger: ContextMenu.SubTrigger,
  SubContent: ContextMenu.SubContent,
  Portal: ContextMenu.Portal,
};
const DROPDOWN_PARTS: MenuParts = {
  Item: DropdownMenu.Item,
  Separator: DropdownMenu.Separator,
  Sub: DropdownMenu.Sub,
  SubTrigger: DropdownMenu.SubTrigger,
  SubContent: DropdownMenu.SubContent,
  Portal: DropdownMenu.Portal,
};

function DomainMenuItems({ parts: M, domain }: { parts: MenuParts; domain: Domain }) {
  const store = useLibraryStore.getState;
  return (
    <>
      <M.Item className={menuItem} onSelect={() => void createAndRename(domain.id)}>
        {t.library.domains.newSubdomain}
      </M.Item>
      <M.Item className={menuItem} onSelect={() => store().setRenamingDomain(domain.id)}>
        {t.common.rename}
      </M.Item>
      <M.Sub>
        <M.SubTrigger className={cx(menuItem, "justify-between data-[state=open]:bg-neutral-100")}>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: domain.color }} />
            {t.library.domains.color}
          </span>
          <IconChevronRight width={13} height={13} className="text-neutral-400" />
        </M.SubTrigger>
        <M.Portal>
          <M.SubContent className={cx(menuContent, "min-w-[120px]")} sideOffset={4}>
            {DOMAIN_COLORS.map((c) => (
              <M.Item key={c.value} className={menuItem} onSelect={() => void setDomainColor(domain.id, c.value)}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.value }} />
                <span className="flex-1">{t.library.domains.colors[c.key]}</span>
                {c.value === domain.color && <IconCheck width={13} height={13} className="text-neutral-500" />}
              </M.Item>
            ))}
          </M.SubContent>
        </M.Portal>
      </M.Sub>
      <M.Separator className={menuSeparator} />
      <M.Item className={menuItemDanger} onSelect={() => store().openDialog({ kind: "deleteDomain", domainId: domain.id })}>
        {t.library.domains.deleteDomain}
      </M.Item>
    </>
  );
}
