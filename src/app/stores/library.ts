import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { projectKey } from "@/lib/project";
import { normalizeTags, tagKey } from "@/lib/tags";
import type { PaneId } from "./reader";

/** 侧栏领域树里选中的项：没有 / 未分类 / 某个领域。选中的领域是导入的默认目标 */
export type LibrarySelection = { kind: "all" } | { kind: "unfiled" } | { kind: "domain"; id: string };

/** 侧栏的论文视图：按领域（文件夹树）/ 全部论文（平铺列表） */
export type LibraryView = "tree" | "all";

export type PaperSort = "added" | "title" | "year" | "lastOpened";

/** 侧栏里的弹窗（同一时间只开一个） */
export type LibraryDialog =
  | { kind: "editPaper"; paperId: string }
  | { kind: "deletePaper"; paperId: string }
  | { kind: "deleteDomain"; domainId: string }
  | { kind: "manageTags" };

/**
 * 标签编辑弹层锚定在哪里：侧栏里的论文行，或某个分栏阅读器工具栏上的标签按钮。
 * 领域树里同一篇论文可能出现在几个领域下，parentId 指明是哪一行（「未分类」里为 null）；平铺列表、搜索结果里的行没有 parentId
 */
export type TagEditorAnchor = { kind: "row"; parentId?: string | null } | { kind: "toolbar"; paneId: PaneId };

/** 正在编辑标签的论文（全局只有一个弹层；seq 每次打开自增） */
export interface TagEditorState {
  paperId: string;
  anchor: TagEditorAnchor;
  seq: number;
}

export interface ImportJobItem {
  status: "added" | "duplicate" | "failed";
  fileName: string;
  paperId?: string;
  title?: string;
  error?: string;
}

export interface ImportJob {
  total: number;
  done: number;
  current: string | null; // 正在处理的文件名
  items: ImportJobItem[];
  finished: boolean;
}

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 560;
export const SIDEBAR_DEFAULT_WIDTH = 280;

interface LibraryState {
  view: LibraryView;
  selection: LibrarySelection;
  sort: PaperSort;
  /** 标签筛选：论文须带有其中全部标签（与领域选择叠加）；空数组表示不筛选 */
  tagFilter: string[];
  query: string;
  /** 展开的领域 id */
  expanded: Record<string, true>;
  /** 领域树末尾的「未分类」是否展开 */
  unfiledOpen: boolean;
  sidebarWidth: number;

  renamingDomainId: string | null;
  dialog: LibraryDialog | null;
  /** 正在拖动的领域（dragover 时读不到 dataTransfer 内容，靠它判断能否放下） */
  draggingDomainId: string | null;
  /** 需要在列表中定位并闪烁的论文；seq 每次请求自增 */
  reveal: { paperId: string; seq: number } | null;
  importJob: ImportJob | null;
  tagEditor: TagEditorState | null;

  setView: (view: LibraryView) => void;
  select: (selection: LibrarySelection) => void;
  setSort: (sort: PaperSort) => void;
  setTagFilter: (tags: string[]) => void;
  /** 已在筛选中则移除，否则加入 */
  toggleTagFilter: (tag: string) => void;
  setQuery: (query: string) => void;
  setExpanded: (id: string, expanded: boolean) => void;
  toggleExpanded: (id: string) => void;
  setUnfiledOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setRenamingDomain: (id: string | null) => void;
  openDialog: (dialog: LibraryDialog) => void;
  closeDialog: () => void;
  setDraggingDomain: (id: string | null) => void;
  revealPaper: (paperId: string) => void;
  /** 列表处理完定位请求后调用，避免重新挂载时再次闪烁 */
  clearReveal: () => void;
  setImportJob: (job: ImportJob | null | ((prev: ImportJob | null) => ImportJob | null)) => void;
  openTagEditor: (paperId: string, anchor: TagEditorAnchor) => void;
  closeTagEditor: () => void;
}

let revealSeq = 0;
let tagEditorSeq = 0;

export const clampSidebarWidth = (w: number) => Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w)));

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set) => ({
      view: "tree",
      selection: { kind: "all" },
      sort: "added",
      tagFilter: [],
      query: "",
      expanded: {},
      unfiledOpen: true,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      renamingDomainId: null,
      dialog: null,
      draggingDomainId: null,
      reveal: null,
      importJob: null,
      tagEditor: null,

      setView: (view) => set({ view }),
      select: (selection) => set({ selection }),
      setSort: (sort) => set({ sort }),
      setTagFilter: (tags) => set({ tagFilter: normalizeTags(tags) }),
      toggleTagFilter: (tag) =>
        set((s) => {
          const k = tagKey(tag);
          const has = s.tagFilter.some((t) => tagKey(t) === k);
          return { tagFilter: has ? s.tagFilter.filter((t) => tagKey(t) !== k) : normalizeTags([...s.tagFilter, tag]) };
        }),
      setQuery: (query) => set({ query }),
      setExpanded: (id, expanded) =>
        set((s) => {
          if (Boolean(s.expanded[id]) === expanded) return s;
          const next = { ...s.expanded };
          if (expanded) next[id] = true;
          else delete next[id];
          return { expanded: next };
        }),
      toggleExpanded: (id) =>
        set((s) => {
          const next = { ...s.expanded };
          if (next[id]) delete next[id];
          else next[id] = true;
          return { expanded: next };
        }),
      setUnfiledOpen: (unfiledOpen) => set({ unfiledOpen }),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      setRenamingDomain: (renamingDomainId) => set({ renamingDomainId }),
      openDialog: (dialog) => set({ dialog }),
      closeDialog: () => set({ dialog: null }),
      setDraggingDomain: (draggingDomainId) => set({ draggingDomainId }),
      // 定位时退出搜索，回到论文列表
      revealPaper: (paperId) => set({ reveal: { paperId, seq: ++revealSeq }, query: "" }),
      clearReveal: () => set({ reveal: null }),
      setImportJob: (job) => set((s) => ({ importJob: typeof job === "function" ? job(s.importJob) : job })),
      openTagEditor: (paperId, anchor) => set({ tagEditor: { paperId, anchor, seq: ++tagEditorSeq } }),
      closeTagEditor: () => set({ tagEditor: null }),
    }),
    {
      // 内容含本项目的 id（选中的领域、术语、画布）：按项目分开存
      name: projectKey("paperlens.library"),
      storage: createJSONStorage(() => localStorage),
      // 只记住偏好类状态，弹窗、拖动、导入进度不持久化
      // 选中的领域（导入目标）不记住：刷新后不会在不知不觉中把新论文归进很久以前点过的领域
      partialize: (s) => ({
        view: s.view,
        sort: s.sort,
        tagFilter: s.tagFilter,
        expanded: s.expanded,
        unfiledOpen: s.unfiledOpen,
        sidebarWidth: s.sidebarWidth,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<LibraryState>;
        const tagFilter = Array.isArray(p.tagFilter) ? normalizeTags(p.tagFilter.filter((t) => typeof t === "string")) : [];
        const view: LibraryView = p.view === "all" ? "all" : "tree";
        return { ...current, ...p, selection: current.selection, tagFilter, view, unfiledOpen: p.unfiledOpen !== false };
      },
    },
  ),
);

/** 导入时自动归入的领域：按领域浏览、并选中了某个领域时是它，否则为 null */
export function importTargetDomainId(state: Pick<LibraryState, "view" | "selection">): string | null {
  return state.view === "tree" && state.selection.kind === "domain" ? state.selection.id : null;
}
