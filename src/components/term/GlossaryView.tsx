// 术语表视图（F3.5）：左栏筛选与搜索，中栏术语列表，右栏详情与出现位置
import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useGlossaryStore, type GlossaryFilter } from "@/app/stores/glossary";
import { useTermUiStore } from "@/app/stores/termUi";
import { IconPlus } from "@/components/library/icons";
import { btnPrimary, cx } from "@/components/library/ui";
import type { VirtualListHandle } from "@/components/library/VirtualList";
import { db } from "@/db/schema";
import { listDomains } from "@/db/repo/domains";
import { t } from "@/i18n";
import type { Domain, Term } from "@/types/models";
import { GlossaryFilters } from "./glossary/GlossaryFilters";
import { IndexerStatus } from "./glossary/IndexerStatus";
import { TermDetail } from "./glossary/TermDetail";
import { TermList } from "./glossary/TermList";
import { countByFilter, filterTerms, makeFilterContext, sortTerms, tokenize } from "./glossary/model";
import { useOccurrenceStats } from "./glossary/useOccurrenceStats";

const listTerms = () => db.terms.toArray();
const EMPTY_TERMS: Term[] = [];
const EMPTY_DOMAINS: Domain[] = [];

export function GlossaryView() {
  const terms = useLiveQuery(listTerms, []) ?? EMPTY_TERMS;
  const domains = useLiveQuery(listDomains, []) ?? EMPTY_DOMAINS;
  const stats = useOccurrenceStats();

  const storedFilter = useGlossaryStore((s) => s.filter);
  const query = useGlossaryStore((s) => s.query);
  const sort = useGlossaryStore((s) => s.sort);
  const selectedId = useGlossaryStore((s) => s.selectedTermId);
  const reveal = useGlossaryStore((s) => s.reveal);

  const domainById = useMemo(() => new Map(domains.map((d) => [d.id, d])), [domains]);
  // 筛选的领域被删除时退回"全部"
  const filter = useMemo<GlossaryFilter>(
    () => (storedFilter.kind === "domain" && !domainById.has(storedFilter.id) ? { kind: "all" } : storedFilter),
    [storedFilter, domainById],
  );

  const deferredQuery = useDeferredValue(query);
  const tokens = useMemo(() => tokenize(deferredQuery), [deferredQuery]);
  const ctx = useMemo(() => makeFilterContext(domains), [domains]);
  const filtered = useMemo(() => filterTerms(terms, filter, tokens, ctx), [terms, filter, tokens, ctx]);
  // 出现次数排序时统计变化才需要重排
  const sortStats = sort.key === "occurrences" ? stats : undefined;
  const sorted = useMemo(() => sortTerms(filtered, sort, sortStats), [filtered, sort, sortStats]);
  const counts = useMemo(() => countByFilter(terms, domains), [terms, domains]);
  const selected = useMemo(() => (selectedId ? terms.find((x) => x.id === selectedId) : undefined), [terms, selectedId]);

  const listRef = useRef<VirtualListHandle>(null);

  // 搜索结果激活：术语被当前筛选隐藏时清除筛选，然后滚动到它
  useEffect(() => {
    if (!reveal || !terms.length) return;
    const store = useGlossaryStore.getState();
    if (!terms.some((x) => x.id === reveal.termId)) {
      store.clearReveal();
      return;
    }
    if (!filtered.some((x) => x.id === reveal.termId)) {
      if (filter.kind !== "all") store.setFilter({ kind: "all" });
      if (query) store.setQuery("");
      if (filter.kind !== "all" || query) return; // 等筛选更新后再定位
    }
    const idx = sorted.findIndex((x) => x.id === reveal.termId);
    if (idx >= 0) {
      listRef.current?.scrollToIndex(idx);
      store.clearReveal();
    }
  }, [reveal, terms, filtered, sorted, filter.kind, query]);

  const move = useCallback(
    (delta: number) => {
      if (!sorted.length) return;
      const cur = sorted.findIndex((x) => x.id === selectedId);
      const next = cur < 0 ? (delta > 0 ? 0 : sorted.length - 1) : Math.max(0, Math.min(sorted.length - 1, cur + delta));
      useGlossaryStore.getState().select(sorted[next].id);
      listRef.current?.scrollToIndex(next);
    },
    [sorted, selectedId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white" data-testid="glossary">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-neutral-200 px-4">
        <h1 className="text-[15px] font-semibold text-neutral-900">{t.term.glossary.title}</h1>
        <div className="ml-auto">
          <IndexerStatus />
        </div>
        <button type="button" className={cx(btnPrimary, "h-8")} onClick={() => useTermUiStore.getState().openTermEditor({})}>
          <IconPlus width={14} height={14} />
          {t.term.glossary.newTerm}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <GlossaryFilters domains={domains} counts={counts} filter={filter} />
        <TermList
          terms={sorted}
          totalTerms={terms.length}
          stats={stats}
          domainById={domainById}
          selectedId={selectedId}
          sort={sort}
          filtered={filter.kind !== "all" || tokens.length > 0}
          handleRef={listRef}
          onMove={move}
        />
        <TermDetail term={selected} domains={domains} domainById={domainById} />
      </div>
    </div>
  );
}
