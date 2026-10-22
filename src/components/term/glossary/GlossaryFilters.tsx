// 术语表左栏：搜索框 + 筛选（全部 / 全局 / 无作用范围 / 领域树）
import { useMemo, type ReactNode } from "react";
import { useGlossaryStore, type GlossaryFilter } from "@/app/stores/glossary";
import { IconChevronRight, IconSearch, IconX } from "@/components/library/icons";
import { cx } from "@/components/library/ui";
import { buildDomainTree, flattenTree } from "@/services/domainTree";
import type { Domain } from "@/types/models";
import type { FilterCounts } from "./model";

const INDENT = 14;

const sameFilter = (a: GlossaryFilter, b: GlossaryFilter) =>
  a.kind === b.kind && (a.kind !== "domain" || (b.kind === "domain" && a.id === b.id));

export function GlossaryFilters({ domains, counts, filter }: { domains: Domain[]; counts: FilterCounts; filter: GlossaryFilter }) {
  const setFilter = useGlossaryStore((s) => s.setFilter);
  const expanded = useGlossaryStore((s) => s.expanded);
  const toggleExpanded = useGlossaryStore((s) => s.toggleExpanded);
  const tree = useMemo(() => buildDomainTree(domains), [domains]);
  const rows = useMemo(() => flattenTree(tree, (id) => !!expanded[id]), [tree, expanded]);

  const item = (f: GlossaryFilter, label: ReactNode, count: number, extra?: { title?: string; muted?: boolean }) => {
    const selected = sameFilter(filter, f);
    return (
      <button
        type="button"
        aria-pressed={selected}
        title={extra?.title}
        onClick={() => setFilter(f)}
        className={cx(
          "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]",
          selected ? "bg-blue-50 font-medium text-blue-900" : extra?.muted ? "text-neutral-500 hover:bg-neutral-100" : "text-neutral-700 hover:bg-neutral-100",
        )}
      >
        <span className="flex-1 truncate">{label}</span>
        <span className="text-[11px] tabular-nums text-neutral-400">{count}</span>
      </button>
    );
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/70" aria-label="术语筛选">
      <div className="p-3 pb-2">
        <SearchBox />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="按作用范围筛选">
        <div className="space-y-px">
          {item({ kind: "all" }, "全部术语", counts.all)}
          {item({ kind: "global" }, "全局", counts.global)}
          {item({ kind: "unscoped" }, "无作用范围", counts.unscoped, {
            title: "限定了领域，但领域列表为空或领域已删除，不在任何论文中生效",
            muted: true,
          })}
        </div>
        <div className="mb-1 mt-3 px-2 text-[11px] font-medium tracking-wide text-neutral-400">领域</div>
        {rows.length === 0 && <p className="px-2 text-xs leading-relaxed text-neutral-400">还没有领域。在左侧文库中新建领域后，可以把术语限定在领域内。</p>}
        <div className="space-y-px" role="tree" aria-label="领域">
          {rows.map((node) => {
            const d = node.domain;
            const f: GlossaryFilter = { kind: "domain", id: d.id };
            const selected = sameFilter(filter, f);
            const hasKids = node.children.length > 0;
            const open = !!expanded[d.id];
            return (
              <div
                key={d.id}
                role="treeitem"
                aria-selected={selected}
                aria-expanded={hasKids ? open : undefined}
                className={cx(
                  "group flex h-7 items-center rounded-md pr-2 text-[13px]",
                  selected ? "bg-blue-50 font-medium text-blue-900" : "text-neutral-700 hover:bg-neutral-100",
                )}
                style={{ paddingLeft: 2 + node.depth * INDENT }}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={open ? "折叠" : "展开"}
                  onClick={() => hasKids && toggleExpanded(d.id)}
                  className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400", hasKids ? "hover:text-neutral-700" : "invisible")}
                >
                  <IconChevronRight width={13} height={13} className={cx("transition-transform", open && "rotate-90")} />
                </button>
                <button type="button" onClick={() => setFilter(f)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.color }} aria-hidden />
                  <span className="flex-1 truncate">{d.name}</span>
                  <span className="text-[11px] tabular-nums text-neutral-400">{counts.byDomain.get(d.id) ?? 0}</span>
                </button>
              </div>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}

function SearchBox() {
  const query = useGlossaryStore((s) => s.query);
  const setQuery = useGlossaryStore((s) => s.setQuery);
  return (
    <div className="relative">
      <IconSearch width={14} height={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
        }}
        placeholder="搜索名称、别名、笔记"
        aria-label="搜索术语"
        className="h-8 w-full rounded-md border border-neutral-200 bg-white pl-8 pr-7 text-[13px] placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          aria-label="清除术语搜索"
          onClick={() => setQuery("")}
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
        >
          <IconX width={12} height={12} />
        </button>
      )}
    </div>
  );
}
