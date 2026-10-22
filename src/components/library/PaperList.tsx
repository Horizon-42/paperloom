// 论文列表：显示当前选中（全部 / 未分类 / 领域含子领域）下的论文，可按标签筛选（同时带有所选标签）、排序
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
import { SORT_OPTIONS, filterPapersBySelection, sortPapers } from "./paperQuery";
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
    const t = window.setTimeout(() => setFlashId(null), 1800);
    return () => window.clearTimeout(t);
  }, [flashId]);

  const label =
    selection.kind === "all"
      ? "全部论文"
      : selection.kind === "unfiled"
        ? "未分类"
        : domainById.has(selection.id)
          ? domainPath(domainById, selection.id)
          : "";

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-neutral-200" aria-label="论文列表">
      <div className="flex items-center gap-2 pb-1 pl-4 pr-2 pt-2">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-500" title={label}>
          {label}
          <span className="ml-1.5 font-normal tabular-nums text-neutral-400">{visible.length} 篇</span>
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
    const what = tagFilter.length === 1 ? `带「${tagFilter[0]}」标签的论文` : "同时带有这些标签的论文";
    return (
      <div className="px-2.5 py-6 text-center text-xs leading-relaxed text-neutral-400">
        <p>{kind === "all" ? `没有${what}。` : `当前视图中没有${what}。`}</p>
        <button
          type="button"
          onClick={() => useLibraryStore.getState().setTagFilter([])}
          className="mt-1.5 rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-50"
        >
          清除标签筛选
        </button>
      </div>
    );
  }
  const text = libraryEmpty
    ? "文库是空的。点击上方「导入」选择 PDF，或直接把 PDF 拖进窗口。"
    : kind === "unfiled"
      ? "所有论文都已归类。"
      : kind === "domain"
        ? "这个领域还没有论文。把列表里的论文拖到左侧领域上即可归类。"
        : "没有论文。";
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
    <div ref={ref} className="flex flex-wrap items-center gap-1 px-3 pb-1.5" role="group" aria-label="标签筛选">
      {tags.map((t, i) => (
        <RemovableTagChip
          key={t}
          tag={t}
          selected
          onRemove={() => {
            keepFocus(i);
            st().toggleTagFilter(t);
          }}
          removeLabel={`取消按「${t}」筛选`}
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
        清除
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
          aria-label={filter.length ? `按标签筛选（已选 ${filter.length} 个）` : "按标签筛选"}
          title="按标签筛选"
          data-tag-filter-trigger
          className={cx(
            "flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] hover:bg-neutral-200/70 hover:text-neutral-800 data-[state=open]:bg-neutral-200/70",
            filter.length ? "font-medium text-blue-700" : "text-neutral-500",
          )}
        >
          <IconTag width={13} height={13} />
          {filter.length ? <span className="tabular-nums">{filter.length}</span> : "标签"}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={cx(menuContent, "w-[232px]")}>
          <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] text-neutral-400">
            按标签筛选{filter.length > 1 ? "（同时带有所选标签）" : ""}
          </DropdownMenu.Label>
          {tags.length === 0 ? (
            <p className="px-2 pb-1.5 text-[12px] leading-relaxed text-neutral-400">还没有标签。在论文上按 T，或右键选择「标签…」添加。</p>
          ) : (
            <div className="max-h-[min(50vh,320px)] overflow-y-auto">
              {tags.map((t) => (
                <DropdownMenu.CheckboxItem
                  key={t.name}
                  checked={on.has(t.name.toLocaleLowerCase())}
                  onCheckedChange={() => st().toggleTagFilter(t.name)}
                  onSelect={(e) => e.preventDefault()} // 多选：点了不关菜单
                  className={cx(menuItem, "pr-2")}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">
                    <DropdownMenu.ItemIndicator>
                      <IconCheck width={13} height={13} />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <TagDot tag={t.name} />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">{t.count}</span>
                </DropdownMenu.CheckboxItem>
              ))}
            </div>
          )}
          <DropdownMenu.Separator className={menuSeparator} />
          <DropdownMenu.Item className={menuItem} disabled={!filter.length} onSelect={() => st().setTagFilter([])}>
            清除标签筛选
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} onSelect={() => st().openDialog({ kind: "manageTags" })}>
            管理标签…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SortMenu() {
  const sort = useLibraryStore((s) => s.sort);
  const setSort = useLibraryStore((s) => s.setSort);
  const current = SORT_OPTIONS.find((o) => o.value === sort) ?? SORT_OPTIONS[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`排序：${current.label}`}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-800 data-[state=open]:bg-neutral-200/70"
        >
          <IconSort width={13} height={13} />
          {current.label}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={cx(menuContent, "min-w-[132px]")}>
          <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] text-neutral-400">排序方式</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            {SORT_OPTIONS.map((o) => (
              <DropdownMenu.RadioItem key={o.value} value={o.value} className={cx(menuItem, "pr-6")}>
                <span className="flex w-3.5 justify-center">
                  <DropdownMenu.ItemIndicator>
                    <IconCheck width={13} height={13} />
                  </DropdownMenu.ItemIndicator>
                </span>
                {o.label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
