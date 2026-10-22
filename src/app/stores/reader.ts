import { create } from "zustand";
import { useAppStore } from "./app";

export type PaneId = "left" | "right";

export interface Pane {
  id: PaneId;
  tabs: string[]; // paperId 列表，按标签顺序
  activePaperId: string | null;
}

/** 跳转请求：其他模块（批注列表、术语弹窗等）通过 jumpTo 让阅读器滚动到指定位置 */
export interface JumpTarget {
  paperId: string;
  page: number; // 从 1 开始
  /** 页内目标位置（PDF 坐标 [x, y]），通常取批注第一个矩形的左上角 [x1, y2]；缺省跳到页顶。用完整坐标换算以兼容旋转页 */
  pdfPoint?: [number, number];
  /** 跳转后闪烁高亮的批注 */
  annotationId?: string;
  /** 指定在哪个分栏跳转；缺省时优先聚焦且已打开该论文的分栏 */
  paneId?: PaneId;
}

export interface JumpRequest extends JumpTarget {
  seq: number; // 自增，阅读器据此判断是否为新请求
  paneId: PaneId;
}

interface ReaderState {
  panes: Pane[]; // 1 个（单栏）或 2 个（左右分屏）
  focusedPane: PaneId;
  jumpRequest: JumpRequest | null;

  openPaper: (paperId: string, opts?: { paneId?: PaneId }) => void;
  closeTab: (paneId: PaneId, paperId: string) => void;
  activateTab: (paneId: PaneId, paperId: string) => void;
  focusPane: (paneId: PaneId) => void;
  toggleSplit: () => void;
  jumpTo: (target: JumpTarget) => void;
}

let jumpSeq = 0;

const emptyPane = (id: PaneId): Pane => ({ id, tabs: [], activePaperId: null });

/** 找出已打开该论文的分栏：聚焦且正在显示 > 正在显示 > 聚焦且有该标签 > 任一有该标签 */
function findHolder(panes: Pane[], paperId: string, focused: PaneId): Pane | undefined {
  const rank = (p: Pane) =>
    (p.activePaperId === paperId ? 2 : p.tabs.includes(paperId) ? 1 : 0) * 2 + (p.id === focused ? 1 : 0);
  const best = panes.reduce<Pane | undefined>((acc, p) => (rank(p) > (acc ? rank(acc) : 1) ? p : acc), undefined);
  return best;
}

function updatePane(panes: Pane[], id: PaneId, fn: (p: Pane) => Pane): Pane[] {
  return panes.map((p) => (p.id === id ? fn(p) : p));
}

export const useReaderStore = create<ReaderState>()((set, get) => ({
  panes: [emptyPane("left")],
  focusedPane: "left",
  jumpRequest: null,

  openPaper: (paperId, opts) => {
    let { panes } = get();
    const { focusedPane } = get();
    // 指定右栏但尚未分屏时先建出右栏，保证 focusedPane 总是指向存在的分栏
    if (opts?.paneId === "right" && panes.length === 1) panes = [panes[0], emptyPane("right")];
    // 已在某个分栏打开时直接切过去（聚焦的分栏优先），避免重复标签
    const existing = opts?.paneId ? undefined : findHolder(panes, paperId, focusedPane);
    const paneId = opts?.paneId ?? existing?.id ?? focusedPane;
    set({
      focusedPane: paneId,
      panes: updatePane(panes, paneId, (p) => ({
        ...p,
        tabs: p.tabs.includes(paperId) ? p.tabs : [...p.tabs, paperId],
        activePaperId: paperId,
      })),
    });
    useAppStore.getState().setView("reader");
  },

  closeTab: (paneId, paperId) =>
    set(({ panes, jumpRequest }) => ({
      // 未被消费的跳转请求随标签一起作废，避免之后重新打开时被重放
      jumpRequest: jumpRequest?.paneId === paneId && jumpRequest.paperId === paperId ? null : jumpRequest,
      panes: updatePane(panes, paneId, (p) => {
        const idx = p.tabs.indexOf(paperId);
        if (idx < 0) return p;
        const tabs = p.tabs.filter((t) => t !== paperId);
        const activePaperId =
          p.activePaperId === paperId ? (tabs[Math.min(idx, tabs.length - 1)] ?? null) : p.activePaperId;
        return { ...p, tabs, activePaperId };
      }),
    })),

  activateTab: (paneId, paperId) =>
    set(({ panes }) => ({
      focusedPane: paneId,
      panes: updatePane(panes, paneId, (p) => ({ ...p, activePaperId: paperId })),
    })),

  focusPane: (paneId) => set({ focusedPane: paneId }),

  toggleSplit: () =>
    set(({ panes }) => {
      if (panes.length === 1) return { panes: [panes[0], emptyPane("right")], focusedPane: "right" };
      // 关闭分屏时把右栏的标签并入左栏
      const [left, right] = panes;
      const tabs = [...left.tabs, ...right.tabs.filter((t) => !left.tabs.includes(t))];
      return {
        panes: [{ ...left, tabs, activePaperId: left.activePaperId ?? right.activePaperId }],
        focusedPane: "left",
        jumpRequest: null,
      };
    }),

  jumpTo: (target) => {
    const { panes, focusedPane } = get();
    const paneId = target.paneId ?? findHolder(panes, target.paperId, focusedPane)?.id ?? focusedPane;
    get().openPaper(target.paperId, { paneId });
    set({ jumpRequest: { ...target, paneId, seq: ++jumpSeq } });
  },
}));
