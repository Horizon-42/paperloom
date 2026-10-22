// 批注模块的纯计算：高亮点击命中、角注卡片错开布局。不依赖 DOM，便于单元测试。
import type { PdfRect } from "@/types/models";

// ---------------------------------------------------------------------------
// 点击命中
// ---------------------------------------------------------------------------

export interface HitCandidate {
  id: string;
  rects: PdfRect[];
  createdAt: number;
}

/**
 * PDF 坐标点 (x, y) 命中的批注：落在任一矩形内（各边外扩 tol）。
 * 多条重叠时取命中矩形面积最小的（更具体的那条），面积相同取较新的。
 */
export function hitTest(cands: HitCandidate[], x: number, y: number, tol = 0): string | null {
  let best: { id: string; area: number; createdAt: number } | null = null;
  for (const c of cands) {
    for (const r of c.rects) {
      const x1 = Math.min(r[0], r[2]) - tol;
      const x2 = Math.max(r[0], r[2]) + tol;
      const y1 = Math.min(r[1], r[3]) - tol;
      const y2 = Math.max(r[1], r[3]) + tol;
      if (x < x1 || x > x2 || y < y1 || y > y2) continue;
      const area = (x2 - x1) * (y2 - y1);
      if (!best || area < best.area - 1e-9 || (Math.abs(area - best.area) <= 1e-9 && c.createdAt > best.createdAt)) {
        best = { id: c.id, area, createdAt: c.createdAt };
      }
    }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// 角注卡片布局
// ---------------------------------------------------------------------------

export interface StackItem {
  id: string;
  /** 目标纵坐标（批注第一个矩形的顶部，文档坐标） */
  target: number;
  height: number;
  /** 目标相同时的次序（如横坐标），小的在前 */
  order: number;
}

export interface StackOptions {
  /** 卡片之间的最小间距 */
  gap: number;
  /** 最上沿 */
  minY?: number;
  /**
   * 对齐优先的卡片（选中的批注）：放在自己的目标位置，前面的卡片必要时往上让，后面的往下推。
   * 缺省时所有卡片从上到下依次下推。
   */
  anchorId?: string | null;
}

/** 卡片错开布局：返回每张卡片的纵坐标（按 target、order 排序后的顺序） */
export function stackCards(items: StackItem[], opts: StackOptions): { id: string; y: number }[] {
  const { gap } = opts;
  const minY = opts.minY ?? -Infinity;
  const sorted = [...items].sort((a, b) => a.target - b.target || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = sorted.length;
  const y = new Array<number>(n);
  const forward = (from: number, floorOf: (i: number) => number) => {
    for (let i = from; i < n; i++) {
      const prevBottom = i === 0 ? minY : y[i - 1] + sorted[i - 1].height + gap;
      y[i] = Math.max(floorOf(i), prevBottom);
    }
  };
  forward(0, (i) => sorted[i].target);

  const k = opts.anchorId ? sorted.findIndex((s) => s.id === opts.anchorId) : -1;
  if (k >= 0 && y[k] > sorted[k].target) {
    y[k] = Math.max(sorted[k].target, minY);
    // 前面的卡片往上让
    for (let j = k - 1; j >= 0; j--) y[j] = Math.min(y[j], y[j + 1] - gap - sorted[j].height);
    // 顶到上沿时再整体往下挤，必要时锚点本身也下移
    for (let j = 0; j <= k; j++) {
      const prevBottom = j === 0 ? minY : y[j - 1] + sorted[j - 1].height + gap;
      y[j] = Math.max(y[j], prevBottom);
    }
    forward(k + 1, (i) => sorted[i].target);
  }
  return sorted.map((s, i) => ({ id: s.id, y: y[i] }));
}

/** 卡片尚未渲染（未测量）时估计的高度 */
export function estimateCardHeight(note: string, hasTerm: boolean): number {
  const HEADER = 26;
  const PAD = 12;
  if (!note.trim()) return HEADER + PAD + 20;
  // 卡片约 230px 宽，13px 字约 17 个汉字或 32 个西文字符一行
  let lines = 0;
  for (const line of note.split("\n")) {
    const units = [...line].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 1.9 : 1), 0);
    lines += Math.max(1, Math.ceil(units / 32));
  }
  return HEADER + PAD + Math.min(lines, 12) * 19 + (hasTerm ? 4 : 0);
}
