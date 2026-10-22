// 术语弹窗（F3.3、开发文档 5.4）：锚定在下划线上的 Radix Popover（虚拟锚点）。
// 悬停 400 ms 为只读预览；点击为可编辑：规范名与别名、多候选切换、笔记、本文内 ↑/↓ 导航、
// 出现在哪些论文、首次定义处、相关笔记。锚点每帧按页面当前位置重算，滚动、缩放时跟随；
// 锚点滚出可视区时隐藏，所在页面离开渲染范围、切换标签或视图时关闭。
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useLiveQuery } from "dexie-react-hooks";
import { useAppStore } from "@/app/stores/app";
import { useReaderStore } from "@/app/stores/reader";
import { useTermUiStore, type TermAnchor, type TermPopoverState } from "@/app/stores/termUi";
import { MarkdownEditor } from "@/components/common/MarkdownEditor";
import { MarkdownView } from "@/components/common/MarkdownView";
import { db } from "@/db/schema";
import { getOutdatedPaperIds, listOccurrencesForTerm } from "@/db/repo/occurrences";
import { getTerm, getTerms } from "@/db/repo/terms";
import { pdfRectToScreen } from "@/lib/coords";
import { updateTerm } from "@/services/termService";
import type { Domain, Term, TermScope } from "@/types/models";
import { goToOccurrence, openPaperAtTerm, popoverPointer } from "./interaction";
import { groupOccurrences, navigationOrigin, occurrenceIndexOf, stepOccurrence } from "./logic/occurrences";
import { useTermPositions, type PositionsState } from "./paperIndex";
import { getPageEntry, rangeRects, toClientRect } from "./pages";
import { RelatedLinks } from "./RelatedLinks";
import { IconBack, IconDown, IconPencil, IconUp, IconX, chip, cx, iconBtn, linkBtn, sectionTitle } from "./ui";

export function TermPopover() {
  const pop = useTermUiStore((s) => s.popover);
  const close = useTermUiStore((s) => s.closePopover);
  const view = useAppStore((s) => s.view);
  const paneId = pop?.anchor.paneId;
  const activeInPane = useReaderStore((s) => (paneId ? (s.panes.find((p) => p.id === paneId)?.activePaperId ?? null) : null));
  // 切到其他视图、该分栏换了标签或分栏被关闭时收起
  useEffect(() => {
    if (pop && (view !== "reader" || activeInPane !== pop.anchor.paperId)) close();
  }, [pop, view, activeInPane, close]);
  if (!pop) return null;
  return <PopoverShell key={pop.seq} pop={pop} />;
}

/**
 * 虚拟锚点：每次被问到位置时按页面当前的 viewport 重算（锚点所在页未挂载时沿用上次的位置）。
 * Floating UI 每帧都会问一次，顺便判断锚点是否滚出了阅读器可视区（onDetached）。
 * 不用 Radix 的 hideWhenDetached：它给外层加 visibility: hidden，卡片里的焦点会掉到 body。
 */
function virtualAnchor(ref: RefObject<TermAnchor>, onDetached: (detached: boolean) => void) {
  let last = new DOMRect(-10000, -10000, 0, 0);
  const entry = () => {
    const a = ref.current!;
    return getPageEntry(a.paneId, a.paperId, a.page);
  };
  return {
    getBoundingClientRect(): DOMRect {
      const a = ref.current!;
      const e = entry();
      if (!e?.ctx.text) return last;
      const rects = rangeRects(e.ctx, a.start, a.end);
      const r = rects[Math.min(a.seg, rects.length - 1)];
      if (r) last = toClientRect(e.ctx.pageEl, pdfRectToScreen(e.ctx.viewport, r));
      const box = e.ctx.scrollEl.getBoundingClientRect();
      onDetached(last.bottom <= box.top || last.top >= box.bottom || last.right <= box.left || last.left >= box.right);
      return last;
    },
    // Floating UI 用它找滚动祖先（滚出可视区时隐藏）
    get contextElement() {
      return entry()?.ctx.pageEl;
    },
  };
}

function PopoverShell({ pop }: { pop: TermPopoverState }) {
  const anchorRef = useRef(pop.anchor);
  anchorRef.current = pop.anchor;
  const contentRef = useRef<HTMLDivElement>(null);
  const virtualRef = useMemo(
    () => ({
      current: virtualAnchor(anchorRef, (detached) => {
        const el = contentRef.current;
        if (el && el.hasAttribute("data-detached") !== detached) el.toggleAttribute("data-detached", detached);
      }),
    }),
    [],
  );
  const navigating = useTermUiStore((s) => !!s.flash?.movePopover);
  const navRef = useRef<((dir: 1 | -1) => void) | null>(null);
  const edit = pop.mode === "edit";
  const st = useTermUiStore.getState;

  useEffect(() => {
    if (edit) contentRef.current?.focus({ preventScroll: true });
  }, [edit]);

  // 兜底：导航结束后焦点若在 body 上（如导航途中焦点所在的元素被移除），拉回卡片；用户已把焦点移到别处时不动
  const wasNavigating = useRef(false);
  useEffect(() => {
    if (navigating) {
      wasNavigating.current = true;
      return;
    }
    if (!wasNavigating.current || !edit) return;
    wasNavigating.current = false;
    const until = performance.now() + 1000;
    let raf = 0;
    const refocus = () => {
      const el = contentRef.current;
      const active = document.activeElement;
      if (!el || (active && active !== document.body)) return;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el && performance.now() < until) raf = requestAnimationFrame(refocus);
    };
    raf = requestAnimationFrame(refocus);
    return () => cancelAnimationFrame(raf);
  }, [navigating, edit]);

  // 兜底：焦点在 body 上时 ↑/↓ 仍用于导航，而不是滚动阅读器
  useEffect(() => {
    if (!edit) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      e.preventDefault();
      navRef.current?.(e.key === "ArrowDown" ? 1 : -1);
      contentRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edit]);

  return (
    <Popover.Root open onOpenChange={(o) => !o && st().closePopover()}>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          updatePositionStrategy="always"
          tabIndex={-1}
          data-term-popover={pop.mode}
          aria-label="术语"
          className={cx(
            "z-40 flex max-h-[min(72vh,var(--radix-popover-content-available-height))] w-[360px] max-w-[calc(100vw-16px)] flex-col overflow-y-auto",
            "rounded-xl border border-neutral-200 bg-white text-[13px] text-neutral-700 shadow-xl shadow-neutral-900/10 outline-none",
            // 导航途中、锚点滚出可视区时用透明而不是 visibility: hidden，保留焦点
            "data-[detached]:pointer-events-none data-[detached]:opacity-0",
            navigating && "pointer-events-none opacity-0",
          )}
          onOpenAutoFocus={(e) => {
            // 不聚焦第一个按钮；可编辑时聚焦卡片本身，以便 ↑/↓、Esc 直接生效
            e.preventDefault();
            if (pop.mode === "edit") contentRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            // 笔记编辑器、输入框里的 Esc 交给它们自己（取消编辑、清空搜索）
            if ((e.target as HTMLElement | null)?.closest?.(".cm-editor, input, textarea")) e.preventDefault();
          }}
          onPointerEnter={() => popoverPointer(true)}
          onPointerLeave={() => popoverPointer(false)}
          onPointerDownCapture={() => {
            if (!edit) st().setPopoverMode("edit");
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            if ((e.target as HTMLElement).closest(".cm-editor, input, textarea, select")) return;
            e.preventDefault();
            navRef.current?.(e.key === "ArrowDown" ? 1 : -1);
          }}
        >
          <TermCard pop={pop} navRef={navRef} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function useDomains(): Domain[] | undefined {
  return useLiveQuery(() => db.domains.toArray(), []);
}

function scopeText(scope: TermScope, domains: Domain[] | undefined): string {
  if (scope.kind !== "domains") return "全局";
  if (!scope.domainIds.length) return "未指定领域（不生效）";
  const byId = new Map((domains ?? []).map((d) => [d.id, d.name]));
  return scope.domainIds.map((id) => byId.get(id) ?? "已删除的领域").join("、");
}

type NavFn = (dir: 1 | -1) => void;

function TermCard({ pop, navRef }: { pop: TermPopoverState; navRef: MutableRefObject<NavFn | null> }) {
  const { activeTermId, termIds, anchor, mode } = pop;
  const edit = mode === "edit";
  const st = useTermUiStore.getState;
  const candidates = useLiveQuery(() => getTerms(termIds), [termIds.join("|")]);
  const term = useLiveQuery(() => getTerm(activeTermId).then((t) => t ?? null), [activeTermId]);
  const domains = useDomains();
  // 通过"相关笔记"切到其他术语后可以返回
  const [history, setHistory] = useState<string[]>([]);
  const openTerm = (id: string) => {
    if (id === activeTermId) return;
    setHistory((h) => [...h, activeTermId]);
    st().setActiveTerm(id);
  };

  // 术语被删除：切到剩下的候选，没有就关闭
  useEffect(() => {
    if (term !== null || !candidates) return;
    const rest = candidates.filter((t) => t.id !== activeTermId);
    if (rest.length) st().setActiveTerm(rest[0].id);
    else st().closePopover();
  }, [term, candidates, activeTermId, st]);

  // 只在可编辑时统计本文出现位置：悬停预览不应触发全文提取
  const positions = useTermPositions(anchor.paperId, activeTermId, edit);
  navRef.current = (dir) => {
    if (positions.status !== "ready") return;
    // 上一次跨页导航还没落定时，从它的目标继续走，连按不丢步
    const from = navigationOrigin(anchor, st().flash);
    const i = stepOccurrence(positions.list, from, dir);
    if (i >= 0) goToOccurrence(anchor.paneId, anchor.paperId, activeTermId, positions.list[i], true);
  };

  if (!term) return <div className="p-3 text-neutral-400">{term === null ? "术语已删除" : "加载中…"}</div>;
  const shownCandidates = (candidates ?? []).filter((t) => termIds.includes(t.id));

  return (
    <div className="flex flex-col" data-term-card={term.id}>
      <header className="flex items-start gap-1.5 px-3 pt-3 pb-2">
        {history.length > 0 && (
          <button
            type="button"
            className={cx(iconBtn, "mt-0.5 h-5 w-5")}
            title="返回"
            aria-label="返回"
            onClick={() => {
              const prev = history[history.length - 1];
              setHistory((h) => h.slice(0, -1));
              st().setActiveTerm(prev);
            }}
          >
            <IconBack />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[15px] leading-snug font-semibold break-words text-neutral-900" data-term-name>
            {term.name}
          </div>
          {term.aliases.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1" data-term-aliases>
              {term.aliases.map((a) => (
                <span key={a} className={chip}>
                  {a}
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 text-[11px] text-neutral-400">作用范围：{scopeText(term.scope, domains)}</div>
        </div>
        {edit && (
          <>
            <button
              type="button"
              className={cx(iconBtn, "h-6 w-6")}
              title="编辑术语"
              aria-label="编辑术语"
              data-term-edit
              onClick={() => st().openTermEditor({ termId: term.id })}
            >
              <IconPencil />
            </button>
            <button type="button" className={cx(iconBtn, "h-6 w-6")} title="关闭（Esc）" aria-label="关闭" onClick={() => st().closePopover()}>
              <IconX width={14} height={14} />
            </button>
          </>
        )}
      </header>

      {shownCandidates.length > 1 && (
        <div className="mx-3 mb-2 rounded-md border border-amber-200 bg-amber-50/70 p-1" data-term-candidates>
          <div className="px-1.5 pb-0.5 text-[11px] text-amber-700">此处同时匹配 {shownCandidates.length} 个术语</div>
          {shownCandidates.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === activeTermId}
              data-candidate={t.id}
              className={cx(
                "flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left text-[12px]",
                t.id === activeTermId ? "bg-white font-medium text-neutral-900 shadow-sm" : "text-neutral-600 hover:bg-white/70",
              )}
              onClick={() => {
                setHistory([]);
                st().setActiveTerm(t.id);
              }}
            >
              <span className="min-w-0 truncate">{t.name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-neutral-400">{scopeText(t.scope, domains)}</span>
            </button>
          ))}
        </div>
      )}

      {edit && <NavRow positions={positions} anchor={anchor} onNav={(d) => navRef.current?.(d)} />}

      <NoteSection key={term.id} term={term} editable={edit} />

      <PaperOccurrences term={term} anchor={anchor} positions={positions} compact={!edit} />

      {edit && term.sourceAnnotationId && <SourceLink annotationId={term.sourceAnnotationId} />}

      {edit ? (
        <RelatedLinks self={{ kind: "term", id: term.id }} editable onOpenTerm={openTerm} />
      ) : (
        <div className="border-t border-neutral-100 px-3 py-1.5 text-[11px] text-neutral-400">点击下划线查看详情、编辑笔记</div>
      )}
    </div>
  );
}

function NavRow({ positions, anchor, onNav }: { positions: PositionsState; anchor: TermAnchor; onNav: (dir: 1 | -1) => void }) {
  let label = "正在统计本文出现位置…";
  let n = 0;
  if (positions.status === "error") label = "无法读取全文";
  else if (positions.status === "ready") {
    n = positions.list.length;
    const i = occurrenceIndexOf(positions.list, anchor);
    label = n === 0 ? "本文中没有其他出现" : i >= 0 ? `本文第 ${i + 1} / ${n} 处` : `本文共 ${n} 处`;
  }
  return (
    <div className="mx-3 mb-2 flex items-center gap-1 rounded-md bg-neutral-50 px-2 py-1 text-[12px] text-neutral-500" data-term-nav>
      <span className="flex-1 tabular-nums" data-term-nav-label>
        {label}
      </span>
      <button type="button" className={cx(iconBtn, "h-5 w-5")} title="上一处（↑）" aria-label="上一处" disabled={!n} onClick={() => onNav(-1)}>
        <IconUp />
      </button>
      <button type="button" className={cx(iconBtn, "h-5 w-5")} title="下一处（↓）" aria-label="下一处" disabled={!n} onClick={() => onNav(1)}>
        <IconDown />
      </button>
    </div>
  );
}

/** 笔记：点击切换到编辑器，⌘/Ctrl+Enter 或失焦保存，Esc 放弃；弹窗关闭时未保存的修改也会保存 */
function NoteSection({ term, editable }: { term: Term; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(term.note);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const savedRef = useRef(term.note);
  if (!editing) savedRef.current = term.note;

  const save = async () => {
    const text = draftRef.current;
    setEditing(false);
    if (text !== savedRef.current) {
      savedRef.current = text;
      await updateTerm(term.id, { note: text });
    }
  };
  useEffect(
    () => () => {
      if (editingRef.current && draftRef.current !== savedRef.current) void updateTerm(term.id, { note: draftRef.current });
    },
    [term.id],
  );

  if (editing) {
    return (
      <div
        className="px-3 pb-2"
        data-term-note-editor
        onBlur={(e) => {
          // 延后判断：编辑器重建（如开发模式 StrictMode 重挂载）时会短暂失焦再聚焦
          const box = e.currentTarget;
          setTimeout(() => {
            if (editingRef.current && box.isConnected && !box.contains(document.activeElement)) void save();
          });
        }}
      >
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          onSubmit={() => void save()}
          onCancel={() => {
            setDraft(term.note);
            setEditing(false);
          }}
          placeholder="写下你对这个术语的理解（Markdown，支持 $公式$）"
          autoFocus
        />
        <div className="mt-1 text-[11px] text-neutral-400">⌘/Ctrl + Enter 保存 · Esc 取消</div>
      </div>
    );
  }
  return (
    <div
      className={cx("px-3 pb-2", editable && "cursor-text")}
      data-term-note
      onClick={(e) => {
        if (!editable || (e.target as HTMLElement).closest("a")) return;
        setDraft(term.note);
        setEditing(true);
      }}
    >
      <MarkdownView
        source={term.note}
        className={cx("text-[13px] leading-relaxed", !editable && "line-clamp-6")}
        emptyText={editable ? "点击添加笔记…" : "（还没有笔记）"}
      />
    </div>
  );
}

function PaperOccurrences({ term, anchor, positions, compact }: { term: Term; anchor: TermAnchor; positions: PositionsState; compact: boolean }) {
  const groups = useLiveQuery(async () => {
    // 含旧规则版本的记录：过渡期间照常显示，标为"待更新"，避免列表变空
    const occ = await listOccurrencesForTerm(term.id);
    const ids = [...new Set(occ.map((o) => o.paperId))];
    const [papers, domains, outdated] = await Promise.all([db.papers.bulkGet(ids), db.domains.toArray(), getOutdatedPaperIds(ids)]);
    return groupOccurrences(occ, new Map(papers.filter((p) => !!p).map((p) => [p!.id, p!])), domains, outdated);
  }, [term.id]);
  if (!groups) return null;
  const paperCount = new Set(groups.flatMap((g) => g.papers.map((p) => p.paperId))).size;
  if (compact) {
    return paperCount ? <div className="px-3 pb-2 text-[12px] text-neutral-500">出现在 {paperCount} 篇论文中</div> : null;
  }

  const open = (paperId: string, page: number) => {
    // 本文：跳到第一处，弹窗跟过去；其他论文：打开并闪烁第一处
    if (paperId === anchor.paperId && positions.status === "ready" && positions.list.length) {
      goToOccurrence(anchor.paneId, paperId, term.id, positions.list[0], true);
    } else {
      useTermUiStore.getState().closePopover();
      openPaperAtTerm(paperId, page, term.id);
    }
  };
  return (
    <section className="border-t border-neutral-100 px-3 py-2" data-term-papers>
      <div className={sectionTitle}>出现在{paperCount ? ` ${paperCount} 篇论文` : ""}</div>
      {!groups.length && <div className="text-[12px] text-neutral-400">暂无记录（后台索引完成后显示）</div>}
      <div className="flex flex-col gap-1.5">
        {groups.map((g) => (
          <div key={g.domainId ?? "-"}>
            <div className="truncate text-[11px] text-neutral-400">{g.label}</div>
            <ul>
              {g.papers.map((p) => (
                <li key={p.paperId} className="flex items-baseline gap-2">
                  <button
                    type="button"
                    className={cx(linkBtn, "min-w-0 flex-1 text-[13px]")}
                    title={`${p.title}（第 ${p.firstPage} 页起）`}
                    onClick={() => open(p.paperId, p.firstPage)}
                    data-occ-paper={p.paperId}
                  >
                    {p.title}
                    {p.paperId === anchor.paperId && <span className="ml-1 text-[11px] text-neutral-400">（本文）</span>}
                  </button>
                  {p.outdated && (
                    <span
                      className="shrink-0 rounded bg-neutral-100 px-1 text-[10px] text-neutral-400"
                      title="匹配规则已更新，次数和页码会在后台重新扫描后刷新"
                      data-occ-outdated
                    >
                      待更新
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] text-neutral-400 tabular-nums">×{p.count}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceLink({ annotationId }: { annotationId: string }) {
  const info = useLiveQuery(async () => {
    const a = await db.annotations.get(annotationId);
    if (!a) return null;
    const p = await db.papers.get(a.paperId);
    return { a, title: p?.title ?? "未知论文" };
  }, [annotationId]);
  if (!info) return null;
  const { a, title } = info;
  const r = a.rects[0];
  return (
    <section className="border-t border-neutral-100 px-3 py-2" data-term-source>
      <div className={sectionTitle}>首次定义处</div>
      <button
        type="button"
        className={cx(linkBtn, "block max-w-full text-[13px]")}
        onClick={() => {
          useTermUiStore.getState().closePopover();
          useReaderStore.getState().jumpTo({ paperId: a.paperId, page: a.page, pdfPoint: r ? [r[0], r[3]] : undefined, annotationId: a.id });
        }}
      >
        {title} · 第 {a.page} 页
      </button>
      {a.quote.exact && <div className="mt-0.5 line-clamp-2 text-[12px] text-neutral-500">“{a.quote.exact}”</div>}
    </section>
  );
}
