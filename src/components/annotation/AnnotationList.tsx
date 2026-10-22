// 批注列表（F2.3）：按论文分组，可按领域（含子领域）、颜色、关键词筛选；点击跳转到原文。
// "未定位"（换文件后找不到原文）的批注单独成组，可删除。
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listAllAnnotations, listAnnotationsByPapers } from "@/db/repo/annotations";
import { listDomains } from "@/db/repo/domains";
import { listPapers } from "@/db/repo/papers";
import { buildDomainTree, flattenTree, getSubtreeIds } from "@/services/domainTree";
import type { Annotation, Paper } from "@/types/models";
import { IconSearch, IconX } from "@/components/library/icons";
import { cx, input } from "@/components/library/ui";
import { deleteWithUndo, jumpToAnnotation } from "./actions";
import { HIGHLIGHT_COLORS, strongColor } from "./colors";
import { IconAlert, IconTrash } from "./icons";
import { buildListModel, plainExcerpt, type ListModel } from "./listModel";

type Row =
  | { kind: "orphan-header"; count: number }
  | { kind: "header"; paperId: string; title: string; count: number }
  | { kind: "item"; a: Annotation; orphan: boolean; paperTitle?: string };

const HEADER_H = 36;
const ORPHAN_HEADER_H = 54;
const ITEM_H = 72;
const rowHeight = (r: Row) => (r.kind === "item" ? ITEM_H : r.kind === "header" ? HEADER_H : ORPHAN_HEADER_H);

function toRows(model: ListModel): Row[] {
  const rows: Row[] = [];
  if (model.orphaned.length) {
    rows.push({ kind: "orphan-header", count: model.orphaned.length });
    for (const a of model.orphaned) rows.push({ kind: "item", a, orphan: true });
  }
  for (const g of model.groups) {
    rows.push({ kind: "header", paperId: g.paperId, title: g.title, count: g.items.length });
    for (const a of g.items) rows.push({ kind: "item", a, orphan: false });
  }
  return rows;
}

export function AnnotationList() {
  const domains = useLiveQuery(listDomains, []);
  const papers = useLiveQuery(listPapers, []);
  const [domainId, setDomainId] = useState<string>("");
  const [colors, setColors] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");

  const domainOptions = useMemo(() => flattenTree(buildDomainTree(domains ?? [])), [domains]);
  const paperById = useMemo(() => new Map((papers ?? []).map((p) => [p.id, p])), [papers]);

  // 领域筛选：先算出领域子树内的论文，再按 paperId 查批注；不限领域时取全部
  const domainPaperIds = useMemo(() => {
    if (!domainId || !domains || !papers) return null;
    const sub = new Set(getSubtreeIds(domains, domainId));
    return papers.filter((p) => p.domainIds.some((d) => sub.has(d))).map((p) => p.id);
  }, [domainId, domains, papers]);
  const idsKey = domainPaperIds?.join("|") ?? "*";
  const anns = useLiveQuery(
    () => (domainPaperIds ? listAnnotationsByPapers(domainPaperIds) : listAllAnnotations()),
    // domainPaperIds 由 idsKey 概括
    [idsKey],
  );

  const tokens = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const model = useMemo(
    () =>
      buildListModel(anns ?? [], (id) => paperById.get(id)?.title, {
        paperIds: domainPaperIds ? new Set(domainPaperIds) : null,
        colors,
        tokens,
      }),
    [anns, paperById, domainPaperIds, colors, tokens],
  );
  const rows = useMemo(() => toRows(model), [model]);
  const loading = anns === undefined || papers === undefined;
  const filtered = !!domainId || colors.size > 0 || tokens.length > 0;

  const toggleColor = (c: string) =>
    setColors((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white" data-annotation-list>
      <header className="border-b border-neutral-200 px-6 pb-3 pt-4">
        <div className="mb-3 flex items-baseline gap-2">
          <h1 className="text-lg font-semibold text-neutral-900">批注</h1>
          {!loading && <span className="text-[13px] tabular-nums text-neutral-400">{model.total} 条</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={domainId}
            onChange={(e) => setDomainId(e.target.value)}
            className={cx(input, "w-auto max-w-[240px] pr-7")}
            aria-label="按领域筛选"
            data-filter-domain
          >
            <option value="">全部领域</option>
            {domainOptions.map((n) => (
              <option key={n.domain.id} value={n.domain.id}>
                {"　".repeat(n.depth)}
                {n.domain.name}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-0.5 rounded-md border border-neutral-200 px-1 py-0.5" role="group" aria-label="按颜色筛选">
            {HIGHLIGHT_COLORS.map((c) => {
              const on = colors.has(c.value);
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-pressed={on}
                  aria-label={c.label}
                  title={c.label}
                  data-filter-color={c.value}
                  className={cx("flex h-6 w-6 items-center justify-center rounded", on ? "bg-neutral-100" : "hover:bg-neutral-50")}
                  onClick={() => toggleColor(c.value)}
                >
                  <span
                    className="h-3.5 w-3.5 rounded-full border"
                    style={{
                      background: c.value,
                      borderColor: strongColor(c.value, 25),
                      boxShadow: on ? `0 0 0 2px white, 0 0 0 3.5px ${strongColor(c.value, 40)}` : undefined,
                    }}
                  />
                </button>
              );
            })}
          </div>
          <div className="relative min-w-[200px] flex-1">
            <IconSearch className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400" width={14} height={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索原文或笔记"
              className={cx(input, "pl-7")}
              aria-label="搜索原文或笔记"
              data-filter-query
            />
          </div>
          {filtered && (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12.5px] text-neutral-500 hover:bg-neutral-100"
              onClick={() => {
                setDomainId("");
                setColors(new Set());
                setQuery("");
              }}
            >
              <IconX width={13} height={13} /> 清除筛选
            </button>
          )}
        </div>
      </header>
      {loading ? null : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
          {filtered ? "没有符合条件的批注" : "还没有批注。在论文中选中文字即可高亮和写笔记。"}
        </div>
      ) : (
        <RowList rows={rows} paperById={paperById} />
      )}
    </div>
  );
}

/** 行高已知的虚拟列表：只渲染可视区域附近的行 */
function RowList({ rows, paperById }: { rows: Row[]; paperById: Map<string, Paper> }) {
  const el = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 800 });
  const offsets = useMemo(() => {
    const o = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) o[i + 1] = o[i] + rowHeight(rows[i]);
    return o;
  }, [rows]);
  useLayoutEffect(() => {
    const node = el.current!;
    const measure = () => setScroll({ top: node.scrollTop, height: node.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const OVERSCAN = 400;
  const lo = scroll.top - OVERSCAN;
  const hi = scroll.top + scroll.height + OVERSCAN;
  // 二分找第一个底边在 lo 之下的行
  let a = 0;
  let b = rows.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (offsets[m + 1] <= lo) a = m + 1;
    else b = m;
  }
  const out: ReactNode[] = [];
  for (let i = a; i < rows.length && offsets[i] < hi; i++) {
    const r = rows[i];
    const key = r.kind === "item" ? `i:${r.a.id}` : r.kind === "header" ? `h:${r.paperId}` : "orphan";
    out.push(
      <div key={key} className="absolute inset-x-0 px-4" style={{ top: offsets[i], height: rowHeight(r) }}>
        {r.kind === "orphan-header" ? (
          <OrphanHeader count={r.count} />
        ) : r.kind === "header" ? (
          <PaperHeader title={r.title} count={r.count} />
        ) : (
          <ItemRow a={r.a} orphan={r.orphan} paperTitle={r.orphan ? paperById.get(r.a.paperId)?.title : undefined} />
        )}
      </div>,
    );
  }
  return (
    <div
      ref={el}
      className="relative min-h-0 flex-1 overflow-y-auto"
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
    >
      <div className="relative mx-auto max-w-3xl" style={{ height: offsets[rows.length] + 16 }}>
        {out}
      </div>
    </div>
  );
}

function OrphanHeader({ count }: { count: number }) {
  return (
    <div className="flex h-full flex-col justify-end pb-1.5" data-orphan-header>
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-700">
        <IconAlert /> 未定位 <span className="font-normal tabular-nums text-amber-600/80">{count}</span>
      </div>
      <div className="text-[11.5px] text-neutral-500">替换 PDF 文件后，这些批注的原文在新文件中找不到了。可以删除，或在原文中重新划线后删除旧批注。</div>
    </div>
  );
}

function PaperHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex h-full items-end gap-2 border-b border-neutral-100 pb-1.5" data-paper-header>
      <span className="truncate text-[13px] font-semibold text-neutral-800" title={title}>
        {title}
      </span>
      <span className="shrink-0 text-[12px] tabular-nums text-neutral-400">{count}</span>
    </div>
  );
}

function ItemRow({ a, orphan, paperTitle }: { a: Annotation; orphan: boolean; paperTitle?: string }) {
  const note = a.note.trim() ? plainExcerpt(a.note) : "";
  return (
    <div
      role="button"
      tabIndex={0}
      className="group relative mt-1 flex h-[64px] cursor-pointer gap-2.5 rounded-md py-1.5 pl-2 pr-2 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-blue-500"
      data-annotation-item={a.id}
      onClick={() => jumpToAnnotation(a)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          jumpToAnnotation(a);
        }
      }}
    >
      <span className="w-[3px] shrink-0 rounded-full" style={{ background: strongColor(a.color, 15) }} />
      <div className="min-w-0 flex-1">
        <div className={cx("line-clamp-2 text-[13px] leading-snug", orphan ? "text-neutral-500" : "text-neutral-800")}>
          <span style={{ background: `color-mix(in srgb, ${a.color}, transparent 35%)` }} className="box-decoration-clone">
            {a.quote.exact}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-neutral-500">
          {orphan && paperTitle && <span className="text-neutral-400">{paperTitle} · </span>}
          {note || <span className="text-neutral-300">无笔记</span>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end justify-between">
        <span className="text-[11.5px] tabular-nums text-neutral-400">第 {a.page} 页</span>
        <button
          type="button"
          className={cx(
            "inline-flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-600",
            !orphan && "opacity-0 focus:opacity-100 group-hover:opacity-100",
          )}
          aria-label="删除批注"
          title="删除批注"
          onClick={(e) => {
            e.stopPropagation();
            void deleteWithUndo(a.id);
          }}
        >
          <IconTrash />
        </button>
      </div>
    </div>
  );
}
