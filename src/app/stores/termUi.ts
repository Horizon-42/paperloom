import { create } from "zustand";
import type { SelectionAnchor } from "@/types/models";
import type { PaneId } from "./reader";

/** 打开术语编辑器的请求。批注模块的"设为术语"、术语表的"新建/编辑"都通过它进入 */
export interface TermEditorRequest {
  /** 编辑已有术语；缺省为新建 */
  termId?: string;
  /** 新建时预填的名称（通常是选中的文字） */
  initialName?: string;
  /** 从选区创建时的出处：保存术语时同时创建一条批注，并互相关联（Term.sourceAnnotationId / Annotation.termId） */
  source?: SelectionAnchor;
}

/** 弹窗锚定的位置：某个分栏里某页规范化文本的一个区间 */
export interface TermAnchor {
  paneId: PaneId;
  paperId: string;
  page: number; // 从 1 开始
  start: number;
  end: number;
  /** 锚定到跨行匹配的第几段 */
  seg: number;
}

export interface TermPopoverState {
  /** preview：悬停预览（只读）；edit：点击打开（可编辑） */
  mode: "preview" | "edit";
  /** 这处命中的全部候选术语（已排好序） */
  termIds: string[];
  activeTermId: string;
  anchor: TermAnchor;
  /** 每次打开 +1；移动锚点、切换模式不变 */
  seq: number;
}

/** 闪烁定位请求：目标页就绪后由该页的术语覆盖层处理（滚动到可见、闪烁） */
export interface TermFlashRequest {
  paneId: PaneId;
  paperId: string;
  page: number;
  termId: string;
  /** 指定区间；缺省为该页该术语第一次出现处 */
  range?: { start: number; end: number };
  /** 定位后把弹窗移到这里（弹窗里按 ↑/↓ 时） */
  movePopover?: boolean;
  seq: number;
}

interface TermUiState {
  editor: TermEditorRequest | null;
  openTermEditor: (req: TermEditorRequest) => void;
  closeTermEditor: () => void;

  popover: TermPopoverState | null;
  openPopover: (p: Omit<TermPopoverState, "seq">) => void;
  setPopoverMode: (mode: TermPopoverState["mode"]) => void;
  setActiveTerm: (termId: string) => void;
  moveAnchor: (anchor: TermAnchor) => void;
  closePopover: () => void;

  flash: TermFlashRequest | null;
  /** 最近一次请求的定位序号：处理较早定位时排下的滚动若已被新定位取代就放弃 */
  lastFlashSeq: number;
  requestFlash: (f: Omit<TermFlashRequest, "seq">) => number;
  clearFlash: (seq: number) => void;
}

let seq = 0;

// 术语模块可在此文件中继续扩展界面状态（弹窗、下划线显示设置等），上面的接口保持不变
export const useTermUiStore = create<TermUiState>()((set, get) => ({
  editor: null,
  // 打开编辑器时收起弹窗，避免两层浮层抢焦点
  openTermEditor: (req) => set({ editor: req, popover: null }),
  closeTermEditor: () => set({ editor: null }),

  popover: null,
  openPopover: (p) => set({ popover: { ...p, seq: ++seq } }),
  setPopoverMode: (mode) => {
    const p = get().popover;
    if (p && p.mode !== mode) set({ popover: { ...p, mode } });
  },
  setActiveTerm: (termId) => {
    const p = get().popover;
    if (p && p.activeTermId !== termId) set({ popover: { ...p, activeTermId: termId } });
  },
  moveAnchor: (anchor) => {
    const p = get().popover;
    if (p) set({ popover: { ...p, anchor } });
  },
  closePopover: () => {
    const { popover, flash } = get();
    if (!popover && !flash?.movePopover) return;
    set({ popover: null, flash: flash?.movePopover ? null : flash });
  },

  flash: null,
  lastFlashSeq: 0,
  requestFlash: (f) => {
    const s = ++seq;
    set({ flash: { ...f, seq: s }, lastFlashSeq: s });
    return s;
  },
  clearFlash: (s) => {
    if (get().flash?.seq === s) set({ flash: null });
  },
}));
