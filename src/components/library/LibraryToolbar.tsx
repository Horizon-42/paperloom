// 侧栏论文区的工具栏：视图切换（按领域 / 全部）、排序、按标签筛选、新建领域；下方是正在使用的标签筛选
import { t } from "@/i18n";
import { useMemo, useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useLibraryStore, type LibraryView } from "@/app/stores/library";
import { filterPapersByTags, tagKey } from "@/lib/tags";
import { requestAllCitations } from "./citationController";
import { createAndRename } from "./DomainTree";
import { IconCheck, IconPlus, IconSort, IconTag } from "./icons";
import { useLibraryData } from "./libraryData";
import { SORT_OPTIONS, sortLabel } from "./paperQuery";
import { RemovableTagChip, TagDot } from "./TagChips";
import { cx, iconBtn, menuContent, menuItem, menuSeparator } from "./ui";

export function LibraryToolbar() {
  const view = useLibraryStore((s) => s.view);
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const { papers } = useLibraryData();
  // 按标签筛选时显示"匹配数/总数"
  const matched = useMemo(() => (tagFilter.length ? filterPapersByTags(papers, tagFilter).length : null), [papers, tagFilter]);
  return (
    <div className="flex items-center gap-1 border-t border-neutral-200 pb-1 pl-3 pr-2 pt-2">
      <ViewSwitch view={view} count={matched === null ? String(papers.length) : `${matched}/${papers.length}`} />
      <div className="flex-1" />
      <SortMenu />
      <TagFilterMenu />
      {view === "tree" && (
        <button type="button" className={iconBtn} title={t.library.domains.newDomain} aria-label={t.library.domains.newDomain} onClick={() => void createAndRename(null)}>
          <IconPlus width={14} height={14} />
        </button>
      )}
    </div>
  );
}

function ViewSwitch({ view, count }: { view: LibraryView; count: string }) {
  const setView = useLibraryStore((s) => s.setView);
  const item = (v: LibraryView, label: string, extra?: string) => (
    <button
      type="button"
      aria-pressed={view === v}
      data-library-view={v}
      onClick={() => setView(v)}
      className={cx(
        "h-6 whitespace-nowrap rounded px-2 text-[12px] transition-colors",
        view === v ? "bg-white font-medium text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800",
      )}
    >
      {label}
      {extra && <span className="ml-1 tabular-nums text-neutral-400">{extra}</span>}
    </button>
  );
  return (
    <div role="group" aria-label={t.library.tree.viewLabel} className="flex shrink-0 items-center gap-px rounded-md bg-neutral-200/70 p-0.5">
      {item("tree", t.library.tree.byField)}
      {item("all", t.library.tree.all, count)}
    </div>
  );
}

/** 列表上方正在使用的标签筛选：每个可单独去掉（可用 Tab 走到 ×） */
export function TagFilterBar({ tags }: { tags: string[] }) {
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
          <IconTag width={14} height={14} />
          {filter.length > 0 && <span className="tabular-nums">{filter.length}</span>}
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
          title={t.library.paperList.sortLabel(current)}
          className="flex h-6 items-center rounded px-1.5 text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-800 data-[state=open]:bg-neutral-200/70"
        >
          <IconSort width={14} height={14} />
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
          <DropdownMenu.Separator className={menuSeparator} />
          <DropdownMenu.Item className={cx(menuItem, "pl-[30px]")} title={t.library.citations.queryAllTitle} onSelect={() => void requestAllCitations()} data-query-all-citations>
            {t.library.citations.queryAll}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={cx(menuItem, "pl-[30px] text-neutral-500")}
            onSelect={() => useLibraryStore.getState().openDialog({ kind: "citationConsent", paperIds: [] })}
          >
            {t.library.citations.settings}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
