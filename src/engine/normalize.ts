// 第 6 节第 1 步：把 pdf.js 文本片段拼接成规范化整页文本，并记录逐字符偏移映射。
// 规则：连字展开、特殊空白视为空格、零宽字符删除、行尾连字符合并、空白压缩、
// 同行间隔补空格、换行补空格、跨栏等大跳跃插入硬边界 "\n"（合成字符，术语表面形式永不含 "\n"）。
import type { ItemRange, NormalizedText, TextItemLike } from "./types";

// ---------------------------------------------------------------------------
// 字符分类
// ---------------------------------------------------------------------------

const F_LETTER = 1;
const F_LOWER = 2;
const F_UPPER = 4;
/** 字母、数字或组合附加符号 */
const F_WORD = 8;
/** 汉字、假名、注音：不用空格分词 */
const F_CJK = 16;
/** 谚文：用空格分词，但助词直接附在词后（"LSTM은"），所以不阻挡相邻术语 */
const F_HANGUL = 32;
/** 中日文标点与全角符号：换行时与 CJK 字符直接相连 */
const F_CJK_PUNCT = 64;
const F_COMPUTED = 128;

const RE_LETTER = /\p{L}/u;
const RE_LOWER = /\p{Ll}/u;
const RE_UPPER = /[\p{Lu}\p{Lt}]/u;
const RE_WORD = /[\p{L}\p{N}\p{M}]/u;
const RE_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u;
const RE_HANGUL = /\p{Script=Hangul}/u;

const bmpFlags = new Uint8Array(0x10000);

function computeFlags(cp: number): number {
  if (cp < 0x80) {
    if (cp >= 0x61 && cp <= 0x7a) return F_LETTER | F_LOWER | F_WORD;
    if (cp >= 0x41 && cp <= 0x5a) return F_LETTER | F_UPPER | F_WORD;
    if (cp >= 0x30 && cp <= 0x39) return F_WORD;
    return 0;
  }
  if (cp >= 0xd800 && cp <= 0xdfff) return 0; // 孤立代理项
  const ch = String.fromCodePoint(cp);
  let f = 0;
  if (RE_LETTER.test(ch)) f |= F_LETTER;
  if (RE_LOWER.test(ch)) f |= F_LOWER;
  if (RE_UPPER.test(ch)) f |= F_UPPER;
  if (RE_WORD.test(ch)) f |= F_WORD;
  if (RE_CJK.test(ch)) f |= F_CJK;
  if (RE_HANGUL.test(ch)) f |= F_HANGUL;
  if ((cp >= 0x3001 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)) f |= F_CJK_PUNCT;
  return f;
}

function flagsOf(cp: number): number {
  if (cp < 0) return 0;
  if (cp < 0x10000) {
    let f = bmpFlags[cp];
    if (f === 0) {
      f = computeFlags(cp) | F_COMPUTED;
      bmpFlags[cp] = f;
    }
    return f;
  }
  return computeFlags(cp);
}

export function isLetter(cp: number): boolean {
  return (flagsOf(cp) & F_LETTER) !== 0;
}
export function isLowerLetter(cp: number): boolean {
  return (flagsOf(cp) & F_LOWER) !== 0;
}
export function isUpperLetter(cp: number): boolean {
  return (flagsOf(cp) & F_UPPER) !== 0;
}
/** 汉字、假名、注音（不含谚文） */
export function isCJK(cp: number): boolean {
  return (flagsOf(cp) & F_CJK) !== 0;
}
/**
 * "用空格分词的文字"的字母或数字（拉丁、希腊、西里尔字母、数字、组合附加符号等）。
 * 中日韩字符不算，因此 "使用LSTM模型" 里的 LSTM 两侧都视为词边界。
 */
export function isSpacedWordChar(cp: number): boolean {
  const f = flagsOf(cp);
  return (f & F_WORD) !== 0 && (f & (F_CJK | F_HANGUL)) === 0;
}
/** 换行时两侧都满足则直接相连、不补空格 */
function isCJKJoinable(cp: number): boolean {
  return (flagsOf(cp) & (F_CJK | F_CJK_PUNCT)) !== 0;
}

/** text 中 index 处的码点（index 越界返回 -1） */
export function codePointAtIndex(text: string, index: number): number {
  if (index < 0 || index >= text.length) return -1;
  return text.codePointAt(index)!;
}
/** text 中 index 之前的最后一个码点（index <= 0 返回 -1） */
export function codePointBeforeIndex(text: string, index: number): number {
  if (index <= 0 || index > text.length) return -1;
  const lo = text.charCodeAt(index - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && index >= 2) {
    const hi = text.charCodeAt(index - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return ((hi - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// 字符级映射（按 UTF-16 码元；需要处理的特殊字符都在 BMP 内）
// ---------------------------------------------------------------------------

// 0 = 原样保留
const K_SPACE = 1;
const K_DROP = 2;
const K_SOFT = 3; // U+00AD 软连字符：行尾视为连字符，其余位置删除
const K_MAP = 4;

const KIND = new Uint8Array(0x10000);
const REPLACE = new Map<number, string>();

for (const c of [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]) {
  KIND[c] = K_SPACE;
}
// 零宽字符、BOM、不可见数学运算符
for (const c of [0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff]) {
  KIND[c] = K_DROP;
}
KIND[0xad] = K_SOFT;
const MAPPINGS: [number, string][] = [
  [0xfb00, "ff"],
  [0xfb01, "fi"],
  [0xfb02, "fl"],
  [0xfb03, "ffi"],
  [0xfb04, "ffl"],
  [0xfb05, "st"],
  [0xfb06, "st"],
  [0x2010, "-"],
  [0x2011, "-"],
];
// 1:1 兼容映射（一个原字符 → 一个规范字符，偏移映射不变）。viewer 以 disableNormalization 取文本，
// 这里补上论文里常见的几类：全角字母数字与少数符号、上下标数字、µ 与希腊字母变体、字母类数学符号、弯单引号。
// 全角标点（，：；！？（）等）保持原样，以免影响中文匹配与边界判断。
for (let c = 0xff10; c <= 0xff19; c++) MAPPINGS.push([c, String.fromCharCode(c - 0xfee0)]);
for (let c = 0xff21; c <= 0xff3a; c++) MAPPINGS.push([c, String.fromCharCode(c - 0xfee0)]);
for (let c = 0xff41; c <= 0xff5a; c++) MAPPINGS.push([c, String.fromCharCode(c - 0xfee0)]);
// ＃＄％＆＊＋－＜＝＞＠＿｜
for (const c of [0xff03, 0xff04, 0xff05, 0xff06, 0xff0a, 0xff0b, 0xff0d, 0xff1c, 0xff1d, 0xff1e, 0xff20, 0xff3f, 0xff5c]) {
  MAPPINGS.push([c, String.fromCharCode(c - 0xfee0)]);
}
// 上下标数字与 ⁱ ⁿ
MAPPINGS.push([0x2070, "0"], [0x00b9, "1"], [0x00b2, "2"], [0x00b3, "3"], [0x2071, "i"], [0x207f, "n"]);
for (let c = 0x2074; c <= 0x2079; c++) MAPPINGS.push([c, String.fromCharCode(0x30 + c - 0x2070)]);
for (let c = 0x2080; c <= 0x2089; c++) MAPPINGS.push([c, String.fromCharCode(0x30 + c - 0x2080)]);
MAPPINGS.push(
  // µ（微符号）与希腊字母变体（LaTeX 的 \epsilon 输出 ϵ，用户通常输入 ε）
  [0x00b5, "μ"],
  [0x03d0, "β"],
  [0x03d1, "θ"],
  [0x03d5, "φ"],
  [0x03d6, "π"],
  [0x03f0, "κ"],
  [0x03f1, "ρ"],
  [0x03f4, "Θ"],
  [0x03f5, "ε"],
  // 欧姆、开尔文、埃符号 → 对应字母
  [0x2126, "Ω"],
  [0x212a, "K"],
  [0x212b, "Å"],
  // 字母类数学符号（ℓ1、ℝ、ℒ 等）
  [0x2102, "C"],
  [0x210a, "g"],
  [0x210b, "H"],
  [0x210c, "H"],
  [0x210d, "H"],
  [0x210e, "h"],
  [0x2110, "I"],
  [0x2111, "I"],
  [0x2112, "L"],
  [0x2113, "l"],
  [0x2115, "N"],
  [0x2119, "P"],
  [0x211a, "Q"],
  [0x211b, "R"],
  [0x211c, "R"],
  [0x211d, "R"],
  [0x2124, "Z"],
  [0x212c, "B"],
  [0x212d, "C"],
  [0x212f, "e"],
  [0x2130, "E"],
  [0x2131, "F"],
  [0x2133, "M"],
  [0x2134, "o"],
  // 弯单引号与修饰撇号 → '（Newton’s method）；双引号保持原样
  [0x2018, "'"],
  [0x2019, "'"],
  [0x201b, "'"],
  [0x02bc, "'"],
);
for (const [c, s] of MAPPINGS) {
  KIND[c] = K_MAP;
  REPLACE.set(c, s);
}

/** 需要替换的字符返回替换文本（连字为多个字符，其余 1:1），否则返回 undefined */
export function charReplacement(cu: number): string | undefined {
  return KIND[cu] === K_MAP ? REPLACE.get(cu) : undefined;
}

/** 只做字符替换（保留空白与换行），供 normalizeString 在处理换行规则前使用 */
function replaceChars(s: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    if (KIND[cu] !== K_MAP) continue;
    out += s.slice(from, i) + REPLACE.get(cu)!;
    from = i + 1;
  }
  return from === 0 ? s : out + s.slice(from);
}

const HYPHEN = 0x2d;
const SPACE = 0x20;
const NEWLINE = 0x0a;

// ---------------------------------------------------------------------------
// 小写副本：逐码点小写，长度变化（如 İ → i̇）时保留原字符，保证与原文逐字符对齐
// ---------------------------------------------------------------------------

const lowerBmp = new Uint16Array(0x10000);

function lowerOfBmp(c: number): number {
  let l = lowerBmp[c];
  if (l === 0) {
    const s = String.fromCharCode(c).toLowerCase();
    l = s.length === 1 ? s.charCodeAt(0) : c;
    lowerBmp[c] = l;
  }
  return l;
}

function codesToString(codes: ArrayLike<number>, n: number): string {
  let out = "";
  const CHUNK = 8192;
  for (let k = 0; k < n; k += CHUNK) {
    const end = Math.min(n, k + CHUNK);
    const part: number[] = new Array(end - k);
    for (let m = k; m < end; m++) part[m - k] = codes[m];
    out += String.fromCharCode.apply(null, part);
  }
  return out;
}

/** 与 NormalizedText.lower 相同的小写规则；不区分大小写的模式也必须用它转换 */
export function toLowerAligned(s: string): string {
  const n = s.length;
  // 快速路径：纯 ASCII 且没有大写字母
  let needs = false;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x41 && c <= 0x5a) || c >= 0x80) {
      needs = true;
      break;
    }
  }
  if (!needs) return s;
  const buf = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      buf[i] = c >= 0x41 && c <= 0x5a ? c + 32 : c;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        const pair = String.fromCharCode(c, lo);
        const l = pair.toLowerCase();
        if (l.length === 2) {
          buf[i] = l.charCodeAt(0);
          buf[i + 1] = l.charCodeAt(1);
        } else {
          buf[i] = c;
          buf[i + 1] = lo;
        }
        i++;
      } else {
        buf[i] = c;
      }
    } else {
      buf[i] = lowerOfBmp(c);
    }
  }
  return codesToString(buf, n);
}

// ---------------------------------------------------------------------------
// normalizeString：术语表面形式、批注引用等任意字符串
// ---------------------------------------------------------------------------

const HY = "[-\\u00AD\\u2010\\u2011]";
const NL = "[\\n\\r\\u2028\\u2029\\u0085]";
const HWS = "[^\\S\\n\\r\\u2028\\u2029]"; // 除换行外的空白
const CJK_JOIN =
  "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Bopomofo}\\u3001-\\u303F\\uFF00-\\uFFEF]";
const RE_LINE_HYPHEN_LOWER = new RegExp(`(\\p{L})${HY}${HWS}*${NL}\\s*(?=\\p{Ll})`, "gu");
const RE_LINE_HYPHEN_OTHER = new RegExp(`(\\p{L})${HY}${HWS}*${NL}\\s*(?=\\S)`, "gu");
const RE_CJK_LINE = new RegExp(`(${CJK_JOIN})${HWS}*${NL}\\s*(?=${CJK_JOIN})`, "gu");
const RE_HAS_NEWLINE = new RegExp(NL);

/**
 * 与页面文本一致的字符级规范化：连字展开、1:1 兼容映射（全角字母数字、µ 等）、特殊空白视为空格、
 * 零宽字符和软连字符删除、U+2010/U+2011 → "-"、连续空白压缩为一个空格并去掉首尾空白。
 * 字符串里若含真实换行（如 selection.toString()），也按页面规则处理行尾连字符和中文换行。
 */
export function normalizeString(s: string): string {
  if (!s) return "";
  if (RE_HAS_NEWLINE.test(s)) {
    // 先替换字符（全角字母等），再按页面规则处理行尾连字符和中文换行，与 normalizeItems 的判断依据一致
    s = replaceChars(s)
      .replace(RE_LINE_HYPHEN_LOWER, "$1")
      .replace(RE_LINE_HYPHEN_OTHER, "$1-")
      .replace(RE_CJK_LINE, "$1");
  }
  let out = "";
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    const k = KIND[cu];
    if (k === K_SPACE) {
      if (out.length > 0) pendingSpace = true;
      continue;
    }
    if (k === K_DROP || k === K_SOFT) continue;
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += k === K_MAP ? REPLACE.get(cu)! : s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 片段几何与边界分类
// ---------------------------------------------------------------------------

/** 片段之间的关系，数值越大分隔越强 */
const B_NONE = 0; // 同一行、紧挨着
const B_GAP = 1; // 同一行、有明显间隔 → 空格
const B_LINE = 2; // 正常换行 → 空格（行尾连字符、中文换行除外）
const B_HARD = 3; // 跨栏、跳到别的区域 → "\n"
type Boundary = typeof B_NONE | typeof B_GAP | typeof B_LINE | typeof B_HARD;

// 阈值都以字高为单位（当前行主字号与新片段字号中较大者）
const SAME_LINE_DY = 0.5; // 与当前行主基线相差在此以内视为同一行（含上下标、求和上下限）
const GAP_SPACE = 0.15; // 同行间隔超过此值补空格
const SHIFT_SPACE = 0.15; // 与前一片段基线偏移超过此值（上下标、脚注标记）也补空格，避免 "Transformer¹" 粘成一个词
const GAP_BACK = 1.0; // 同行向回跳超过此值（叠印、乱序）也补空格
const GAP_HARD = 1.5; // 同行间隔超过此值视为另一区域（栏间距、表格列）
const UP_JUMP = 1.0; // 向上跳超过此值：新栏或别的区域
const DOWN_JUMP = 3.0; // 向下跳超过此值：跨过图表、到脚注等
const RIGHT_JUMP = 1.0; // 新行起点在上一行右端之后超过此值
const LEFT_JUMP = 8.0; // 新行起点在本块（上次硬边界以来各行）左端之前超过此值

interface Geom {
  x: number;
  y: number;
  ux: number; // 书写方向单位向量
  uy: number;
  w: number; // 前进宽度
  h: number; // 字高
}

/** 当前行：书写方向、主基线（行内最大字号片段的基线）与沿书写方向的范围 */
interface LineState {
  ux: number;
  uy: number;
  baseT: number;
  h: number;
  minS: number;
  maxS: number;
  /** 上次硬边界以来所有行的最左端。行内公式（分式、上下限）可能让"行"在中途重新开始，用它判断左跳更稳 */
  blockMinS: number;
}

function geomOf(it: TextItemLike): Geom {
  const tr = it.transform ?? [];
  const a = tr[0] ?? 1;
  const b = tr[1] ?? 0;
  const c = tr[2] ?? 0;
  const d = tr[3] ?? 0;
  const len = Math.hypot(a, b);
  const ux = len > 0 ? a / len : 1;
  const uy = len > 0 ? b / len : 0;
  let h = Number.isFinite(it.height) && it.height > 0 ? it.height : Math.hypot(c, d);
  if (!(h > 0)) h = len;
  const w = Number.isFinite(it.width) ? Math.abs(it.width) : 0;
  return { x: tr[4] ?? 0, y: tr[5] ?? 0, ux, uy, w, h };
}

/** 在给定书写方向下的坐标：s 沿书写方向，t 垂直于书写方向（向上为正） */
function sOf(g: Geom, ux: number, uy: number): number {
  return g.x * ux + g.y * uy;
}
function tOf(g: Geom, ux: number, uy: number): number {
  return -g.x * uy + g.y * ux;
}

/** 开始新行；prev 为上一行（普通换行时延续其 blockMinS，硬边界时传 null） */
function lineOf(g: Geom, prev: LineState | null): LineState {
  const s = sOf(g, g.ux, g.uy);
  const blockMinS = prev ? Math.min(prev.blockMinS, s) : s;
  return { ux: g.ux, uy: g.uy, baseT: tOf(g, g.ux, g.uy), h: g.h, minS: s, maxS: s + g.w, blockMinS };
}

function extendLine(line: LineState, g: Geom): void {
  const s = sOf(g, line.ux, line.uy);
  if (s < line.minS) line.minS = s;
  if (s < line.blockMinS) line.blockMinS = s;
  if (s + g.w > line.maxS) line.maxS = s + g.w;
  if (g.h > line.h * 1.05) {
    // 行首是上标等小字时，以后出现的正文字号为准
    line.h = g.h;
    line.baseT = tOf(g, line.ux, line.uy);
  }
}

interface Classified {
  boundary: Boundary;
  /** 几何上仍在当前行（决定是扩展当前行还是开始新行） */
  sameLine: boolean;
}

/** p：上一个有内容的片段（属于 line）；c：当前片段；eol：两者之间出现过换行标记 */
function classify(p: Geom, c: Geom, line: LineState, eol: boolean): Classified {
  if (line.ux * c.ux + line.uy * c.uy < 0.9) return { boundary: B_HARD, sameLine: false }; // 书写方向变化（旋转的侧边水印等）
  const ref = Math.max(line.h, c.h);
  if (!(ref > 0)) return { boundary: eol ? B_LINE : B_NONE, sameLine: !eol };
  const { ux, uy } = line;
  const cS = sOf(c, ux, uy);
  const cT = tOf(c, ux, uy);
  const dLine = cT - line.baseT;
  if (Math.abs(dLine) <= SAME_LINE_DY * ref) {
    const along = cS - (sOf(p, ux, uy) + p.w);
    const shift = Math.abs(cT - tOf(p, ux, uy));
    let boundary: Boundary = B_NONE;
    if (along > GAP_HARD * ref) boundary = B_HARD;
    else if (eol || along > GAP_SPACE * ref || along < -GAP_BACK * ref || shift > SHIFT_SPACE * ref) boundary = B_GAP;
    // pdf.js 在求和上下限等回退处也会标 EOL；几何上同一行时只当作空格
    return { boundary, sameLine: boundary !== B_HARD };
  }
  if (dLine > UP_JUMP * ref || dLine < -DOWN_JUMP * ref) return { boundary: B_HARD, sameLine: false };
  if (cS > line.maxS + RIGHT_JUMP * ref || cS < line.blockMinS - LEFT_JUMP * ref) return { boundary: B_HARD, sameLine: false };
  return { boundary: B_LINE, sameLine: false };
}

// ---------------------------------------------------------------------------
// 拼接器：负责空白压缩、合成分隔符、行尾连字符
// ---------------------------------------------------------------------------

const SEP_NONE = 0;
const SEP_SPACE = 1;
const SEP_BREAK = 2;

class Builder {
  codes: number[] = [];
  items: number[] = [];
  offs: number[] = [];
  /** 待输出的分隔符：只有后面还有内容时才真正输出 */
  private pending = SEP_NONE;
  private pendingItem = -1;
  private pendingOff = -1;
  /** 最后一个输出字符是否来自行尾软连字符 */
  private lastSoft = false;

  /** 源文本中的空白字符 */
  space(item: number, off: number): void {
    if (this.codes.length === 0) return;
    if (this.pending === SEP_NONE) {
      this.pending = SEP_SPACE;
      this.pendingItem = item;
      this.pendingOff = off;
    } else if (this.pending === SEP_SPACE && this.pendingItem < 0) {
      // 已有合成空格时，优先保留真实空白的映射
      this.pendingItem = item;
      this.pendingOff = off;
    }
  }

  /** 新片段的第一个内容字符输出前调用：决定与上一片段之间的分隔 */
  resolve(boundary: Boundary, firstCp: number): void {
    const n = this.codes.length;
    if (n === 0) {
      this.pending = SEP_NONE;
      return;
    }
    if (boundary >= B_LINE) {
      // 行尾连字符：字母 + "-" 结尾。
      // 下一行小写开头 → 删除连字符、直接相连（跨栏也是同一个词的续写）；
      // 普通换行、非小写开头 → 保留连字符并直接相连（Bi-/LSTM）；
      // 硬边界、非小写开头 → 保留连字符，照常插入 "\n"，不把无关区域粘在一起
      if (this.codes[n - 1] === HYPHEN && this.items[n - 1] >= 0 && isLetter(this.cpBefore(n - 1))) {
        this.lastSoft = false;
        if (isLowerLetter(firstCp)) {
          this.pop();
          this.clearPending();
          return;
        }
        if (boundary === B_LINE) {
          this.clearPending();
          return;
        }
      }
    } else if (this.lastSoft) {
      // 同一行内片段末尾的软连字符不可见；其后累积的空白也一并丢弃（"co­ " + "ntinue"）
      this.pop();
      this.clearPending();
      if (this.codes.length === 0) return;
    }
    if (boundary === B_LINE && isCJKJoinable(this.cpBefore(this.codes.length)) && isCJKJoinable(firstCp)) {
      this.clearPending(); // 中文换行不补空格
      return;
    }
    const sep = boundary === B_HARD ? SEP_BREAK : boundary === B_NONE ? SEP_NONE : SEP_SPACE;
    if (sep > this.pending) {
      this.pending = sep;
      if (sep === SEP_BREAK) {
        this.pendingItem = -1;
        this.pendingOff = -1;
      }
    }
  }

  put(code: number, item: number, off: number, soft = false): void {
    if (this.pending !== SEP_NONE) {
      if (this.pending === SEP_BREAK) this.push(NEWLINE, -1, -1);
      else this.push(SPACE, this.pendingItem, this.pendingOff);
      this.clearPending();
    }
    this.push(code, item, off);
    this.lastSoft = soft;
  }

  finish(): NormalizedText {
    const text = codesToString(this.codes, this.codes.length);
    return {
      text,
      lower: toLowerAligned(text),
      itemIndex: Int32Array.from(this.items),
      charOffset: Int32Array.from(this.offs),
    };
  }

  private push(code: number, item: number, off: number): void {
    this.codes.push(code);
    this.items.push(item);
    this.offs.push(off);
  }

  private pop(): void {
    this.codes.pop();
    this.items.pop();
    this.offs.pop();
    this.lastSoft = false;
  }

  private clearPending(): void {
    this.pending = SEP_NONE;
    this.pendingItem = -1;
    this.pendingOff = -1;
  }

  /** 输出缓冲中下标 idx 之前的码点 */
  private cpBefore(idx: number): number {
    if (idx <= 0) return -1;
    const lo = this.codes[idx - 1];
    if (lo >= 0xdc00 && lo <= 0xdfff && idx >= 2) {
      const hi = this.codes[idx - 2];
      if (hi >= 0xd800 && hi <= 0xdbff) return ((hi - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
    }
    return lo;
  }
}

/**
 * 第 6 节第 1 步：拼接并规范化一页的文本片段。
 * items 必须已过滤掉 TextMarkedContent，下标与 TextLayer.textDivs 一一对应。
 */
export function normalizeItems(items: TextItemLike[]): NormalizedText {
  const b = new Builder();
  let prev: Geom | null = null;
  let line: LineState | null = null;
  let eol = false; // 上一个内容片段之后是否出现过换行标记

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const str = typeof it.str === "string" ? it.str : "";

    // 最后一个内容字符（软连字符只有在这里才算连字符）
    let last = -1;
    for (let j = str.length - 1; j >= 0; j--) {
      const k = KIND[str.charCodeAt(j)];
      if (k !== K_SPACE && k !== K_DROP) {
        last = j;
        break;
      }
    }

    if (last < 0) {
      // 空字符串或纯空白片段：只贡献空白和换行标记，不参与几何判断
      for (let j = 0; j < str.length; j++) if (KIND[str.charCodeAt(j)] === K_SPACE) b.space(i, j);
      if (it.hasEOL) eol = true;
      continue;
    }

    const g = geomOf(it);
    let boundary: Boundary = B_NONE;
    if (prev && line) {
      const r = classify(prev, g, line, eol);
      boundary = r.boundary;
      if (r.sameLine) extendLine(line, g);
      else line = lineOf(g, r.boundary === B_HARD ? null : line);
    } else {
      line = lineOf(g, null);
    }

    let first = true;
    for (let j = 0; j < str.length; j++) {
      const cu = str.charCodeAt(j);
      const k = KIND[cu];
      if (k === K_SPACE) {
        b.space(i, j);
        continue;
      }
      if (k === K_DROP || (k === K_SOFT && j !== last)) continue;
      if (k === K_MAP) {
        const rep = REPLACE.get(cu)!;
        if (first) {
          b.resolve(boundary, rep.charCodeAt(0));
          first = false;
        }
        for (let m = 0; m < rep.length; m++) b.put(rep.charCodeAt(m), i, j);
        continue;
      }
      if (k === K_SOFT) {
        if (first) {
          b.resolve(boundary, HYPHEN);
          first = false;
        }
        b.put(HYPHEN, i, j, true);
        continue;
      }
      if (first) {
        b.resolve(boundary, cu >= 0xd800 && cu <= 0xdbff ? str.codePointAt(j)! : cu);
        first = false;
      }
      b.put(cu, i, j);
    }

    prev = g;
    eol = !!it.hasEOL;
  }
  return b.finish();
}

/**
 * 把已经规范化过的整页文本（如 PageText.text 缓存）包装成 NormalizedText，供 TermMatcher 使用。
 * 整段视为第 0 个片段，保留其中的硬边界 "\n"。
 */
export function fromNormalizedText(text: string): NormalizedText {
  const n = text.length;
  const charOffset = new Int32Array(n);
  for (let i = 0; i < n; i++) charOffset[i] = i;
  return { text, lower: toLowerAligned(text), itemIndex: new Int32Array(n), charOffset };
}

/**
 * 规范化区间 [start, end) → 文本片段区间。跳过两端的合成字符；
 * 区间端点落在连字展开字符中间时扩展到整个原字符。全是合成字符时返回 null。
 */
export function mapRangeToItems(nt: NormalizedText, start: number, end: number): ItemRange | null {
  const n = nt.itemIndex.length;
  let s = Math.max(0, Math.floor(start));
  let e = Math.min(n, Math.ceil(end)) - 1;
  while (s <= e && nt.itemIndex[s] < 0) s++;
  while (e >= s && nt.itemIndex[e] < 0) e--;
  if (s > e) return null;
  let startOffset = nt.charOffset[s];
  let endOffset = nt.charOffset[e] + 1;
  // 不拆开代理对
  const sc = nt.text.charCodeAt(s);
  if (sc >= 0xdc00 && sc <= 0xdfff && s > 0 && nt.itemIndex[s - 1] === nt.itemIndex[s] && nt.charOffset[s - 1] === startOffset - 1) {
    startOffset--;
  }
  const ec = nt.text.charCodeAt(e);
  if (ec >= 0xd800 && ec <= 0xdbff && e + 1 < n && nt.itemIndex[e + 1] === nt.itemIndex[e] && nt.charOffset[e + 1] === endOffset) {
    endOffset++;
  }
  return { startItem: nt.itemIndex[s], startOffset, endItem: nt.itemIndex[e], endOffset };
}
