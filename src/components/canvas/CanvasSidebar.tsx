// 画布左侧面板："未整理"收件箱（不在任何画布上的批注和笔记）、搜索添加术语/批注/论文/笔记、新建自由笔记。
// 条目可直接拖到画布上，或点"+"放到视口中央。
import { useEffect, useMemo, useState, type DragEvent, type MutableRefObject, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useCanvasStore } from "@/app/stores/canvas";
import { HIGHLIGHT_COLORS, strongColor } from "@/components/annotation/colors";
import { jumpToAnnotation } from "@/components/annotation/actions";
import { db } from "@/db/schema";
import { buildDomainTree, flattenTree } from "@/services/domainTree";
import { ENTITY_KIND_LABELS, refKey, resolveEntities, searchEntities } from "@/services/linkService";
import type { Board, EntityRef } from "@/types/models";
import type { BoardBridge } from "./context";
import { REF_MIME, buildInbox, clip, encodeRef, placedRefKeys, plainExcerpt, resolveDomainFilter, type InboxItem } from "./model";
import { IconInbox, IconJump, IconNotePlus, IconPlus, IconSearch, IconX, cx, input } from "./ui";

const PAGE = 150;
const RECENT_TERMS = 30;

function startDrag(e: DragEvent, ref: EntityRef, title: string) {
  e.dataTransfer.setData(REF_MIME, encodeRef(ref));
  e.dataTransfer.setData("text/plain", title);
  e.dataTransfer.effectAllowed = "copy";
}

export function CanvasSidebar({ board, bridgeRef }: { board: Board; bridgeRef: MutableRefObject<BoardBridge | null> }) {
  const tab = useCanvasStore((s) => s.sidebarTab);
  const setTab = useCanvasStore((s) => s.setSidebarTab);
  return (
    <aside className="nokey flex w-72 shrink-0 flex-col border-r border-neutral-200 bg-white" aria-label="画布素材" data-canvas-sidebar>
      <div className="flex items-center gap-1 border-b border-neutral-100 px-2 py-2">
        <div role="tablist" className="flex flex-1 gap-0.5 rounded-lg bg-neutral-100 p-0.5">
          <TabButton active={tab === "inbox"} onClick={() => setTab("inbox")}>
            <IconInbox width={13} height={13} /> 未整理
          </TabButton>
          <TabButton active={tab === "search"} onClick={() => setTab("search")}>
            <IconSearch width={13} height={13} /> 搜索添加
          </TabButton>
        </div>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-2 text-[12px] text-neutral-700 hover:bg-neutral-50"
          title="在画布中央新建自由笔记（也可双击画布空白处）"
          onClick={() => bridgeRef.current?.newNoteAtCenter()}
          data-new-note
        >
          <IconNotePlus width={13} height={13} /> 笔记
        </button>
      </div>
      {tab === "inbox" ? <Inbox board={board} bridgeRef={bridgeRef} /> : <SearchPanel board={board} bridgeRef={bridgeRef} />}
    </aside>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        "flex h-6 flex-1 items-center justify-center gap-1 rounded-md text-[12px]",
        active ? "bg-white font-medium text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800",
      )}
    >
      {children}
    </button>
  );
}

// ---------- 未整理 ----------

function Inbox({ board, bridgeRef }: { board: Board; bridgeRef: MutableRefObject<BoardBridge | null> }) {
  const filter = useCanvasStore((s) => s.inboxFilter);
  const setFilter = useCanvasStore((s) => s.setInboxFilter);
  const scope = useCanvasStore((s) => s.inboxScope);
  const setScope = useCanvasStore((s) => s.setInboxScope);
  // 放在任意画布上的实体只取 ref.id 索引键（拖动节点改位置时这个查询很便宜）
  const placedIds = useLiveQuery(() => db.boardNodes.orderBy("ref.id").uniqueKeys(), []);
  const onBoard = useLiveQuery(async () => placedRefKeys(await db.boardNodes.where("boardId").equals(board.id).toArray()), [board.id]);
  const data = useLiveQuery(async () => {
    const [annotations, notes, papers, domains] = await Promise.all([db.annotations.toArray(), db.notes.toArray(), db.papers.toArray(), db.domains.toArray()]);
    return { annotations, notes, papers, domains };
  }, []);
  const [limit, setLimit] = useState(PAGE);

  const paperMap = useMemo(() => new Map((data?.papers ?? []).map((p) => [p.id, p])), [data?.papers]);
  const domainOptions = useMemo(() => flattenTree(buildDomainTree(data?.domains ?? [])), [data?.domains]);
  // id 是全局唯一的 nanoid，按 id 判断即可（不区分 kind）
  const placedAnywhere = useMemo(() => new Set((placedIds ?? []).flatMap((id) => [`annotation:${String(id)}`, `note:${String(id)}`])), [placedIds]);
  const placed = scope === "board" ? onBoard : placedAnywhere;
  const { items, hiddenNotes } = useMemo(() => {
    if (!data || !placed) return { items: [], hiddenNotes: 0 };
    const domainIds = resolveDomainFilter(filter.domain, board.domainIds, data.domains);
    return buildInbox({ annotations: data.annotations, notes: data.notes, placed, papers: paperMap }, { paperId: filter.paperId, domainIds, color: filter.color });
  }, [data, placed, paperMap, filter, board.domainIds]);
  // 收件箱里的论文选项：有批注的论文
  const paperOptions = useMemo(() => {
    const ids = new Set((data?.annotations ?? []).map((a) => a.paperId));
    return [...ids].flatMap((id) => (paperMap.get(id) ? [paperMap.get(id)!] : [])).sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }, [data?.annotations, paperMap]);

  if (!data || !placedIds || !onBoard) return <div className="flex-1" />;
  const boardHasDomains = board.domainIds.length > 0;
  const filtered = !!filter.paperId || !!filter.color || (filter.domain !== null && (filter.domain !== "board" || boardHasDomains));

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-inbox>
      <div className="space-y-1.5 border-b border-neutral-100 px-2 py-2">
        <div role="radiogroup" aria-label="收件箱范围" className="flex gap-0.5 rounded-md bg-neutral-100 p-0.5 text-[11.5px]">
          {(
            [
              ["anywhere", "不在任何画布上"],
              ["board", "不在本画布上"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={scope === v}
              className={cx("h-6 flex-1 rounded", scope === v ? "bg-white font-medium text-neutral-800 shadow-sm" : "text-neutral-500 hover:text-neutral-800")}
              onClick={() => setScope(v)}
              data-inbox-scope={v}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          className={cx(input, "h-7 pr-6 text-[12px]")}
          value={filter.domain === "board" && !boardHasDomains ? "" : (filter.domain ?? "")}
          onChange={(e) => setFilter({ domain: e.target.value || null })}
          aria-label="按领域筛选"
          data-inbox-domain
        >
          <option value="">全部领域</option>
          {boardHasDomains && <option value="board">本画布关联的领域</option>}
          {domainOptions.map((n) => (
            <option key={n.domain.id} value={n.domain.id}>
              {"　".repeat(n.depth)}
              {n.domain.name}
            </option>
          ))}
        </select>
        <select
          className={cx(input, "h-7 pr-6 text-[12px]")}
          value={filter.paperId ?? ""}
          onChange={(e) => setFilter({ paperId: e.target.value || null })}
          aria-label="按论文筛选"
          data-inbox-paper
        >
          <option value="">全部论文</option>
          {paperOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {clip(p.title, 48)}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-0.5" role="group" aria-label="按颜色筛选">
          {HIGHLIGHT_COLORS.map((c) => {
            const on = filter.color === c.value;
            return (
              <button
                key={c.value}
                type="button"
                aria-pressed={on}
                aria-label={c.label}
                title={c.label}
                data-inbox-color={c.value}
                className={cx("flex h-6 w-6 items-center justify-center rounded", on ? "bg-neutral-100" : "hover:bg-neutral-50")}
                onClick={() => setFilter({ color: on ? null : c.value })}
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
          <span className="flex-1" />
          {filtered && (
            <button
              type="button"
              className="inline-flex h-6 items-center gap-0.5 rounded px-1 text-[11.5px] text-neutral-500 hover:bg-neutral-100"
              onClick={() => setFilter({ paperId: null, color: null, domain: null })}
            >
              <IconX width={12} height={12} /> 清除
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center px-3 pb-1 pt-2 text-[11px] text-neutral-400">
        <span className="flex-1" data-inbox-count>
          {items.length} 条{scope === "board" ? "不在本画布上" : "未整理"}
        </span>
        <span>拖到画布上</span>
      </div>
      {hiddenNotes > 0 && (
        <div className="px-3 pb-1 text-[11px] text-amber-700" data-hidden-notes={hiddenNotes}>
          另有 {hiddenNotes} 条自由笔记被论文/颜色筛选隐藏
        </div>
      )}
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-3" data-inbox-list>
        {items.slice(0, limit).map((it) => (
          <InboxRow key={refKey(it.ref)} item={it} bridgeRef={bridgeRef} />
        ))}
        {items.length > limit && (
          <li>
            <button type="button" className="w-full rounded-md py-1.5 text-[12px] text-blue-700 hover:bg-blue-50" onClick={() => setLimit((l) => l + PAGE)}>
              再显示 {Math.min(PAGE, items.length - limit)} 条（共 {items.length} 条）
            </button>
          </li>
        )}
        {!items.length && (
          <li className="px-2 py-6 text-center text-[12px] leading-relaxed text-neutral-400">
            {filtered
              ? "没有符合条件的条目"
              : scope === "board"
                ? "这块画布已包含所有批注和笔记。"
                : "所有批注都已放到画布上。阅读时新建的批注会自动出现在这里；整理另一块画布时可切换到「不在本画布上」。"}
          </li>
        )}
      </ul>
    </div>
  );
}

function InboxRow({ item, bridgeRef }: { item: InboxItem; bridgeRef: MutableRefObject<BoardBridge | null> }) {
  const title = "annotation" in item ? item.annotation.quote.exact : plainExcerpt(item.note.text, 60);
  return (
    <li
      draggable
      onDragStart={(e) => startDrag(e, item.ref, title)}
      className="group relative cursor-grab overflow-hidden rounded-md border border-neutral-200 bg-white py-1.5 pl-3 pr-7 text-[12px] hover:border-neutral-300 hover:shadow-sm active:cursor-grabbing"
      data-inbox-item={refKey(item.ref)}
    >
      {"annotation" in item ? (
        <>
          <span className="absolute inset-y-0 left-0 w-1" style={{ background: strongColor(item.annotation.color, 12) }} />
          <div className="line-clamp-2 leading-snug text-neutral-700">{clip(item.annotation.quote.exact || "（无原文）", 160)}</div>
          {item.annotation.note.trim() && <div className="mt-0.5 truncate text-[11.5px] text-neutral-500">✎ {plainExcerpt(item.annotation.note, 80)}</div>}
          <div className="mt-0.5 truncate text-[10.5px] text-neutral-400" title={item.paperTitle}>
            {item.paperTitle} · 第 {item.annotation.page} 页
          </div>
        </>
      ) : (
        <>
          <span className="absolute inset-y-0 left-0 w-1 bg-yellow-300" />
          <div className="line-clamp-2 leading-snug text-neutral-700">{plainExcerpt(item.note.text, 160) || "（空笔记）"}</div>
          <div className="mt-0.5 text-[10.5px] text-neutral-400">自由笔记 · 不在任何画布上</div>
        </>
      )}
      <div className="absolute right-1 top-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100">
        <button
          type="button"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          title="放到画布中央"
          aria-label="放到画布"
          onClick={() => bridgeRef.current?.placeAtCenter(item.ref)}
        >
          <IconPlus width={13} height={13} />
        </button>
        {"annotation" in item && (
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
            title="跳到原文"
            aria-label="跳到原文"
            onClick={() => jumpToAnnotation(item.annotation)}
          >
            <IconJump width={12} height={12} />
          </button>
        )}
      </div>
    </li>
  );
}

// ---------- 搜索添加 ----------

function SearchPanel({ board, bridgeRef }: { board: Board; bridgeRef: MutableRefObject<BoardBridge | null> }) {
  const q = useCanvasStore((s) => s.searchQuery);
  const setQ = useCanvasStore((s) => s.setSearchQuery);
  const onBoard = useLiveQuery(async () => placedRefKeys(await db.boardNodes.where("boardId").equals(board.id).toArray()), [board.id]);
  // 输入停顿后再查；结果是实时查询，条目在别处被修改或删除时随之更新
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 150);
    return () => clearTimeout(t);
  }, [q]);
  const results = useLiveQuery(async () => {
    if (!debounced.trim()) {
      // 空搜索时列出最近修改的术语，方便直接浏览、拖入
      const terms = (await db.terms.toArray()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_TERMS);
      const resolved = await resolveEntities(terms.map((t) => ({ kind: "term" as const, id: t.id })));
      return { query: "", rows: terms.map((t) => resolved.get(`term:${t.id}`)!) };
    }
    return { query: debounced, rows: await searchEntities(debounced, { limit: 8 }) };
  }, [debounced]);

  const groups = useMemo(() => {
    const order = ["term", "annotation", "paper", "note"] as const;
    return order.map((k) => ({ kind: k, rows: (results?.rows ?? []).filter((r) => r.ref.kind === k) })).filter((g) => g.rows.length);
  }, [results]);
  const browsing = !results?.query;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-canvas-search>
      <div className="relative border-b border-neutral-100 px-2 py-2">
        <IconSearch width={13} height={13} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400" />
        <input
          className={cx(input, "h-7 pl-7 text-[12.5px]")}
          placeholder="搜索术语、批注、论文、笔记…"
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQ("");
          }}
          aria-label="搜索要添加的条目"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {browsing && (
          <div className="px-1 pt-2 text-[11.5px] leading-relaxed text-neutral-400">输入关键词，把术语、批注、整篇论文或已有笔记拖到画布上。</div>
        )}
        {browsing && results && !results.rows.length && <div className="px-2 py-4 text-center text-[12px] text-neutral-400">还没有术语</div>}
        {!browsing && results && !results.rows.length && <div className="px-2 py-6 text-center text-[12px] text-neutral-400">没有匹配的条目</div>}
        {groups.map((g) => (
          <section key={g.kind} className="mt-2" data-search-group={g.kind}>
            <div className="mb-1 px-1 text-[11px] font-medium text-neutral-400">{browsing ? "最近的术语" : ENTITY_KIND_LABELS[g.kind]}</div>
            <ul className="space-y-1">
              {g.rows.map((r) => {
                const here = onBoard?.has(refKey(r.ref)) ?? false;
                return (
                  <li
                    key={refKey(r.ref)}
                    draggable
                    onDragStart={(e) => startDrag(e, r.ref, r.title)}
                    className="group relative cursor-grab rounded-md border border-neutral-200 bg-white py-1.5 pl-2.5 pr-8 text-[12px] hover:border-neutral-300 hover:shadow-sm"
                    data-search-result={refKey(r.ref)}
                  >
                    <div className="truncate font-medium text-neutral-800" title={r.title}>
                      {r.title}
                    </div>
                    {(r.subtitle || r.excerpt) && <div className="truncate text-[11px] text-neutral-400">{[r.subtitle, r.excerpt].filter(Boolean).join(" · ")}</div>}
                    {here ? (
                      <button
                        type="button"
                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[10.5px] text-blue-600 hover:bg-blue-50"
                        title="已在这块画布上，点击定位"
                        onClick={() => bridgeRef.current?.focusRef(r.ref)}
                      >
                        定位
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                        title="放到画布中央"
                        aria-label="放到画布"
                        onClick={() => bridgeRef.current?.placeAtCenter(r.ref)}
                      >
                        <IconPlus width={13} height={13} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
