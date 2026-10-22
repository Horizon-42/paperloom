// 术语表中栏：排序 + 虚拟列表（2000 条也只渲染可视区域）
import { memo, type KeyboardEvent, type Ref } from "react";
import { useGlossaryStore, type GlossarySort, type GlossarySortKey } from "@/app/stores/glossary";
import { useIndexerStore } from "@/app/stores/indexer";
import { VirtualList, type VirtualListHandle } from "@/components/library/VirtualList";
import { cx } from "@/components/library/ui";
import type { Domain, Term } from "@/types/models";
import { aliasExcerpt, formatShortDate, scopeSummary, type TermStats } from "./model";

export const TERM_ROW_HEIGHT = 56;

const SORTS: { key: GlossarySortKey; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "occurrences", label: "出现次数" },
  { key: "updated", label: "修改时间" },
];

interface Props {
  terms: Term[];
  totalTerms: number;
  stats: ReadonlyMap<string, TermStats> | undefined;
  domainById: ReadonlyMap<string, Domain>;
  selectedId: string | null;
  sort: GlossarySort;
  filtered: boolean;
  handleRef: Ref<VirtualListHandle>;
  onMove: (delta: number) => void;
}

export function TermList({ terms, totalTerms, stats, domainById, selectedId, sort, filtered, handleRef, onMove }: Props) {
  const toggleSort = useGlossaryStore((s) => s.toggleSort);
  const select = useGlossaryStore((s) => s.select);
  // 索引进行中时，还没有统计的术语显示"…"而不是"未出现"
  const indexing = useIndexerStore((s) => s.running);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      onMove(e.key === "ArrowDown" ? 1 : -1);
    }
  };

  return (
    <section className="flex min-w-[300px] flex-1 flex-col" aria-label="术语">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-100 px-3">
        <span className="text-xs tabular-nums text-neutral-500" data-testid="glossary-count">
          {filtered ? `${terms.length} / ${totalTerms} 个术语` : `${totalTerms} 个术语`}
        </span>
        <div className="ml-auto flex items-center gap-0.5 rounded-md bg-neutral-100 p-0.5" role="group" aria-label="排序">
          {SORTS.map(({ key, label }) => {
            const active = sort.key === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                title={active ? "再次点击切换升序 / 降序" : undefined}
                onClick={() => toggleSort(key)}
                className={cx(
                  "flex h-6 items-center gap-0.5 rounded px-2 text-[12px]",
                  active ? "bg-white font-medium text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800",
                )}
              >
                {label}
                {active && <span aria-label={sort.dir === "asc" ? "升序" : "降序"}>{sort.dir === "asc" ? "↑" : "↓"}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <VirtualList
        items={terms}
        rowHeight={TERM_ROW_HEIGHT}
        getKey={(t) => t.id}
        handleRef={handleRef}
        gutter={8}
        role="listbox"
        aria-label="术语列表"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto pt-1 outline-none"
        renderItem={(t) => (
          <TermRow term={t} stats={stats?.get(t.id)} statsReady={!!stats && !indexing} domainById={domainById} selected={t.id === selectedId} onSelect={select} />
        )}
        footer={
          terms.length === 0 && (
            <p className="px-6 py-10 text-center text-[13px] leading-relaxed text-neutral-400">
              {totalTerms === 0 ? "还没有术语。点击右上角「新建术语」，或在阅读时选中文字设为术语。" : "没有符合条件的术语"}
            </p>
          )
        }
      />
    </section>
  );
}

interface RowProps {
  term: Term;
  stats: TermStats | undefined;
  statsReady: boolean;
  domainById: ReadonlyMap<string, Domain>;
  selected: boolean;
  onSelect: (id: string) => void;
}

const TermRow = memo(function TermRow({ term, stats, statsReady, domainById, selected, onSelect }: RowProps) {
  const scope = scopeSummary(term, domainById);
  return (
    <div
      role="option"
      aria-selected={selected}
      data-term-id={term.id}
      onClick={() => onSelect(term.id)}
      className={cx(
        "flex h-[52px] cursor-default flex-col justify-center rounded-md px-3",
        selected ? "bg-blue-50 ring-1 ring-inset ring-blue-200" : "hover:bg-neutral-50",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cx("truncate text-[13.5px] font-medium", selected ? "text-blue-950" : "text-neutral-900")}>{term.name}</span>
        <ScopeChip scope={scope} />
        <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-neutral-500" title="出现的论文数 · 总次数">
          {stats ? `${stats.papers} 篇 · ${stats.count} 次` : statsReady ? "未出现" : "…"}
        </span>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px]">
        <span className="truncate text-neutral-500">{aliasExcerpt(term.aliases) || <span className="text-neutral-300">无别名</span>}</span>
        <span className="ml-auto shrink-0 tabular-nums text-neutral-400" title={new Date(term.updatedAt).toLocaleString("zh-CN")}>
          {formatShortDate(term.updatedAt)}
        </span>
      </div>
    </div>
  );
});

function ScopeChip({ scope }: { scope: ReturnType<typeof scopeSummary> }) {
  if (scope.kind === "global") return <span className="shrink-0 rounded bg-neutral-100 px-1.5 text-[10.5px] leading-4 text-neutral-500">全局</span>;
  if (scope.kind === "none") return <span className="shrink-0 rounded bg-amber-50 px-1.5 text-[10.5px] leading-4 text-amber-700">未生效</span>;
  const [first, ...rest] = scope.tags;
  const name = first.path.split(" / ").pop();
  return (
    <span className="flex min-w-0 shrink items-center gap-1 rounded bg-neutral-100 px-1.5 text-[10.5px] leading-4 text-neutral-600" title={scope.tags.map((t) => t.path).join("\n")}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: first.color }} aria-hidden />
      <span className="truncate">{name}</span>
      {rest.length > 0 && <span className="shrink-0 text-neutral-400">+{rest.length}</span>}
    </span>
  );
}
