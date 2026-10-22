import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { projectKey } from "@/lib/project";
import type { EntityRef } from "@/types/models";
import { useAppStore } from "./app";

/**
 * 让画布定位并选中某个实体的节点（例如从 PDF 角注跳过来）。
 * place 为 true 时，实体还不在画布上就先放到视口中央；edit 为 true 时定位后进入编辑。
 */
export interface CanvasFocusRequest {
  boardId: string;
  ref: EntityRef;
  place?: boolean;
  edit?: boolean;
  seq: number;
}

/** 收件箱筛选。domain 为 "board" 表示按当前画布关联的领域筛选 */
export interface InboxFilter {
  paperId: string | null;
  domain: string | "board" | null;
  color: string | null;
}

export type CanvasSidebarTab = "inbox" | "search";

/** 收件箱范围：不在任何画布上 / 不在当前画布上（整理第二块画布时用） */
export type InboxScope = "anywhere" | "board";

interface CanvasUiState {
  activeBoardId: string | null;
  focus: CanvasFocusRequest | null;
  /** 正在编辑笔记的节点（boardNode id） */
  editingNodeId: string | null;
  /** 正在闪烁（刚定位到）的节点 */
  flashNodeId: string | null;
  sidebarTab: CanvasSidebarTab;
  inboxFilter: InboxFilter;
  inboxScope: InboxScope;
  searchQuery: string;

  setActiveBoard: (id: string | null) => void;
  /** 切到画布视图并打开某块画布 */
  openBoard: (id: string) => void;
  focusEntity: (boardId: string, ref: EntityRef, opts?: { place?: boolean; edit?: boolean }) => void;
  clearFocus: (seq: number) => void;
  setEditingNode: (id: string | null) => void;
  flashNode: (id: string) => void;
  setSidebarTab: (tab: CanvasSidebarTab) => void;
  setInboxFilter: (patch: Partial<InboxFilter>) => void;
  setInboxScope: (scope: InboxScope) => void;
  setSearchQuery: (q: string) => void;
}

let seq = 0;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** 定位后节点闪烁的时长（与 canvas.css 的动画一致） */
export const NODE_FLASH_MS = 1600;

export const useCanvasStore = create<CanvasUiState>()(
  persist(
    (set, get) => ({
      activeBoardId: null,
      focus: null,
      editingNodeId: null,
      flashNodeId: null,
      sidebarTab: "inbox",
      inboxFilter: { paperId: null, domain: "board", color: null },
      inboxScope: "anywhere",
      searchQuery: "",

      setActiveBoard: (id) => {
        if (get().activeBoardId !== id) set({ activeBoardId: id, editingNodeId: null });
      },
      openBoard: (id) => {
        get().setActiveBoard(id);
        useAppStore.getState().setView("canvas");
      },
      focusEntity: (boardId, ref, opts) => {
        get().setActiveBoard(boardId);
        set({ focus: { boardId, ref: { kind: ref.kind, id: ref.id }, ...opts, seq: ++seq } });
        useAppStore.getState().setView("canvas");
      },
      clearFocus: (s) => {
        if (get().focus?.seq === s) set({ focus: null });
      },
      setEditingNode: (id) => set({ editingNodeId: id }),
      flashNode: (id) => {
        // 先清掉再设置，连续定位同一节点时动画能重新播放
        clearTimeout(flashTimer);
        set({ flashNodeId: null });
        requestAnimationFrame(() => set({ flashNodeId: id }));
        flashTimer = setTimeout(() => set({ flashNodeId: null }), NODE_FLASH_MS + 50);
      },
      setSidebarTab: (sidebarTab) => set({ sidebarTab }),
      setInboxFilter: (patch) => set({ inboxFilter: { ...get().inboxFilter, ...patch } }),
      setInboxScope: (inboxScope) => set({ inboxScope }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
    }),
    {
      // 内容含本项目的 id（选中的领域、术语、画布）：按项目分开存
      name: projectKey("paperlens.canvas"),
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ activeBoardId: s.activeBoardId }),
    },
  ),
);
