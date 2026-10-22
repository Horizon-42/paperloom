// 文字定位：规范化文本区间 ↔ PDF 矩形 / DOM 选区。批注、术语等模块只通过这里定位文字。
//
// 优先用字形映射（ctx.text.charBoxes，精确到字形，见 docs/decisions.md D1），
// 字形映射尚未完成或端点字符未映射时退回文本层 DOM Range（精度较差）。
// 文本层 span 内可能有词级校正拆出的子 span，所有 DOM 偏移都用 TreeWalker 累加文本节点长度。
import { codePointAtIndex, codePointBeforeIndex, isSpacedWordChar, mapRangeToItems } from "@/engine/normalize";
import type { ItemRange, NormalizedText } from "@/engine/types";
import type { PageLayerContext, PageTextInfo } from "@/components/viewer/overlays";
import { clientRectToPdf } from "@/lib/coords";
import type { PdfRect } from "@/types/models";

export interface TextRange {
  start: number;
  end: number;
}

const isWs = (c: string | undefined) => c !== undefined && /\s/.test(c);

// ---------------------------------------------------------------------------
// 规范化区间 → PDF 矩形
// ---------------------------------------------------------------------------

/**
 * 规范化文本区间 [start, end) → PDF 坐标矩形（跨行时多段，同一行合并为一个）。
 * ctx.text 为 null（文本层未就绪）时返回 []。
 */
export function textRangeToPdfRects(ctx: PageLayerContext, start: number, end: number): PdfRect[] {
  const text = ctx.text;
  if (!text || !(end > start)) return [];
  const r = mapRangeToItems(text.normalized, start, end);
  if (!r) return [];
  if (text.charBoxes) {
    const rects = glyphRects(text, text.charBoxes, r);
    if (rects) return rects;
  }
  return domRects(ctx, text, r);
}

/** 片段在 PDF 中是否横排（含 180°），否则视为竖排 */
function isHorizontal(t: number[]): boolean {
  return Math.abs(t[0]) >= Math.abs(t[1]);
}

const extentCache = new WeakMap<Float32Array, [number, number, number, number]>();

/** 片段内所有已映射字符的包围盒：用它的纵向（竖排时为横向）范围，让同一片段的矩形高度一致 */
function itemExtent(box: Float32Array): [number, number, number, number] | null {
  let e = extentCache.get(box);
  if (!e) {
    e = [Infinity, Infinity, -Infinity, -Infinity];
    for (let j = 0; j < box.length; j += 4) {
      if (Number.isNaN(box[j])) continue;
      e[0] = Math.min(e[0], box[j]);
      e[1] = Math.min(e[1], box[j + 1]);
      e[2] = Math.max(e[2], box[j + 2]);
      e[3] = Math.max(e[3], box[j + 3]);
    }
    extentCache.set(box, e);
  }
  return e[0] === Infinity ? null : e;
}

/** 字形映射得到的矩形；任何非空白字符未映射时返回 null（调用方退回 DOM） */
function glyphRects(text: PageTextInfo, charBoxes: Float32Array[], r: ItemRange): PdfRect[] | null {
  const out: { rect: PdfRect; horizontal: boolean }[] = [];
  for (let i = r.startItem; i <= r.endItem; i++) {
    const item = text.items[i];
    const box = charBoxes[i];
    if (!item || !box) return null;
    const str = item.str;
    let s = i === r.startItem ? r.startOffset : 0;
    let e = i === r.endItem ? r.endOffset : str.length;
    while (s < e && isWs(str[s])) s++;
    while (e > s && isWs(str[e - 1])) e--;
    if (s >= e) continue;
    let x1 = Infinity,
      y1 = Infinity,
      x2 = -Infinity,
      y2 = -Infinity;
    for (let j = s; j < e; j++) {
      const a = box[j * 4];
      if (Number.isNaN(a)) {
        if (isWs(str[j])) continue;
        return null;
      }
      x1 = Math.min(x1, a);
      y1 = Math.min(y1, box[j * 4 + 1]);
      x2 = Math.max(x2, box[j * 4 + 2]);
      y2 = Math.max(y2, box[j * 4 + 3]);
    }
    if (x1 === Infinity) return null;
    const horizontal = isHorizontal(item.transform);
    const ext = itemExtent(box);
    if (ext) {
      if (horizontal) [y1, y2] = [ext[1], ext[3]];
      else [x1, x2] = [ext[0], ext[2]];
    }
    out.push({ rect: [x1, y1, x2, y2], horizontal });
  }
  return mergeRuns(out);
}

/**
 * 合并同一行上相接的矩形。横排：纵向重叠过半且横向间隙小于行高；竖排反之。
 * 输入按文本顺序排列，只与前一个矩形比较。
 */
function mergeRuns(runs: { rect: PdfRect; horizontal: boolean }[]): PdfRect[] {
  const rects: PdfRect[] = [];
  let prevHorizontal: boolean | null = null;
  for (const { rect, horizontal } of runs) {
    const prev = rects[rects.length - 1];
    if (prev && prevHorizontal === horizontal && sameLine(prev, rect, horizontal)) {
      prev[0] = Math.min(prev[0], rect[0]);
      prev[1] = Math.min(prev[1], rect[1]);
      prev[2] = Math.max(prev[2], rect[2]);
      prev[3] = Math.max(prev[3], rect[3]);
    } else {
      rects.push([...rect] as PdfRect);
    }
    prevHorizontal = horizontal;
  }
  return rects;
}

function sameLine(a: PdfRect, b: PdfRect, horizontal: boolean): boolean {
  // 横排：交叉轴为 y，行进轴为 x；竖排反之
  const [c1, c2, m1, m2] = horizontal ? [1, 3, 0, 2] : [0, 2, 1, 3];
  const ha = a[c2] - a[c1];
  const hb = b[c2] - b[c1];
  const overlap = Math.min(a[c2], b[c2]) - Math.max(a[c1], b[c1]);
  if (overlap < 0.5 * Math.min(ha, hb)) return false;
  const gap = Math.max(a[m1], b[m1]) - Math.min(a[m2], b[m2]);
  return gap < Math.min(ha, hb);
}

/** 文本层 DOM Range 兜底 */
function domRects(ctx: PageLayerContext, text: PageTextInfo, r: ItemRange): PdfRect[] {
  const a = locate(text.divs[r.startItem], r.startOffset, "start");
  const b = locate(text.divs[r.endItem], r.endOffset, "end");
  if (!a || !b) return [];
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return [];
  }
  // 屏幕方向：横排片段在旋转 90°/270° 的页面上竖着显示
  const horizontalOnScreen = isHorizontal(text.items[r.startItem]?.transform ?? [1, 0]) === (ctx.viewport.rotation % 180 === 0);
  const runs = [...range.getClientRects()]
    .filter((c) => c.width > 0.5 && c.height > 0.5)
    .map((c) => ({ rect: [c.left, c.top, c.right, c.bottom] as PdfRect, horizontal: horizontalOnScreen }));
  return mergeRuns(runs).map(([l, t, rr, bb]) => clientRectToPdf(ctx.viewport, ctx.pageEl, new DOMRect(l, t, rr - l, bb - t)));
}

/** 片段 span 内第 offset 个字符处的 DOM 位置（跨过词级校正的子 span） */
function locate(div: HTMLElement | undefined, offset: number, side: "start" | "end"): { node: Text; offset: number } | null {
  if (!div?.isConnected) return null;
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    // 起点落在两个文本节点交界处时取后一个，终点取前一个，避免多出一个空矩形
    if (side === "start" ? offset < acc + len : offset <= acc + len) return { node: n, offset: offset - acc };
    acc += len;
    last = n;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

// ---------------------------------------------------------------------------
// DOM 选区 → 规范化区间
// ---------------------------------------------------------------------------

const divIndexCache = new WeakMap<HTMLElement[], Map<HTMLElement, number>>();

function divIndex(text: PageTextInfo): Map<HTMLElement, number> {
  let m = divIndexCache.get(text.divs);
  if (!m) {
    m = new Map(text.divs.map((d, i) => [d, i]));
    divIndexCache.set(text.divs, m);
  }
  return m;
}

/** 文本节点所在的片段及其在片段内的起始偏移 */
function textNodePos(text: PageTextInfo, node: Text): { item: number; base: number } | null {
  const index = divIndex(text);
  let el: Node | null = node.parentNode;
  while (el && el !== text.layerEl && !index.has(el as HTMLElement)) el = el.parentNode;
  const item = el ? index.get(el as HTMLElement) : undefined;
  if (item === undefined) return null;
  const walker = document.createTreeWalker(el!, NodeFilter.SHOW_TEXT);
  let base = 0;
  for (let n = walker.nextNode(); n && n !== node; n = walker.nextNode()) base += (n as Text).data.length;
  return { item, base };
}

/** DOM 边界点 → (片段, 偏移)。边界不在文本节点上时，起点取其后第一个字符，终点取其前最后一个字符之后 */
function boundaryToItem(text: PageTextInfo, node: Node, offset: number, side: "start" | "end"): { item: number; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const p = textNodePos(text, node as Text);
    if (p) return { item: p.item, offset: p.base + offset };
  }
  const point = document.createRange();
  point.setStart(node, node.nodeType === Node.TEXT_NODE ? offset : Math.min(offset, node.childNodes.length));
  const walker = document.createTreeWalker(text.layerEl, NodeFilter.SHOW_TEXT);
  let found: { item: number; offset: number } | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (side === "start") {
      if (point.comparePoint(n, 0) >= 0) {
        const p = textNodePos(text, n);
        if (p) return { item: p.item, offset: p.base };
      }
    } else {
      if (point.comparePoint(n, n.data.length) > 0) break;
      const p = textNodePos(text, n);
      if (p) found = { item: p.item, offset: p.base + n.data.length };
    }
  }
  return found;
}

const realPosCache = new WeakMap<NormalizedText, Int32Array>();

/** 规范化文本中来自原文字符（非合成）的位置，按 (片段, 偏移) 单调递增 */
function realPositions(nt: NormalizedText): Int32Array {
  let pos = realPosCache.get(nt);
  if (!pos) {
    const tmp: number[] = [];
    for (let k = 0; k < nt.itemIndex.length; k++) if (nt.itemIndex[k] >= 0) tmp.push(k);
    pos = Int32Array.from(tmp);
    realPosCache.set(nt, pos);
  }
  return pos;
}

/** (片段, 偏移) → 第一个不早于它的规范化字符位置；没有则为文本长度 */
function itemPosToIndex(nt: NormalizedText, item: number, offset: number): number {
  const pos = realPositions(nt);
  let lo = 0;
  let hi = pos.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const k = pos[mid];
    const ii = nt.itemIndex[k];
    if (ii < item || (ii === item && nt.charOffset[k] < offset)) lo = mid + 1;
    else hi = mid;
  }
  return lo < pos.length ? pos[lo] : nt.text.length;
}

function trim(t: string, r: TextRange): TextRange {
  let { start, end } = r;
  while (start < end && isWs(t[start])) start++;
  while (end > start && isWs(t[end - 1])) end--;
  return { start, end };
}

/**
 * 片段 item 的字符区间 [startOffset, endOffset) → 规范化区间（去掉首尾空白）。
 * 区间内没有可见字符时返回 null。
 */
export function itemRangeToTextRange(ctx: PageLayerContext, item: number, startOffset: number, endOffset: number): TextRange | null {
  const text = ctx.text;
  if (!text) return null;
  return toTextRange(text, { item, offset: startOffset }, { item, offset: endOffset });
}

function toTextRange(text: PageTextInfo, a: { item: number; offset: number }, b: { item: number; offset: number }): TextRange | null {
  const nt = text.normalized;
  const s = itemPosToIndex(nt, a.item, a.offset);
  const e = itemPosToIndex(nt, b.item, b.offset);
  const r = trim(nt.text, { start: Math.min(s, e), end: Math.max(s, e) });
  return r.end > r.start ? r : null;
}

/**
 * DOM Range（如用户选区）→ 本页的规范化区间：裁剪到本页文本层，去掉首尾空白。
 * 不在本页或为空时返回 null。扫描件（OCR 层可能与图像错位）把端点吸附到最近的词边界。
 */
export function domRangeToTextRange(ctx: PageLayerContext, range: Range): TextRange | null {
  const text = ctx.text;
  if (!text) return null;
  const layer = text.layerEl;
  if (!layer.isConnected || !range.intersectsNode(layer)) return null;
  const startIn = layer.contains(range.startContainer);
  const endIn = layer.contains(range.endContainer);
  const a = startIn
    ? boundaryToItem(text, range.startContainer, range.startOffset, "start")
    : boundaryToItem(text, layer, 0, "start");
  const b = endIn
    ? boundaryToItem(text, range.endContainer, range.endOffset, "end")
    : boundaryToItem(text, layer, layer.childNodes.length, "end");
  if (!a || !b) return null;
  const r = toTextRange(text, a, b);
  if (!r || !text.scanned) return r;
  return snapToWords(text.normalized.text, r);
}

/** 吸附只在端点离词边界不超过这么多字符时进行，避免把半个长词或整句扩成一个"词" */
const SNAP_MAX = 2;

/**
 * 边界位置 i 是否落在词内部：两侧都是用空格分词的文字的字母/数字（拉丁、西里尔、数字等）。
 * 汉字、假名等每个字单独成词，标点、空白都是边界。
 */
function insideWord(t: string, i: number): boolean {
  if (i <= 0 || i >= t.length) return false;
  return isSpacedWordChar(codePointBeforeIndex(t, i)) && isSpacedWordChar(codePointAtIndex(t, i));
}

/** 位置 i 吸附到最近的词边界；离边界超过 SNAP_MAX 时不动 */
function snapIndex(t: string, i: number): number {
  if (!insideWord(t, i)) return i;
  let s = i;
  while (s > 0 && insideWord(t, s) && i - s <= SNAP_MAX) s--;
  let e = i;
  while (e < t.length && insideWord(t, e) && e - i <= SNAP_MAX) e++;
  const dl = insideWord(t, s) ? Infinity : i - s;
  const dr = insideWord(t, e) ? Infinity : e - i;
  if (Math.min(dl, dr) > SNAP_MAX) return i;
  return dl <= dr ? s : e;
}

/**
 * 端点吸附到最近的词边界（扫描件的 OCR 层可能与图像错位，选区端点常偏一两个字母）。
 * 只吸附离边界 ≤ 2 个字符的端点；汉字每个字单独成词；吸附后为空时保持原区间。
 */
export function snapToWords(t: string, r: TextRange): TextRange {
  const snapped = trim(t, { start: snapIndex(t, r.start), end: snapIndex(t, r.end) });
  return snapped.end > snapped.start ? snapped : trim(t, r);
}

// ---------------------------------------------------------------------------
// 指针坐标 → 文本偏移（拖选端点的精确判定）
// ---------------------------------------------------------------------------

/**
 * 页面上某一点（client 坐标）对应的规范化文本"边界"偏移：落在某个字形框内时，
 * 按点在字形前半还是后半（沿阅读方向）返回该字符之前或之后的位置；不在任何字形上（含空白）时返回 null。
 * 纵向用整个片段的范围判定（与高亮矩形一致）。需要字形映射（charBoxes），否则返回 null。
 */
export function textOffsetAtPoint(ctx: PageLayerContext, clientX: number, clientY: number): number | null {
  const text = ctx.text;
  const boxes = text?.charBoxes;
  if (!text || !boxes) return null;
  const origin = ctx.pageEl.getBoundingClientRect();
  const [px, py] = ctx.viewport.convertToPdfPoint(clientX - origin.left, clientY - origin.top);
  let best: { item: number; offset: number; d: number } | null = null;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const item = text.items[i];
    if (!box || !item) continue;
    const ext = itemExtent(box);
    if (!ext || px < ext[0] || px > ext[2] || py < ext[1] || py > ext[3]) continue;
    const t = item.transform;
    const horizontal = isHorizontal(t);
    // 沿阅读方向的坐标与方向（180° 文字从右往左）
    const p = horizontal ? px : py;
    const forward = horizontal ? t[0] >= 0 : t[1] >= 0;
    // 交叉轴上离片段中线的距离：重叠的片段（如 OCR 不可见副本）取更近的
    const d = horizontal ? Math.abs(py - (ext[1] + ext[3]) / 2) : Math.abs(px - (ext[0] + ext[2]) / 2);
    if (best && d >= best.d) continue;
    const str = item.str;
    for (let j = 0; j < str.length; j++) {
      const a = box[j * 4];
      if (Number.isNaN(a) || isWs(str[j])) continue;
      const lo = horizontal ? a : box[j * 4 + 1];
      const hi = horizontal ? box[j * 4 + 2] : box[j * 4 + 3];
      if (p < lo || p > hi) continue;
      const firstHalf = forward ? p < (lo + hi) / 2 : p >= (lo + hi) / 2;
      best = { item: i, offset: firstHalf ? j : j + 1, d };
      break;
    }
  }
  return best ? itemPosToIndex(text.normalized, best.item, best.offset) : null;
}

/**
 * 由拖选按下/抬起的指针位置直接得到区间（两端都命中字形时）。
 * 用途：Chromium 偶尔在某个精确的按下位置开始拖选时得不到选区（原生选区为空），可以用它兜底。
 */
export function textRangeFromPointer(
  ctx: PageLayerContext,
  down: { clientX: number; clientY: number },
  up: { clientX: number; clientY: number },
): TextRange | null {
  const text = ctx.text;
  if (!text) return null;
  const a = textOffsetAtPoint(ctx, down.clientX, down.clientY);
  const b = textOffsetAtPoint(ctx, up.clientX, up.clientY);
  if (a === null || b === null) return null;
  const r = trim(text.normalized.text, { start: Math.min(a, b), end: Math.max(a, b) });
  return r.end > r.start ? r : null;
}

/** 校正后与原生选区每一端最多相差的字符数 */
const REFINE_MAX = 2;

/**
 * 用拖选时按下/抬起的指针位置校正浏览器原生选区得到的区间：浏览器按文本层（替代字体近似排版）判定端点，
 * 紧贴字母拖选时偶尔多选/少选一个字母；字形命中测试是精确的。
 * 只有两端都命中字形、且与原区间每端相差不超过 2 个字符时才采用校正结果（反向拖选同样处理），否则原样返回。
 */
export function refineRangeByPointer(
  ctx: PageLayerContext,
  range: TextRange,
  down: { clientX: number; clientY: number },
  up: { clientX: number; clientY: number },
): TextRange {
  const r = textRangeFromPointer(ctx, down, up);
  if (!r) return range;
  if (Math.abs(r.start - range.start) > REFINE_MAX || Math.abs(r.end - range.end) > REFINE_MAX) return range;
  return r;
}
