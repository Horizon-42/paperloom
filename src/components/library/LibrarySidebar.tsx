// 文库侧栏：项目切换、导入、全局搜索、视图切换、领域树、论文列表、标签编辑弹层
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useAppStore, type MainView } from "@/app/stores/app";
import { SIDEBAR_DEFAULT_WIDTH, useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { findTag } from "@/lib/tags";
import { markPaperOpened } from "@/services/paperService";
import { isFileDrag } from "./dnd";
import { DomainTree } from "./DomainTree";
import { IconBook, IconCanvas, IconNote, IconSearch, IconTag, IconUpload, IconX } from "./icons";
import { ImportStatus } from "./ImportStatus";
import { enqueueImport, filesFromList } from "./importController";
import { LibraryDataProvider, useLibraryData } from "./libraryData";
import { LibraryDialogs } from "./LibraryDialogs";
import { PaperList } from "./PaperList";
import { ProjectRegistryBanner, ProjectSwitcher } from "./ProjectSwitcher";
import { useSearchProviders } from "./search";
import { SearchResults } from "./SearchResults";
import { TagEditorHost } from "./TagEditorPopover";
import { isTagNameHeld } from "./tagFilterHold";
import { cx } from "./ui";
import { StorageStatus } from "@/components/data/StorageStatus";

export function LibrarySidebar() {
  return (
    <LibraryDataProvider>
      <SidebarInner />
    </LibraryDataProvider>
  );
}

function SidebarInner() {
  const width = useLibraryStore((s) => s.sidebarWidth);
  const query = useLibraryStore((s) => s.query);
  const fileDragActive = useWindowFileDrop();
  useTrackLastOpened();
  useSelectionGuard();
  useTagFilterGuard();

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 text-neutral-800"
      aria-label="文库"
      data-testid="library-sidebar"
      data-library-sidebar
    >
      <SidebarHeader />
      <DomainTree />
      {query.trim() ? <SearchResults query={query} /> : <PaperList />}
      <ImportStatus />
      <StorageStatus />
      <ResizeHandle />
      <LibraryDialogs />
      <TagEditorHost />
      {fileDragActive && <FileDropOverlay />}
    </aside>
  );
}

// ---------- 顶部：项目切换、导入、搜索、视图切换 ----------

const VIEWS: { value: MainView; label: string; Icon: typeof IconBook }[] = [
  { value: "reader", label: "阅读", Icon: IconBook },
  { value: "glossary", label: "术语表", Icon: IconTag },
  { value: "annotations", label: "批注", Icon: IconNote },
  { value: "canvas", label: "画布", Icon: IconCanvas },
];

function SidebarHeader() {
  const fileInput = useRef<HTMLInputElement>(null);
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);

  return (
    <div className="space-y-2.5 px-3 pb-2.5 pt-3">
      <div className="flex items-center gap-2">
        <ProjectSwitcher />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-blue-600 px-2.5 text-[12.5px] font-medium text-white shadow-sm hover:bg-blue-700"
          title="导入 PDF（也可直接拖入窗口）"
        >
          <IconUpload width={14} height={14} />
          导入
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          data-testid="import-input"
          onChange={(e) => {
            enqueueImport(filesFromList(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      <ProjectRegistryBanner />

      <SearchBox />

      <div role="tablist" aria-label="主视图" className="grid grid-cols-3 gap-0.5 rounded-lg bg-neutral-200/60 p-0.5">
        {VIEWS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            className={cx(
              "flex h-6 items-center justify-center gap-1 rounded-md text-[12px] transition-colors",
              view === value ? "bg-white font-medium text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800",
            )}
          >
            <Icon width={13} height={13} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchBox() {
  const query = useLibraryStore((s) => s.query);
  const setQuery = useLibraryStore((s) => s.setQuery);
  const providers = useSearchProviders();
  const placeholder = `搜索${providers.map((p) => p.label).join("、")}（#标签）`;

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
        placeholder={providers.length === 1 ? "搜索论文标题、作者、标签" : placeholder}
        title="搜索论文标题、作者、标签；以 # 开头只搜标签，如 #待读"
        aria-label="全局搜索"
        className="h-8 w-full rounded-md border border-neutral-200 bg-white pl-8 pr-7 text-[13px] placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          aria-label="清除搜索"
        >
          <IconX width={13} height={13} />
        </button>
      )}
    </div>
  );
}

// ---------- 侧栏宽度 ----------

function ResizeHandle() {
  const setWidth = useLibraryStore((s) => s.setSidebarWidth);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startW = useLibraryStore.getState().sidebarWidth;
    el.setPointerCapture(e.pointerId);
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: globalThis.PointerEvent) => setWidth(startW + ev.clientX - startX);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const w = useLibraryStore.getState().sidebarWidth;
    if (e.key === "ArrowLeft") setWidth(w - 16);
    else if (e.key === "ArrowRight") setWidth(w + 16);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧栏宽度（双击恢复默认）"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize outline-none"
    >
      <div className="mx-auto h-full w-0.5 bg-transparent transition-colors group-hover:bg-blue-400 group-focus-visible:bg-blue-400 group-active:bg-blue-500" />
    </div>
  );
}

// ---------- 拖入文件导入 ----------

/** 在整个窗口上监听系统文件拖入；返回是否正在拖着文件 */
function useWindowFileDrop(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth++;
      setActive(true);
    };
    const over = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); // 允许放下，并阻止浏览器直接打开文件
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const drop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setActive(false);
      enqueueImport(filesFromList(e.dataTransfer?.files));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  return active;
}

function FileDropOverlay() {
  const selection = useLibraryStore((s) => s.selection);
  const { domainById } = useLibraryData();
  const target = selection.kind === "domain" ? domainById.get(selection.id)?.name : undefined;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-blue-500/5 p-6">
      <div className="flex h-full w-full items-center justify-center rounded-2xl border-2 border-dashed border-blue-400 bg-white/60">
        <div className="rounded-xl bg-white px-6 py-4 text-center shadow-lg">
          <div className="text-sm font-medium text-neutral-800">松开以导入 PDF</div>
          {target && <div className="mt-1 text-xs text-neutral-500">将归入「{target}」</div>}
        </div>
      </div>
    </div>
  );
}

// ---------- 其他副作用 ----------

/** 同一篇论文两次写 lastOpenedAt 的最小间隔：来回切标签不必每次写库 */
const LAST_OPENED_THROTTLE_MS = 60_000;
const lastOpenedWrites = new Map<string, number>();

/**
 * 任一分栏切换到另一篇论文时记录 lastOpenedAt（覆盖所有打开途径，不只是侧栏点击）。
 * 只在激活的论文变化时写，且同一篇论文每分钟最多写一次。
 */
function useTrackLastOpened() {
  useEffect(
    () =>
      useReaderStore.subscribe((s, prev) => {
        if (s.panes === prev.panes) return;
        const before = new Set(prev.panes.map((p) => p.activePaperId));
        const now = Date.now();
        for (const p of s.panes) {
          const id = p.activePaperId;
          if (!id || before.has(id)) continue;
          if (now - (lastOpenedWrites.get(id) ?? -Infinity) < LAST_OPENED_THROTTLE_MS) continue;
          lastOpenedWrites.set(id, now);
          void markPaperOpened(id, now);
        }
      }),
    [],
  );
}

/**
 * 文库的标签变化后（删除、改名，包括在其他标签页中），去掉筛选里已不存在的标签；写法与文库里不同时改成文库里的写法。
 * 等数据加载完再判断，避免启动时把记住的筛选清掉。只在标签列表变化时检查。
 * 管理标签对话框先改筛选、再写库：写库生效前新名字由 tagFilterHold 暂留，不会被去掉。
 */
function useTagFilterGuard() {
  const { loaded, tags } = useLibraryData();
  useEffect(() => {
    const st = useLibraryStore.getState();
    const filter = st.tagFilter;
    if (!loaded || !filter.length) return;
    const next = filter.map((t) => findTag(tags, t)?.name ?? (isTagNameHeld(t) ? t : undefined)).filter((t): t is string => !!t);
    if (next.length !== filter.length || next.some((t, i) => t !== filter[i])) st.setTagFilter(next);
  }, [loaded, tags]);
}

/** 选中的领域被删除（包括在其他标签页中删除）后回到"全部论文" */
function useSelectionGuard() {
  const { loaded, domainById } = useLibraryData();
  const selection = useLibraryStore((s) => s.selection);
  useEffect(() => {
    if (loaded && selection.kind === "domain" && !domainById.has(selection.id)) {
      useLibraryStore.getState().select({ kind: "all" });
    }
  }, [loaded, selection, domainById]);
}
