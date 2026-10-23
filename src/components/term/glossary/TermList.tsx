// 术语表中栏：排序 + 虚拟列表（2000 条也只渲染可视区域）
import { memo, type KeyboardEvent, type Ref } from "react";
import { useGlossaryStore, type GlossarySort, type GlossarySortKey } from "@/app/stores/glossary";
import { useIndexerStore } from "@/app/stores/indexer";
import { VirtualList, type VirtualListHandle } from "@/components/library/VirtualList";
import { cx } from "@/components/library/ui";
import { htmlLang, t } from "@/i18n";
import type { Domain, Term } from "@/types/models";
import { CopyAcroButton, copyAcro } from "../acroActions";
import { aliasExcerpt, formatShortDate, scopeSummary, type TermStats } from "./model";

export const TERM_ROW_HEIGHT = 56;

const SORTS: readonly GlossarySortKey[] = ["name", "occurrences", "updated"];

interface Props {
  terms: Term[];
  totalTerms: number;
  stats: ReadonlyMap<string, TermStats> | undefined;
  domainById: ReadonlyMap<string, Domain>;
  selectedId: string | null;
  sort: GlossarySort;
  filtered: boolean;
  /** 术语 id → acro id（按全部术语分配） */
  acroIds: ReadonlyMap<string, string>;
  handleRef: Ref<VirtualListHandle>;
  onMove: (delta: number) => void;
}

export function TermList({ terms, totalTerms, stats, domainById, selectedId, sort, filtered, acroIds, handleRef, onMove }: Props) {
  const toggleSort = useGlossaryStore((s) => s.toggleSort);
  const select = useGlossaryStore((s) => s.select);
  // 索引进行中时，还没有统计的术语显示"…"而不是"未出现"
  const indexing = useIndexerStore((s) => s.running);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      onMove(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.code === "KeyC" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      // 列表获得焦点、没有选中文字时，⌘/Ctrl + C 复制当前术语的 acro 代码
      const term = terms.find((x) => x.id === selectedId);
      if (!term || !window.getSelection()?.isCollapsed) return;
      e.preventDefault();
      void copyAcro(term, acroIds.get(term.id)!);
    }
  };

  const tx = t.term.glossary.list;
  return (
    <section className="flex min-w-[300px] flex-1 flex-col" aria-label={tx.ariaLabel}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-100 px-3">
        <span className="text-xs tabular-nums text-neutral-500" data-testid="glossary-count">
          {filtered ? tx.countFiltered(terms.length, totalTerms) : tx.count(totalTerms)}
        </span>
        <div className="ml-auto flex items-center gap-0.5 rounded-md bg-neutral-100 p-0.5" role="group" aria-label={tx.sortGroup}>
          {SORTS.map((key) => {
            const active = sort.key === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                title={active ? tx.sortToggle : undefined}
                onClick={() => toggleSort(key)}
                className={cx(
                  "flex h-6 items-center gap-0.5 rounded px-2 text-[12px]",
                  active ? "bg-white font-medium text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800",
                )}
              >
                {tx.sorts[key]}
                {active && <span aria-label={sort.dir === "asc" ? tx.asc : tx.desc}>{sort.dir === "asc" ? "↑" : "↓"}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <VirtualList
        items={terms}
        rowHeight={TERM_ROW_HEIGHT}
        getKey={(x) => x.id}
        handleRef={handleRef}
        gutter={8}
        role="listbox"
        aria-label={tx.listLabel}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto pt-1 outline-none"
        renderItem={(x) => (
          <TermRow
            term={x}
            acroId={acroIds.get(x.id)!}
            stats={stats?.get(x.id)}
            statsReady={!!stats && !indexing}
            domainById={domainById}
            selected={x.id === selectedId}
            onSelect={select}
          />
        )}
        footer={
          terms.length === 0 && (
            <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-neutral-400">
              {totalTerms === 0 ? tx.empty : tx.noMatch}
            </p>
          )
        }
      />
    </section>
  );
}

interface RowProps {
  term: Term;
  acroId: string;
  stats: TermStats | undefined;
  statsReady: boolean;
  domainById: ReadonlyMap<string, Domain>;
  selected: boolean;
  onSelect: (id: string) => void;
}

const TermRow = memo(function TermRow({ term, acroId, stats, statsReady, domainById, selected, onSelect }: RowProps) {
  const scope = scopeSummary(term, domainById);
  const tx = t.term.glossary.list;
  return (
    <div
      role="option"
      aria-selected={selected}
      data-term-id={term.id}
      onClick={() => onSelect(term.id)}
      className={cx(
        "group flex h-[52px] cursor-default items-center gap-1.5 rounded-md pr-1.5 pl-3",
        selected ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : "hover:bg-neutral-50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cx("truncate text-[13.5px] font-medium", selected ? "text-blue-950" : "text-neutral-900")}>{term.name}</span>
          <ScopeChip scope={scope} />
          <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-neutral-500" title={tx.statsTitle}>
            {stats ? tx.stats(stats.papers, stats.count) : statsReady ? tx.notFound : "…"}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px]">
          <span className="truncate text-neutral-500">{aliasExcerpt(term.aliases) || <span className="text-neutral-300">{tx.noAliases}</span>}</span>
          <span className="ml-auto shrink-0 tabular-nums text-neutral-400" title={new Date(term.updatedAt).toLocaleString(htmlLang())}>
            {formatShortDate(term.updatedAt)}
          </span>
        </div>
      </div>
      {/* 悬停或选中时显示；位置一直占着，出现时不挤动旁边的数字 */}
      <CopyAcroButton
        term={term}
        acroId={acroId}
        title={t.term.acro.copyTitleWithKey}
        // 不进 Tab 顺序、不并入条目的读屏名称：键盘用 ⌘/Ctrl + C
        tabIndex={-1}
        aria-hidden
        className={cx("h-7 w-7 shrink-0 focus-visible:opacity-100", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100")}
      />
    </div>
  );
});

function ScopeChip({ scope }: { scope: ReturnType<typeof scopeSummary> }) {
  if (scope.kind === "global") return <span className="shrink-0 rounded bg-neutral-100 px-1.5 text-[10.5px] leading-4 text-neutral-500">{t.term.glossary.list.scopeGlobal}</span>;
  if (scope.kind === "none") return <span className="shrink-0 rounded bg-amber-50 px-1.5 text-[10.5px] leading-4 text-amber-700">{t.term.glossary.list.scopeNone}</span>;
  const [first, ...rest] = scope.tags;
  const name = first.path.split(" / ").pop();
  return (
    <span className="flex min-w-0 shrink items-center gap-1 rounded bg-neutral-100 px-1.5 text-[10.5px] leading-4 text-neutral-600" title={scope.tags.map((tag) => tag.path).join("\n")}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: first.color }} aria-hidden />
      <span className="truncate">{name}</span>
      {rest.length > 0 && <span className="shrink-0 text-neutral-400">+{rest.length}</span>}
    </span>
  );
}
