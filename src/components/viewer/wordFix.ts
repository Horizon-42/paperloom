// 文本层词级校正：用字形映射把每个 TextLayer span 拆成"词/空白"子 span，
// 并给每个子 span 设置 letter-spacing（em），使每个词在屏幕上的起止位置与 PDF 真实位置一致。
// 这样浏览器原生选区落在正确的词边界上，选区底色也贴合字形；词内部的字符按均匀间距近似。
//
// - 子 span 只改 letter-spacing，不改父 span 的 --scale-x；各段调整量之和≈0，
//   所以 TextLayer.update()（缩放时按 measureText 重算 scale-x）依旧正确。
// - letter-spacing 用 em，随字号一起缩放，缩放后不需要重算。
// - 拆分后 span 内有多个文本节点，从 DOM 位置换算片段偏移时要用 TreeWalker 累加（见 lib/textGeometry.ts）。
import type { PageViewport } from "@/lib/pdf";
import type { TextItemLike } from "@/engine/types";

export const SEG_CLASS = "pl-seg";

export interface WordFixStats {
  spans: number;
  fixed: number;
  segments: number;
  ms: number;
}

const isWsChar = (c: string) => /\s/.test(c);

/** 只处理正向横排的片段，且页面不旋转（校正按屏幕 x 方向计算） */
function isUpright(it: TextItemLike, viewport: PageViewport): boolean {
  const t = it.transform;
  return viewport.rotation % 360 === 0 && t[0] > 0 && Math.abs(t[1]) < 1e-3 && Math.abs(t[2]) < 1e-3;
}

function xRange(box: Float32Array, j: number, viewport: PageViewport): [number, number] {
  const y = box[j * 4 + 1];
  const xa = viewport.convertToViewportPoint(box[j * 4], y)[0];
  const xb = viewport.convertToViewportPoint(box[j * 4 + 2], y)[0];
  return [Math.min(xa, xb), Math.max(xa, xb)];
}

/**
 * 校正整页文本层。divs 与 items 一一对应（TextLayer.textDivs）。
 * 未映射的片段、竖排/旋转的片段保持 pdf.js 原样。重复调用是安全的（已拆分的片段会跳过）。
 */
export function applyWordLevelFix(
  divs: HTMLElement[],
  items: readonly TextItemLike[],
  charBoxes: Float32Array[],
  viewport: PageViewport,
): WordFixStats {
  const t0 = performance.now();
  const stats: WordFixStats = { spans: 0, fixed: 0, segments: 0, ms: 0 };
  type Job = { div: HTMLElement; segs: HTMLElement[]; starts: number[]; ends: number[]; counts: number[] };
  const jobs: Job[] = [];

  // 第 1 遍：只写 DOM（拆分子 span），不读布局
  for (let i = 0; i < divs.length; i++) {
    const div = divs[i];
    const it = items[i];
    const str = it?.str ?? "";
    if (!div?.isConnected || str.length < 2 || div.firstElementChild) continue;
    stats.spans++;
    const box = charBoxes[i];
    if (!box || !isUpright(it, viewport)) continue;
    // 每个字符的 [左, 右]；非空白字符缺失则放弃该片段
    const left: number[] = [];
    const right: number[] = [];
    let ok = true;
    for (let j = 0; j < str.length; j++) {
      if (Number.isNaN(box[j * 4])) {
        if (!isWsChar(str[j])) {
          ok = false;
          break;
        }
        left.push(NaN);
        right.push(NaN);
        continue;
      }
      const [a, b] = xRange(box, j, viewport);
      left.push(a);
      right.push(b);
    }
    if (!ok) continue;
    const segs: HTMLElement[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    const counts: number[] = [];
    for (const m of str.matchAll(/\s+|\S+/g)) {
      const s = m.index!;
      const e = s + m[0].length;
      // 词段：首字符左边到末字符右边；空白段：前一词右边到后一词左边
      let x0: number, x1: number;
      if (!isWsChar(m[0][0])) {
        x0 = left[s];
        x1 = right[e - 1];
      } else {
        x0 = s > 0 ? right[s - 1] : left[s];
        x1 = e < str.length ? left[e] : right[e - 1];
      }
      if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 < x0 - 0.5) {
        ok = false;
        break;
      }
      const span = document.createElement("span");
      span.className = SEG_CLASS;
      span.textContent = m[0];
      segs.push(span);
      starts.push(x0);
      ends.push(x1);
      counts.push(m[0].length);
    }
    if (!ok || segs.length === 0) continue;
    div.textContent = "";
    div.append(...segs);
    jobs.push({ div, segs, starts, ends, counts });
  }

  // 第 2 遍：统一读布局，算出每段需要的 letter-spacing；最后统一写入
  const writes: [HTMLElement, string][] = [];
  for (const job of jobs) {
    const style = getComputedStyle(job.div);
    const fontPx = parseFloat(style.fontSize);
    // 父 span 的横向缩放（scaleX × 1/min-font-size）。直接取计算后的 transform：
    // 以前用 getBoundingClientRect().width / offsetWidth 估算，offsetWidth 取整，短词上比例误差可达百分之几，
    // 沿 span 累积成越往后越大的漂移
    const ratio = horizontalScale(style.transform);
    if (!(ratio > 0) || !(fontPx > 0)) continue;
    for (let k = 0; k < job.segs.length; k++) {
      const cur = job.segs[k].getBoundingClientRect().width;
      // 目标宽度 = 本段 + 到下一段起点的距离，误差不向后传递
      const target = job.ends[k] - job.starts[k] + (k + 1 < job.segs.length ? job.starts[k + 1] - job.ends[k] : 0);
      const ls = (target - cur) / ratio / job.counts[k];
      writes.push([job.segs[k], `${(ls / fontPx).toFixed(5)}em`]);
    }
    stats.fixed++;
    stats.segments += job.segs.length;
  }
  for (const [el, v] of writes) el.style.letterSpacing = v;
  stats.ms = performance.now() - t0;
  return stats;
}

/** CSS transform 的横向缩放（只处理不旋转的情况；rotate 由调用方排除） */
function horizontalScale(transform: string): number {
  if (!transform || transform === "none") return 1;
  try {
    const m = new DOMMatrixReadOnly(transform);
    return Math.hypot(m.a, m.b);
  } catch {
    return 0;
  }
}
