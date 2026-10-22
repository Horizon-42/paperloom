// 测试用：手工构造 pdf.js 风格的文本片段
import type { TermLike, TextItemLike } from "@/engine/types";

const CJK = /[\p{Script=Han}　-〿＀-￯]/u;

/** 估算宽度：拉丁字符 0.5 em，中文 1 em */
export function textWidth(str: string, size: number): number {
  let w = 0;
  for (const ch of str) w += CJK.test(ch) ? size : size * 0.5;
  return w;
}

export function item(
  str: string,
  x: number,
  y: number,
  opts: { size?: number; eol?: boolean; width?: number } = {},
): TextItemLike {
  const size = opts.size ?? 10;
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: opts.width ?? textWidth(str, size),
    height: size,
    hasEOL: opts.eol ?? false,
  };
}

/** pdf.js 在换行处输出的空字符串片段 */
export function eolItem(x = 0, y = 0): TextItemLike {
  return { str: "", transform: [1, 0, 0, 1, x, y], width: 0, height: 0, hasEOL: true };
}

/** 同一基线上依次排列的片段，片段之间留 gap（PDF 单位） */
export function lineItems(strs: string[], x: number, y: number, opts: { size?: number; gap?: number } = {}): TextItemLike[] {
  const size = opts.size ?? 10;
  const gap = opts.gap ?? 0;
  const out: TextItemLike[] = [];
  let cx = x;
  strs.forEach((s, k) => {
    out.push(item(s, cx, y, { size, eol: k === strs.length - 1 }));
    cx += textWidth(s, size) + gap;
  });
  return out;
}

/** 一栏文字：每行一个片段，行距 1.2 em，行尾 hasEOL */
export function column(lines: string[], x: number, yTop: number, size = 10): TextItemLike[] {
  return lines.map((s, k) => item(s, x, yTop - k * size * 1.2, { size, eol: true }));
}

export function term(id: string, name: string, aliases: string[] = [], extra: Partial<TermLike> = {}): TermLike {
  return { id, name, aliases, matchMode: "auto", scope: { kind: "global" }, ...extra };
}
