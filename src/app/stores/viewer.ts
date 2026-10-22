import { create } from "zustand";
import type { PaneId } from "./reader";
import type { ZoomMode } from "@/components/viewer/layout";

/** 每个标签的界面状态：切走再切回时恢复 */
export interface TabView {
  zoomMode: ZoomMode;
  /** zoomMode 为 custom 时使用的 viewport scale */
  scale: number;
  /** 视口顶部所在页（从 1 开始）及页内比例 */
  page: number;
  pageFrac: number;
}

interface ViewerState {
  tabViews: Record<string, TabView>;
  /** 左栏宽度占比（分屏时） */
  splitRatio: number;
  /** 已处理的最大 jumpRequest.seq，避免重新挂载时重复跳转 */
  consumedJumpSeq: number;
  /** 最近显示过的论文（最近的在前），用于决定哪些后台标签继续持有 PDF 文档 */
  docMru: string[];

  saveTabView: (paneId: PaneId, paperId: string, view: TabView) => void;
  /** 取不到本分栏的状态时，退回同一论文在另一分栏的状态（关闭分屏合并标签后仍能恢复） */
  getTabView: (paneId: PaneId, paperId: string) => TabView | undefined;
  /** 删除已不在任何分栏打开的论文的状态 */
  pruneTabViews: (openPaperIds: Iterable<string>) => void;
  setSplitRatio: (ratio: number) => void;
  consumeJump: (seq: number) => boolean;
  touchDoc: (paperId: string) => void;
}

/** 后台标签（不在任何分栏前台显示）最多保留这么多个已加载的 PDF 文档，其余释放，切回时重新加载 */
export const MAX_BACKGROUND_DOCS = 3;

export const tabKey = (paneId: PaneId, paperId: string) => `${paneId}:${paperId}`;

export const useViewerStore = create<ViewerState>()((set, get) => ({
  tabViews: {},
  splitRatio: 0.5,
  consumedJumpSeq: 0,
  docMru: [],

  saveTabView: (paneId, paperId, view) =>
    set(({ tabViews }) => ({ tabViews: { ...tabViews, [tabKey(paneId, paperId)]: view } })),

  getTabView: (paneId, paperId) => {
    const { tabViews } = get();
    return tabViews[tabKey(paneId, paperId)] ?? tabViews[tabKey(paneId === "left" ? "right" : "left", paperId)];
  },

  pruneTabViews: (openPaperIds) => {
    const { tabViews } = get();
    const keep = new Set(openPaperIds);
    const stale = Object.keys(tabViews).filter((k) => !keep.has(k.slice(k.indexOf(":") + 1)));
    const docMru = get().docMru.filter((id) => keep.has(id));
    if (!stale.length && docMru.length === get().docMru.length) return;
    const next = { ...tabViews };
    for (const k of stale) delete next[k];
    set({ tabViews: next, docMru });
  },

  setSplitRatio: (ratio) => set({ splitRatio: Math.min(0.8, Math.max(0.2, ratio)) }),

  touchDoc: (paperId) => {
    const { docMru } = get();
    if (docMru[0] === paperId) return;
    set({ docMru: [paperId, ...docMru.filter((id) => id !== paperId)] });
  },

  consumeJump: (seq) => {
    if (seq <= get().consumedJumpSeq) return false;
    set({ consumedJumpSeq: seq });
    return true;
  },
}));
