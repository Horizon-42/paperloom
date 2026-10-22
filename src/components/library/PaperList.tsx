// 论文列表：显示当前选中（全部 / 未分类 / 领域含子领域）下的论文，可按标签筛选（同时带有所选标签）、排序
import { t } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { filterPapersByTags, tagKey } from "@/lib/tags";
import { domainPath, getSubtreeIds } from "@/services/domainTree";
import { IconCheck, IconSort, IconTag } from "./icons";
import { useLibraryData } from "./libraryData";
import { PaperContextMenu, type CurrentDomain } from "./PaperContextMenu";
import { PaperRow, paperRowHeight } from "./PaperRow";
import { SORT_OPTIONS, filterPapersBySelection, sortLabel, sortPapers } from "./paperQuery";
import { RemovableTagChip, TagDot } from "./TagChips";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import { cx, menuContent, menuItem, menuSeparator } from "./ui";

/** 当前选中领域的名称和子树（未选中领域时为 null） */
export function useCurrentDomain(): CurrentDomain | null {
  const { domains, domainById } = useLibraryData();
  const selection = useLibraryStore((s) => s.selection);
  return useMemo(() => {
    if (selection.kind !== "domain") return null;
    const d = domainById.get(selection.id);
    return d ? { id: d.id, name: d.name, subtreeIds: getSubtreeIds(domains, d.id) } : null;
  }, [selection, domains, domainById]);
}

/** 焦点分栏里正在显示的论文 */
export function useActivePaperId(): string | null {
  return useReaderStore((s) => s.panes.find((p) => p.id === s.focusedPane)?.activePaperId ?? null);
}

export function PaperList() {
  const { papers, paperById, domains, domainById, loaded } = useLibraryData();
  const selection = useLibraryStore((s) => s.selection);
  const sort = useLibraryStore((s) => s.sort);
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const reveal = useLibraryStore((s) => s.reveal);
  const currentDomain = useCurrentDomain();
  const activePaperId = useActivePaperId();

  const visible = useMemo(
    () => sortPapers(filterPapersByTags(filterPapersBySelection(papers, domains, selection), tagFilter), sort),
    [papers, domains, selection, tagFilter, sort],
  );

  // 定位请求：论文不在当前视图时切到"全部论文"、或清除挡住它的标签筛选，然后滚动到它并闪烁
  const listRef = useRef<VirtualListHandle>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!reveal || !loaded) return;
    const paper = paperById.get(reveal.paperId);
    if (!paper) return; // 等实时查询带回新论文
    const index = visible.findIndex((p) => p.id === reveal.paperId);
    if (index < 0) {
      const st = useLibraryStore.getState();
      let changed = false;
      if (!filterPapersBySelection([paper], domains, st.selection).length) {
        st.select({ kind: "all" });
        changed = true;
      }
      if (!filterPapersByTags([paper], st.tagFilter).length) {
        st.setTagFilter([]);
        changed = true;
      }
      if (!changed) st.clearReveal(); // 不应发生；避免反复重试
      return;
    }
    useLibraryStore.getState().clearReveal();
    setFlashId(reveal.paperId);
    listRef.current?.scrollToIndex(index);
  }, [reveal, visible, paperById, domains, loaded]);
  useEffect(() => {
    if (!flashId) return;
    const timer = window.setTimeout(() => setFlashId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  const label =
    selection.kind === "all"
      ? t.library.domains.all
      : selection.kind === "unfiled"
        ? t.library.domains.unfiled
        : domainById.has(selection.id)
          ? domainPath(domainById, selection.id)
          : "";

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-neutral-200" aria-label={t.library.paperList.ariaLabel}>
      <div className="flex items-center gap-2 pb-1 pl-4 pr-2 pt-2">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-500" title={label}>
          {label}
          <span className="ml-1.5 font-normal tabular-nums text-neutral-400">{t.library.paperList.count(visible.length)}</span>
        </h2>
        <TagFilterMenu />
        <SortMenu />
      </div>
      {tagFilter.length > 0 && <TagFilterBar tags={tagFilter} />}
      <PaperContextMenu currentDomain={currentDomain}>
        {(menuTargetId) => (
          <VirtualList
            role="listbox"
            aria-label={label}
            className="min-h-0 flex-1 overflow-y-auto"
            items={visible}
            rowHeight={paperRowHeight}
            getKey={getPaperKey}
            handleRef={listRef}
            renderItem={(p) => (
              <PaperRow
                paper={p}
                domainById={domainById}
                active={p.id === activePaperId}
                flash={p.id === flashId}
                menuOpen={p.id === menuTargetId}
              />
            )}
            footer={
              loaded &&
              visible.length === 0 && <EmptyState kind={selection.kind} libraryEmpty={papers.length === 0} tagFilter={tagFilter} />
            }
          />
        )}
      </PaperContextMenu>
    </section>
  );
}

const getPaperKey = (p: { id: string }) => p.id;

function EmptyState({ kind, libraryEmpty, tagFilter }: { kind: "all" | "unfiled" | "domain"; libraryEmpty: boolean; tagFilter: string[] }) {
  if (!libraryEmpty && tagFilter.length) {
    return (
      <div className="px-2.5 py-6 text-center text-xs leading-relaxed text-neutral-400">
        <p>{t.library.paperList.noTagged(tagFilter, kind !== "all")}</p>
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
  const text = libraryEmpty
    ? t.library.paperList.emptyLibrary
    : kind === "unfiled"
      ? t.library.paperList.allFiled
      : kind === "domain"
        ? t.library.paperList.emptyDomain
        : t.library.paperList.noPapers;
  return <p className="px-2.5 py-6 text-center text-xs leading-relaxed text-neutral-400">{text}</p>;
}

/** 列表上方正在使用的标签筛选：每个可单独去掉（可用 Tab 走到 ×） */
function TagFilterBar({ tags }: { tags: string[] }) {
  const st = useLibraryStore.getState;
  const ref = useRef<HTMLDivElement>(null);
  /** 用键盘去掉时，焦点移到原位置上的下一个按钮；筛选清空、筛选栏消失时移到筛选菜单按钮 */
  const keepFocus = (index: number) => {
    const bar = ref.current;
    if (!bar?.contains(document.activeElement)) return;
    requestAnimationFrame(() => {
      const next = ref.current?.querySelectorAll<HTMLElement>("button")[index];
      (next ?? document.querySelector<HTMLElement>("[data-tag-filter-trigger]"))?.focus();
    });
  };
  return (
    <div ref={ref} className="flex flex-wrap items-center gap-1 px-3 pb-1.5" role="group" aria-label={t.library.paperList.tagFilterBar}>
      {tags.map((tag, i) => (
        <RemovableTagChip
          key={tag}
          tag={tag}
          selected
          onRemove={() => {
            keepFocus(i);
            st().toggleTagFilter(tag);
          }}
          removeLabel={t.library.tags.unfilter(tag)}
        />
      ))}
      <button
        type="button"
        onClick={() => {
          keepFocus(Infinity);
          st().setTagFilter([]);
        }}
        className="rounded px-1 text-[11px] leading-5 text-neutral-400 outline-none hover:bg-neutral-200/70 hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        {t.library.paperList.clear}
      </button>
    </div>
  );
}

/** 按标签筛选：多选，论文须同时带有所选的全部标签 */
function TagFilterMenu() {
  const { tags } = useLibraryData();
  const filter = useLibraryStore((s) => s.tagFilter);
  const st = useLibraryStore.getState;
  const on = new Set(filter.map(tagKey));
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={filter.length ? t.library.paperList.filterByTagCount(filter.length) : t.library.paperList.filterByTag}
          title={t.library.paperList.filterByTag}
          data-tag-filter-trigger
          className={cx(
            "flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] hover:bg-neutral-200/70 hover:text-neutral-800 data-[state=open]:bg-neutral-200/70",
            filter.length ? "font-medium text-blue-700" : "text-neutral-500",
          )}
        >
          <IconTag width={13} height={13} />
          {filter.length ? <span className="tabular-nums">{filter.length}</span> : t.library.paperList.tagButton}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={cx(menuContent, "w-[232px]")}>
          <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] text-neutral-400">
            {t.library.paperList.filterByTag}
            {filter.length > 1 ? t.library.paperList.filterAllHint : ""}
          </DropdownMenu.Label>
          {tags.length === 0 ? (
            <p className="px-2 pb-1.5 text-[12px] leading-relaxed text-neutral-400">{t.library.tags.noTags}</p>
          ) : (
            <div className="max-h-[min(50vh,320px)] overflow-y-auto">
              {tags.map((tag) => (
                <DropdownMenu.CheckboxItem
                  key={tag.name}
                  checked={on.has(tag.name.toLocaleLowerCase())}
                  onCheckedChange={() => st().toggleTagFilter(tag.name)}
                  onSelect={(e) => e.preventDefault()} // 多选：点了不关菜单
                  className={cx(menuItem, "pr-2")}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    <DropdownMenu.ItemIndicator>
                      <IconCheck width={13} height={13} />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <TagDot tag={tag.name} />
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">{tag.count}</span>
                </DropdownMenu.CheckboxItem>
              ))}
            </div>
          )}
          <DropdownMenu.Separator className={menuSeparator} />
          <DropdownMenu.Item className={menuItem} disabled={!filter.length} onSelect={() => st().setTagFilter([])}>
            {t.library.paperList.clearTagFilter}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} onSelect={() => st().openDialog({ kind: "manageTags" })}>
            {t.library.paperList.manageTags}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SortMenu() {
  const sort = useLibraryStore((s) => s.sort);
  const setSort = useLibraryStore((s) => s.setSort);
  const current = sortLabel(SORT_OPTIONS.includes(sort) ? sort : SORT_OPTIONS[0]);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={t.library.paperList.sortLabel(current)}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-800 data-[state=open]:bg-neutral-200/70"
        >
          <IconSort width={13} height={13} />
          {current}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={cx(menuContent, "min-w-[132px]")}>
          <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] text-neutral-400">{t.library.paperList.sortHeading}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            {SORT_OPTIONS.map((o) => (
              <DropdownMenu.RadioItem key={o} value={o} className={cx(menuItem, "pr-6")}>
                <span className="flex w-3.5 justify-center">
                  <DropdownMenu.ItemIndicator>
                    <IconCheck width={13} height={13} />
                  </DropdownMenu.ItemIndicator>
                </span>
                {sortLabel(o)}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
