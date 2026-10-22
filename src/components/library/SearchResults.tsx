// 搜索结果：按提供者分组（论文 / 批注 / 术语…），论文组复用 PaperRow
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useLibraryData } from "./libraryData";
import { PaperContextMenu } from "./PaperContextMenu";
import { PaperRow, paperRowHeight } from "./PaperRow";
import { useActivePaperId } from "./PaperList";
import { getSearchProvider, runSearch, useSearchProviders, type SearchGroup, type SearchHit } from "./search";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return v;
}

export function SearchResults({ query }: { query: string }) {
  const providers = useSearchProviders();
  const q = useDebounced(query.trim(), 120);
  const groups = useLiveQuery(() => runSearch(q, providers), [q, providers]);
  const { domainById, paperById } = useLibraryData();
  const activePaperId = useActivePaperId();

  const total = groups?.reduce((n, g) => n + g.total, 0) ?? 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-neutral-200" aria-label={t.library.search.results}>
      <div className="px-4 pb-1 pt-2 text-xs font-medium text-neutral-500">
        {t.library.search.results}
        {groups && <span className="ml-1.5 font-normal tabular-nums text-neutral-400">{t.library.search.resultCount(total)}</span>}
      </div>
      <PaperContextMenu>
        {(menuTarget) => (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {groups && total === 0 && (
              <p className="px-2.5 py-6 text-center text-xs text-neutral-400">{t.library.search.noMatch(q)}</p>
            )}
            {groups
              ?.filter((g) => g.total > 0)
              .map((g) => (
                <div key={g.kind} className="mb-2" role="group" aria-label={g.label}>
                  <GroupHeader group={g} />
                  <div>
                    {g.hits.map((hit) => {
                      const paper = g.kind === "paper" ? paperById.get(hit.id) : undefined;
                      return paper ? (
                        <div key={hit.id} style={{ height: paperRowHeight(paper) }}>
                          <PaperRow
                            paper={paper}
                            domainById={domainById}
                            active={paper.id === activePaperId}
                            flash={false}
                            menuOpen={paper.id === menuTarget?.paperId}
                          />
                        </div>
                      ) : (
                        <GenericHit key={`${hit.kind}:${hit.id}`} hit={hit} />
                      );
                    })}
                  </div>
                </div>
              ))}
          </div>
        )}
      </PaperContextMenu>
    </section>
  );
}

function GroupHeader({ group }: { group: SearchGroup }) {
  return (
    <div className="sticky top-0 z-[1] flex items-center gap-1.5 bg-neutral-50 px-2.5 py-1 text-[11px] font-medium tracking-wide text-neutral-400">
      {group.label}
      <span className="tabular-nums">{group.total}</span>
      {group.total > group.hits.length && <span className="font-normal">{t.library.search.showingFirst(group.hits.length)}</span>}
    </div>
  );
}

/** 其他模块（批注、术语）的结果项 */
function GenericHit({ hit }: { hit: SearchHit }) {
  return (
    <button
      type="button"
      onClick={() => getSearchProvider(hit.kind)?.activate(hit)}
      className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-neutral-100"
    >
      <div className="line-clamp-2 text-[13px] leading-snug text-neutral-800">{hit.title}</div>
      {hit.subtitle && <div className="mt-0.5 truncate text-[11.5px] text-neutral-500">{hit.subtitle}</div>}
      {hit.snippet && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-neutral-400">{hit.snippet}</div>}
    </button>
  );
}
