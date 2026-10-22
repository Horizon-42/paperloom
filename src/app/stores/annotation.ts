import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { PaneId } from "./reader";

/** 当前选中的批注：只在该分栏里展开角注卡片、加强高亮 */
export interface AnnotationSelection {
  paneId: PaneId;
  paperId: string;
  id: string;
}

export interface AnnotationFlash {
  paneId: PaneId;
  id: string;
  seq: number;
}

/** 鼠标悬停的角注卡片 / 色条：只加强同一分栏里的高亮和引线 */
export interface AnnotationHover {
  paneId: PaneId;
  id: string;
}

export interface AnnotationToast {
  seq: number;
  message: string;
  kind: "info" | "error";
  undo?: () => void | Promise<void>;
}

interface AnnotationUiState {
  selected: AnnotationSelection | null;
  /** 正在编辑笔记的批注 */
  editingId: string | null;
  hover: AnnotationHover | null;
  flash: AnnotationFlash | null;
  /** 上次使用的高亮色，"写笔记"沿用它 */
  lastColor: string | null;
  /** 底部提示（新的在后）；每条各自计时、各自撤销 */
  toasts: AnnotationToast[];
  /** "替换 PDF 文件"对话框 */
  replaceDialog: { paperId: string } | null;

  select: (sel: AnnotationSelection | null) => void;
  /** 选中并进入编辑 */
  edit: (sel: AnnotationSelection) => void;
  stopEditing: () => void;
  /** id 为 null 时只清除该分栏的悬停 */
  setHover: (paneId: PaneId, id: string | null) => void;
  flashAnnotation: (paneId: PaneId, id: string) => void;
  setLastColor: (color: string) => void;
  showToast: (message: string, opts?: { kind?: AnnotationToast["kind"]; undo?: AnnotationToast["undo"] }) => number;
  dismissToast: (seq: number) => void;
  openReplaceDialog: (paperId: string) => void;
  closeReplaceDialog: () => void;
}

let seq = 0;

/** 跳转后闪烁的时长（与 annotation.css 中的动画一致） */
export const FLASH_MS = 1900;
/** 同时显示的提示条上限，超出时丢弃最旧的 */
export const MAX_TOASTS = 4;

export const useAnnotationStore = create<AnnotationUiState>()(
  persist(
    (set, get) => ({
      selected: null,
      editingId: null,
      hover: null,
      flash: null,
      lastColor: null,
      toasts: [],
      replaceDialog: null,

      select: (sel) => {
        const cur = get().selected;
        if (sel && cur && cur.id === sel.id && cur.paneId === sel.paneId && cur.paperId === sel.paperId) return;
        set({ selected: sel, editingId: sel && get().editingId === sel.id ? sel.id : null });
      },
      edit: (sel) => set({ selected: sel, editingId: sel.id }),
      stopEditing: () => set({ editingId: null }),
      setHover: (paneId, id) => {
        const cur = get().hover;
        if (id === null) {
          if (cur?.paneId === paneId) set({ hover: null });
          return;
        }
        if (cur?.paneId !== paneId || cur.id !== id) set({ hover: { paneId, id } });
      },
      flashAnnotation: (paneId, id) => {
        const s = ++seq;
        set({ flash: { paneId, id, seq: s } });
        // 闪烁结束后清掉，页面重新挂载时不再重放
        setTimeout(() => {
          if (get().flash?.seq === s) set({ flash: null });
        }, FLASH_MS);
      },
      setLastColor: (lastColor) => set({ lastColor }),
      showToast: (message, opts) => {
        const s = ++seq;
        const toast: AnnotationToast = { seq: s, message, kind: opts?.kind ?? "info", ...(opts?.undo ? { undo: opts.undo } : {}) };
        set({ toasts: [...get().toasts, toast].slice(-MAX_TOASTS) });
        return s;
      },
      dismissToast: (s) => {
        const { toasts } = get();
        if (toasts.some((t) => t.seq === s)) set({ toasts: toasts.filter((t) => t.seq !== s) });
      },
      openReplaceDialog: (paperId) => set({ replaceDialog: { paperId } }),
      closeReplaceDialog: () => set({ replaceDialog: null }),
    }),
    {
      name: "paperlens.annotation",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ lastColor: s.lastColor }),
    },
  ),
);
