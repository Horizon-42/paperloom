// 全部论文（平铺列表）：可按标签筛选（同时带有所选标签）、排序；行比领域树里的详细（作者、领域、标签）
import { t } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { filterPapersByTags } from "@/lib/tags";
import { useLibraryData } from "./libraryData";
import { PaperContextMenu } from "./PaperContextMenu";
import { PaperRow, paperRowHeight } from "./PaperRow";
import { sortPapers } from "./paperQuery";
import { VirtualList, type VirtualListHandle } from "./VirtualList";

/** 焦点分栏里正在显示的论文 */
export function useActivePaperId(): string | null {
  return useReaderStore((s) => s.panes.find((p) => p.id === s.focusedPane)?.activePaperId ?? null);
}

export function PaperList() {
  const { papers, paperById, domainById, loaded } = useLibraryData();
  const sort = useLibraryStore((s) => s.sort);
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const reveal = useLibraryStore((s) => s.reveal);
  const activePaperId = useActivePaperId();

  const visible = useMemo(() => sortPapers(filterPapersByTags(papers, tagFilter), sort), [papers, tagFilter, sort]);

  // 定位请求：论文被标签筛选挡住时清除筛选，然后滚动到它并闪烁
  const listRef = useRef<VirtualListHandle>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!reveal || !loaded) return;
    const paper = paperById.get(reveal.paperId);
    if (!paper) return; // 等实时查询带回新论文
    const index = visible.findIndex((p) => p.id === reveal.paperId);
    const st = useLibraryStore.getState();
    if (index < 0) {
      if (st.tagFilter.length) st.setTagFilter([]);
      else st.clearReveal(); // 不应发生；避免反复重试
      return;
    }
    st.clearReveal();
    setFlashId(reveal.paperId);
    listRef.current?.scrollToIndex(index);
  }, [reveal, visible, paperById, loaded]);
  useEffect(() => {
    if (!flashId) return;
    const timer = window.setTimeout(() => setFlashId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={t.library.paperList.ariaLabel}>
      <PaperContextMenu>
        {(menuTarget) => (
          <VirtualList
            role="listbox"
            aria-label={t.library.domains.all}
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
                menuOpen={p.id === menuTarget?.paperId}
              />
            )}
            footer={loaded && visible.length === 0 && <EmptyState libraryEmpty={papers.length === 0} tagFilter={tagFilter} />}
          />
        )}
      </PaperContextMenu>
    </section>
  );
}

const getPaperKey = (p: { id: string }) => p.id;

function EmptyState({ libraryEmpty, tagFilter }: { libraryEmpty: boolean; tagFilter: string[] }) {
  if (!libraryEmpty && tagFilter.length) {
    return (
      <div className="px-2.5 py-6 text-center text-xs leading-relaxed text-neutral-400">
        <p>{t.library.paperList.noTagged(tagFilter)}</p>
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
  return (
    <p className="px-2.5 py-6 text-center text-xs leading-relaxed text-neutral-400">
      {libraryEmpty ? t.library.paperList.emptyLibrary : t.library.paperList.noPapers}
    </p>
  );
}
