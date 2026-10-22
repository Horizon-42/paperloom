// 下划线显示规则与点击命中测试（纯函数）
import type { TermMatch } from "@/engine/types";
import type { ScreenRect } from "@/lib/coords";
import type { TermDisplaySettings } from "@/db/repo/terms";

/**
 * 每页每个术语只保留第一次出现：命中的候选里有任一术语在本页还没出现过就保留，
 * 并把这次命中的全部候选记为已出现。输入须按 start 升序（TermMatcher.match 的输出即是）。
 */
export function firstPerTerm(matches: readonly TermMatch[]): TermMatch[] {
  const seen = new Set<string>();
  const out: TermMatch[] = [];
  for (const m of matches) {
    if (m.termIds.some((id) => !seen.has(id))) {
      out.push(m);
      for (const id of m.termIds) seen.add(id);
    }
  }
  return out;
}

/** 按显示设置过滤命中 */
export function visibleMatches(matches: readonly TermMatch[], s: TermDisplaySettings): readonly TermMatch[] {
  if (s.hidden) return [];
  return s.firstOnly ? firstPerTerm(matches) : matches;
}

export interface HitTarget {
  /** 命中第几个匹配 */
  index: number;
  /** 该匹配的第几段矩形（跨行时有多段） */
  seg: number;
}

/**
 * 点 (x, y)（与矩形同一坐标系）落在哪个匹配的哪一段上。矩形四周放宽 slop 像素；
 * 多个都命中时取中心离点最近的。
 */
export function hitTest(items: readonly (readonly ScreenRect[])[], x: number, y: number, slop = 1): HitTarget | null {
  let best: HitTarget | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < items.length; i++) {
    const segs = items[i];
    for (let s = 0; s < segs.length; s++) {
      const r = segs[s];
      if (x < r.left - slop || x > r.left + r.width + slop || y < r.top - slop || y > r.top + r.height + slop) continue;
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < bestDist) {
        bestDist = d;
        best = { index: i, seg: s };
      }
    }
  }
  return best;
}
