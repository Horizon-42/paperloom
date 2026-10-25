// 朗读的界面状态（D19）：在读哪一页的哪一段、当前句和当前词（页面规范化文本的下标，供高亮）、语速。
import { create } from "zustand";
import type { PaneId } from "./reader";

export interface ReadAloudTarget {
  paneId: PaneId;
  paperId: string;
  page: number;
  /** 朗读的范围（页面规范化文本的下标） */
  start: number;
  end: number;
  /** 朗读的文字，界面上显示开头 */
  text: string;
}

export type ReadAloudStatus = "idle" | "speaking" | "paused";

interface ReadAloudState {
  status: ReadAloudStatus;
  target: ReadAloudTarget | null;
  /** 正在读的句子、词（规范化文本的绝对下标）；浏览器不报告读到的词时 word 为 null */
  sentence: { start: number; end: number } | null;
  word: { start: number; end: number } | null;
  rate: number;
  set: (patch: Partial<Omit<ReadAloudState, "set">>) => void;
}

/** 语速只与本浏览器有关，不分项目 */
const RATE_KEY = "paperlens.readAloud.rate";
function readRate(): number {
  try {
    const v = Number(localStorage.getItem(RATE_KEY));
    return v >= 0.5 && v <= 2 ? v : 1;
  } catch {
    return 1;
  }
}
export function saveRate(rate: number) {
  try {
    localStorage.setItem(RATE_KEY, String(rate));
  } catch {
    // 无痕模式等：只在本次有效
  }
}

export const useReadAloudStore = create<ReadAloudState>()((set) => ({
  status: "idle",
  target: null,
  sentence: null,
  word: null,
  rate: readRate(),
  set: (patch) => set(patch),
}));
