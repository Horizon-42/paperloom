// 字形映射：重放页面 operator list 中的文本绘制指令，按 pdf.js canvas.js 的同一套状态机
// 算出每个字形的真实位置（PDF 用户空间），再与 getTextContent() 的片段逐字符对齐，
// 得到"片段 i 的第 j 个字符 → PDF 坐标矩形"。精度见 docs/decisions.md D1：
// 原生 PDF 上 p95 0.05 em，而 TextLayer + DOM Range 约 14% 的词边缘偏差 > 0.25 em。
//
// operator list 在渲染时通过 page.render({ operationsFilter }) 拿到（与 canvas 完全一致，零额外开销）。
// 注意：这里依赖 operator list 中字形对象的字段（unicode/width/isSpace/vmetric）和 canvas.js 的文本状态语义，
// 属于 pdf.js 内部实现，已锁定 pdfjs-dist 6.4.299，升级时先跑 tests/unit/viewer/glyphMap.test.ts。
import { OPS, normalizeUnicode } from "pdfjs-dist";

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m1: ArrayLike<number>, m2: ArrayLike<number>): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** operator list 的最小子集 */
export interface OperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

/** commonObjs 里字体对象（FontFaceObject）用到的字段 */
export interface FontLike {
  fontMatrix?: number[];
  vertical?: boolean;
  isType3Font?: boolean;
}

/** textContent.styles 中用到的字段 */
export interface FontStyleLike {
  ascent?: number;
  descent?: number;
}

/** 一个字形的前进框（advance box），PDF 用户空间，轴对齐 */
export interface RawGlyph {
  /** Unicode（按 normalize 参数决定是否规范化），可能为多字符（连字）或空串 */
  u: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 文本渲染模式 3/7（不可见，常见于 OCR 文字层） */
  invisible: boolean;
}

export interface GlyphExtractStats {
  glyphs: number;
  invisibleGlyphs: number;
  type3Glyphs: number;
  /** 竖排字形：未实现定位，不输出 */
  verticalGlyphs: number;
  /** 图片覆盖的页面面积比例（按面积累加，上限 1） */
  imageCoverage: number;
}

interface TextState {
  ctm: Mat;
  textMatrix: Mat;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  leading: number;
  charSpacing: number;
  wordSpacing: number;
  textHScale: number;
  textRise: number;
  fontSize: number;
  fontDirection: number;
  fontMatrix: ArrayLike<number>;
  font: FontLike | null;
  fontName: string;
  renderMode: number;
}

const DEFAULT_FONT_MATRIX = [0.001, 0, 0, 0.001, 0, 0];
/** 字形纵向范围（em）：基线以上 ascent、以下 descent 的上限 */
export const MAX_ASCENT = 0.95;
export const MIN_DESCENT = -0.3;
const NAN_BOX = { x1: NaN, y1: NaN, x2: NaN, y2: NaN };

function initialState(): TextState {
  return {
    ctm: IDENTITY,
    textMatrix: IDENTITY,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    leading: 0,
    charSpacing: 0,
    wordSpacing: 0,
    textHScale: 1,
    textRise: 0,
    fontSize: 0,
    fontDirection: 1,
    fontMatrix: DEFAULT_FONT_MATRIX,
    font: null,
    fontName: "",
    renderMode: 0,
  };
}

interface GlyphArg {
  unicode?: string;
  width?: number;
  isSpace?: boolean;
  vmetric?: number[];
}

export interface ExtractOptions {
  getFont: (loadedName: string) => FontLike | null;
  styles?: Record<string, FontStyleLike>;
  /** page.view，用于计算图片覆盖率 */
  view?: ArrayLike<number>;
  /** 必须等于 !getTextContent({ disableNormalization })：查看器关闭了规范化（保留 ﬁ），这里传 false */
  normalize: boolean;
}

/**
 * 重放文本指令，按绘制顺序返回所有字形的位置。
 * 跳过注释外观流（beginAnnotation…endAnnotation），因为 getTextContent 不包含它们。
 */
export function extractGlyphs(opList: OperatorListLike, opts: ExtractOptions): { glyphs: RawGlyph[]; stats: GlyphExtractStats } {
  const { getFont, styles = {}, view, normalize } = opts;
  const glyphs: RawGlyph[] = [];
  const stats: GlyphExtractStats = { glyphs: 0, invisibleGlyphs: 0, type3Glyphs: 0, verticalGlyphs: 0, imageCoverage: 0 };
  const pageArea = view ? Math.abs((view[2] - view[0]) * (view[3] - view[1])) : 0;
  const normCache = new Map<string, string>();
  const norm = (s: string): string => {
    if (!normalize) return s;
    let v = normCache.get(s);
    if (v === undefined) {
      v = (normalizeUnicode(s) as string | undefined) ?? s;
      normCache.set(s, v);
    }
    return v;
  };

  let st = initialState();
  const stack: TextState[] = [];
  let annotDepth = 0;

  const setFont = (name: string, size: number) => {
    const font = getFont(name);
    st.font = font;
    st.fontName = name;
    st.fontMatrix = font?.fontMatrix ?? DEFAULT_FONT_MATRIX;
    st.fontSize = Math.abs(size);
    st.fontDirection = size < 0 ? -1 : 1;
  };
  const moveText = (x: number, y: number) => {
    st.x = st.lineX += x;
    st.y = st.lineY += y;
  };

  const showText = (arr: (GlyphArg | number)[]) => {
    const { font, fontSize, fontDirection } = st;
    if (!font || fontSize === 0) return;
    const isType3 = !!font.isType3Font;
    const vertical = !!font.vertical;
    const textHScale = st.textHScale * fontDirection;
    const spacingDir = vertical ? 1 : -1;
    const invisible = (st.renderMode & 3) === 3;
    // canvas.js：渲染模式恰为 3 的 Type3 文字直接跳过（不画、不推进）。textContent 仍包含这些字符，
    // 所以照样放进字形流保持对齐，但没有位置
    if (isType3 && st.renderMode === 3) {
      for (const g of arr) {
        if (typeof g === "number") continue;
        glyphs.push({ u: norm(g.unicode ?? ""), ...NAN_BOX, invisible: true });
        stats.glyphs++;
        stats.invisibleGlyphs++;
        stats.type3Glyphs++;
      }
      return;
    }
    const style = styles[st.fontName];
    // ascent/descent 只用来给出纵向范围（高亮高度、命中测试）。部分字体（Elsevier、中文字体）给的值
    // 远超字形实际高度（1.2 / -0.44 em），跨行高亮会与相邻行重叠，所以上限收紧到 0.95 / -0.3 em
    const ascent = style?.ascent && style.ascent > 0.3 ? Math.min(style.ascent, MAX_ASCENT) : 0.8;
    const descent = style?.descent && style.descent < 0 ? Math.max(style.descent, MIN_DESCENT) : -0.2;
    // 文本空间 → PDF 用户空间（m 已含 textHScale，下面的 x 是未缩放的文本空间前进量）
    const m = mul(mul(st.ctm, st.textMatrix), [textHScale, 0, 0, 1, st.x, st.y + st.textRise]);
    // 负字号 = 旋转 180°，字形朝下
    const yTop = ascent * fontSize * fontDirection;
    const yBot = descent * fontSize * fontDirection;
    const fm0 = st.fontMatrix[0];
    const widthAdvanceScale = fontSize * fm0;
    let x = 0;
    for (const g of arr) {
      if (typeof g === "number") {
        x += (spacingDir * g * fontSize) / 1000;
        continue;
      }
      const spacing = (g.isSpace ? st.wordSpacing : 0) + st.charSpacing;
      if (vertical) {
        // 竖排：未实现定位。字形仍放进字形流（框为 NaN）保持与 textContent 对齐，调用方退回 DOM Range
        stats.verticalGlyphs++;
        glyphs.push({ u: norm(g.unicode ?? ""), ...NAN_BOX, invisible });
        stats.glyphs++;
        const w = g.vmetric ? -g.vmetric[0] : (g.width ?? 0);
        x += w * widthAdvanceScale - spacing * fontDirection;
        continue;
      }
      let adv: number;
      if (isType3) {
        stats.type3Glyphs++;
        // canvas.js：Util.applyTransform([width, 0], fontMatrix)[0]，含 fontMatrix 的平移
        adv = ((g.width ?? 0) * fm0 + (st.fontMatrix[4] ?? 0)) * fontSize;
      } else {
        adv = (g.width ?? 0) * widthAdvanceScale;
      }
      const xa = x;
      const xb = x + adv;
      // 4 个角点变换后取轴对齐包围盒
      const ax = m[0] * xa + m[2] * yBot + m[4];
      const ay = m[1] * xa + m[3] * yBot + m[5];
      const bx = m[0] * xb + m[2] * yBot + m[4];
      const by = m[1] * xb + m[3] * yBot + m[5];
      const cx = m[0] * xa + m[2] * yTop + m[4];
      const cy = m[1] * xa + m[3] * yTop + m[5];
      const dx = m[0] * xb + m[2] * yTop + m[4];
      const dy = m[1] * xb + m[3] * yTop + m[5];
      glyphs.push({
        u: norm(g.unicode ?? ""),
        x1: Math.min(ax, bx, cx, dx),
        y1: Math.min(ay, by, cy, dy),
        x2: Math.max(ax, bx, cx, dx),
        y2: Math.max(ay, by, cy, dy),
        invisible,
      });
      stats.glyphs++;
      if (invisible) stats.invisibleGlyphs++;
      x += isType3 ? adv + spacing : adv + spacing * fontDirection;
    }
    if (vertical) st.y -= x;
    else st.x += x * textHScale;
  };

  const { fnArray, argsArray } = opList;
  for (let i = 0, n = fnArray.length; i < n; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[] | null;
    if (annotDepth > 0) {
      if (fn === OPS.beginAnnotation) annotDepth++;
      else if (fn === OPS.endAnnotation) annotDepth--;
      continue;
    }
    switch (fn) {
      case OPS.beginAnnotation:
        annotDepth = 1;
        break;
      case OPS.save:
      case OPS.beginGroup:
        stack.push({ ...st });
        break;
      case OPS.restore:
      case OPS.endGroup:
        if (stack.length) st = stack.pop()!;
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push({ ...st });
        const matrix = args?.[0] as ArrayLike<number> | null;
        if (matrix) st.ctm = mul(st.ctm, matrix);
        break;
      }
      case OPS.paintFormXObjectEnd:
        if (stack.length) st = stack.pop()!;
        break;
      case OPS.transform:
        st.ctm = mul(st.ctm, args as unknown as ArrayLike<number>);
        break;
      case OPS.beginText:
        st.textMatrix = IDENTITY;
        st.x = st.lineX = 0;
        st.y = st.lineY = 0;
        break;
      case OPS.setFont:
        setFont(args![0] as string, args![1] as number);
        break;
      case OPS.setGState:
        for (const [key, value] of args![0] as [string, unknown][]) {
          if (key === "Font") {
            const v = value as [string, number];
            setFont(v[0], v[1]);
          }
        }
        break;
      case OPS.setTextMatrix: {
        // 矩阵可能是数组、Float32Array，或直接展开在 args 里
        const a0 = args![0];
        const mtx = (Array.isArray(a0) || ArrayBuffer.isView(a0) ? a0 : args) as ArrayLike<number>;
        st.textMatrix = [mtx[0], mtx[1], mtx[2], mtx[3], mtx[4], mtx[5]];
        st.x = st.lineX = 0;
        st.y = st.lineY = 0;
        break;
      }
      case OPS.moveText:
        moveText(args![0] as number, args![1] as number);
        break;
      case OPS.setLeadingMoveText:
        st.leading = args![1] as number;
        moveText(args![0] as number, args![1] as number);
        break;
      case OPS.setLeading:
        st.leading = -(args![0] as number);
        break;
      case OPS.nextLine:
        moveText(0, st.leading);
        break;
      case OPS.setCharSpacing:
        st.charSpacing = args![0] as number;
        break;
      case OPS.setWordSpacing:
        st.wordSpacing = args![0] as number;
        break;
      case OPS.setHScale:
        st.textHScale = (args![0] as number) / 100;
        break;
      case OPS.setTextRise:
        st.textRise = args![0] as number;
        break;
      case OPS.setTextRenderingMode:
        st.renderMode = args![0] as number;
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        showText(args![0] as (GlyphArg | number)[]);
        break;
      case OPS.nextLineShowText:
        moveText(0, st.leading);
        showText(args![0] as (GlyphArg | number)[]);
        break;
      case OPS.nextLineSetSpacingShowText:
        st.wordSpacing = args![0] as number;
        st.charSpacing = args![1] as number;
        moveText(0, st.leading);
        showText(args![2] as (GlyphArg | number)[]);
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
      case OPS.paintImageXObjectRepeat:
        if (pageArea > 0) {
          // 图片画在单位正方形里，面积 = |det(ctm)|；扫描件常被切成多条图片，按面积累加
          const c = st.ctm;
          stats.imageCoverage = Math.min(1, stats.imageCoverage + Math.abs(c[0] * c[3] - c[1] * c[2]) / pageArea);
        }
        break;
    }
  }
  return { glyphs, stats };
}

/** 文本片段的最小子集（与 TextItemLike 兼容）；transform/width 用于推算片段首尾空白的范围 */
export interface TextItemStrLike {
  str: string;
  transform?: number[];
  width?: number;
}

export interface GlyphAlignStats {
  /** 片段中非空白字符总数 */
  chars: number;
  /** 成功映射（有位置）的非空白字符数 */
  mapped: number;
  /** 对齐时为重新同步而跳过的字形数 */
  skippedGlyphs: number;
  resyncs: number;
}

const isWs = (c: string) => c.trim() === "";
/** 重新同步时要求接下来连续一致的字符数（可跨片段） */
const RESYNC_RUN = 4;
const LOOKAHEAD = 400;

/**
 * 把字形序列与 textContent 片段逐字符对齐。两者来自同一内容流、顺序一致，
 * 但 textContent 会插入/合并空格、丢弃页面外的字形；遇到不一致时向前查找重新同步。
 * 返回与 items 一一对应的 charBoxes：每字符 [x1, y1, x2, y2]，未映射为 NaN；
 * 空白字符取左右相邻已映射字符之间的空隙，片段首尾的空白按片段起点和宽度推算。
 */
export function alignGlyphs(glyphs: RawGlyph[], items: readonly TextItemStrLike[]): { charBoxes: Float32Array[]; stats: GlyphAlignStats } {
  const stats: GlyphAlignStats = { chars: 0, mapped: 0, skippedGlyphs: 0, resyncs: 0 };
  // 去掉空白字形，展开成"字形字符流"：每个字符记录所属字形及其在字形内的序号
  const flatChar: string[] = [];
  const flatGlyph: number[] = [];
  const flatSub: number[] = [];
  const flatLen: number[] = [];
  for (let g = 0; g < glyphs.length; g++) {
    const u = glyphs[g].u;
    if (!u || isWs(u)) continue;
    for (let k = 0; k < u.length; k++) {
      flatChar.push(u[k]);
      flatGlyph.push(g);
      flatSub.push(k);
      flatLen.push(u.length);
    }
  }
  // 片段一侧也展开成一条"文本字符流"（只含非空白字符），重新同步时可以跨片段比较
  const textItem: number[] = [];
  const textPos: number[] = [];
  items.forEach((it, i) => {
    for (let j = 0; j < it.str.length; j++) {
      if (isWs(it.str[j])) continue;
      textItem.push(i);
      textPos.push(j);
    }
  });
  const T = textItem.length;
  const F = flatChar.length;
  const textChar = (q: number) => items[textItem[q]].str[textPos[q]];
  const charBoxes = items.map((it) => new Float32Array(it.str.length * 4).fill(NaN));
  stats.chars = T;

  const assign = (box: Float32Array, j: number, f: number) => {
    const g = glyphs[flatGlyph[f]];
    if (Number.isNaN(g.x1)) return false;
    const len = flatLen[f];
    if (len === 1) {
      box[j * 4] = g.x1;
      box[j * 4 + 1] = g.y1;
      box[j * 4 + 2] = g.x2;
      box[j * 4 + 3] = g.y2;
    } else {
      // 一个字形对应多个字符（规范化展开的连字）：按字符数等分前进量（假设横排）
      const w = (g.x2 - g.x1) / len;
      const sub = flatSub[f];
      box[j * 4] = g.x1 + w * sub;
      box[j * 4 + 1] = g.y1;
      box[j * 4 + 2] = g.x1 + w * (sub + 1);
      box[j * 4 + 3] = g.y2;
    }
    return true;
  };

  let cur = 0;
  for (let q = 0; q < T; q++) {
    const c = textChar(q);
    let f = -1;
    if (cur < F && flatChar[cur] === c) f = cur;
    else {
      // 重新同步：在前方找一个位置，使接下来 need 个字符（可跨片段）都一致
      const need = Math.min(RESYNC_RUN, T - q);
      for (let k = cur; k < Math.min(F, cur + LOOKAHEAD); k++) {
        if (flatChar[k] !== c) continue;
        let ok = true;
        for (let r = 1; r < need && ok; r++) ok = k + r < F && flatChar[k + r] === textChar(q + r);
        if (ok) {
          f = k;
          break;
        }
      }
      if (f >= 0) {
        stats.resyncs++;
        stats.skippedGlyphs += f - cur;
      }
    }
    // 找不到：该字符保持 NaN，游标不动
    if (f < 0) continue;
    if (assign(charBoxes[textItem[q]], textPos[q], f)) stats.mapped++;
    cur = f + 1;
  }

  items.forEach((it, i) => fillWhitespace(it, charBoxes[i]));
  return { charBoxes, stats };
}

/** 空白字符没有字形：中间的取两侧字符之间的空隙，首尾的按片段起点和宽度推算（只处理横排片段） */
function fillWhitespace(it: TextItemStrLike, box: Float32Array) {
  const str = it.str;
  let first = -1;
  let last = -1;
  for (let j = 0; j < str.length; j++) {
    if (isWs(str[j]) || Number.isNaN(box[j * 4])) continue;
    if (first < 0) first = j;
    last = j;
  }
  for (let j = 0; j < str.length; j++) {
    if (!isWs(str[j])) continue;
    let l = j - 1;
    while (l >= 0 && (isWs(str[l]) || Number.isNaN(box[l * 4]))) l--;
    let r = j + 1;
    while (r < str.length && (isWs(str[r]) || Number.isNaN(box[r * 4]))) r++;
    if (l >= 0 && r < str.length) {
      box[j * 4] = Math.min(box[l * 4 + 2], box[r * 4]);
      box[j * 4 + 1] = Math.min(box[l * 4 + 1], box[r * 4 + 1]);
      box[j * 4 + 2] = Math.max(box[l * 4 + 2], box[r * 4]);
      box[j * 4 + 3] = Math.max(box[l * 4 + 3], box[r * 4 + 3]);
    }
  }
  const t = it.transform;
  if (!t || it.width === undefined || first < 0 || Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3 || t[0] === 0) return;
  // 横排：起点 t[4]，沿 x 方向（t[0] < 0 时为 180° 文字，向左排）
  const dir = t[0] > 0 ? 1 : -1;
  const start = t[4];
  const end = t[4] + dir * it.width;
  const y1 = box[first * 4 + 1];
  const y2 = box[first * 4 + 3];
  const set = (j: number, a: number, b: number) => {
    if (!(Math.abs(b - a) > 0)) return;
    box[j * 4] = Math.min(a, b);
    box[j * 4 + 1] = y1;
    box[j * 4 + 2] = Math.max(a, b);
    box[j * 4 + 3] = y2;
  };
  // 开头的空白：片段起点 → 第一个字符的前沿；结尾的空白：最后一个字符的后沿 → 片段终点
  const lead = dir > 0 ? box[first * 4] : box[first * 4 + 2];
  const trail = dir > 0 ? box[last * 4 + 2] : box[last * 4];
  const leading = [] as number[];
  for (let j = 0; j < first; j++) if (isWs(str[j])) leading.push(j);
  const trailing = [] as number[];
  for (let j = last + 1; j < str.length; j++) if (isWs(str[j])) trailing.push(j);
  // 多个连续空白均分
  leading.forEach((j, k) => set(j, start + ((lead - start) * k) / leading.length, start + ((lead - start) * (k + 1)) / leading.length));
  trailing.forEach((j, k) => set(j, trail + ((end - trail) * k) / trailing.length, trail + ((end - trail) * (k + 1)) / trailing.length));
}

/**
 * 扫描件 + OCR 隐形文字层：大部分字形不可见且页面大部分被图片覆盖。
 * 没有文字但整页是图片（纯扫描）也算，界面可提示"无文字层"。
 */
export function isScannedPage(stats: GlyphExtractStats): boolean {
  if (stats.imageCoverage <= 0.5) return false;
  return stats.glyphs === 0 || stats.invisibleGlyphs > stats.glyphs * 0.5;
}

export interface PageGlyphMap {
  /** 与 items 一一对应，每字符 [x1, y1, x2, y2]（PDF 用户空间，y 向上），未映射为 NaN */
  charBoxes: Float32Array[];
  scanned: boolean;
  extract: GlyphExtractStats;
  align: GlyphAlignStats;
  ms: number;
}

/** operator list + textContent → 每个片段每个字符的 PDF 矩形 */
export function buildPageGlyphMap(
  opList: OperatorListLike,
  commonObjs: { has(id: string): boolean; get(id: string): unknown },
  items: readonly TextItemStrLike[],
  opts: { styles?: Record<string, FontStyleLike>; view?: ArrayLike<number>; normalize: boolean },
): PageGlyphMap {
  const t0 = performance.now();
  const getFont = (name: string) => (commonObjs.has(name) ? (commonObjs.get(name) as FontLike) : null);
  const { glyphs, stats } = extractGlyphs(opList, { getFont, ...opts });
  const { charBoxes, stats: align } = alignGlyphs(glyphs, items);
  return { charBoxes, scanned: isScannedPage(stats), extract: stats, align, ms: performance.now() - t0 };
}

/**
 * 渲染时捕获 operator list：把 operationsFilter 传给 page.render()。
 * 回调拿到的是该页渲染意图共用的 operator list 对象，渲染成功完成后它是完整的；
 * 渲染被取消时可能不完整，不能使用。
 */
export function captureOperatorList() {
  let captured: OperatorListLike | null = null;
  return {
    operationsFilter: (_i: number, ol: OperatorListLike) => {
      captured = ol;
      return true;
    },
    get: () => captured,
  };
}
