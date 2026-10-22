// 生成测试用 PDF：npx tsx scripts/make-fixtures.ts
// 输出到 fixtures/，内容和元数据固定，重复运行得到相同的文件。
//   simple.pdf      10 页英文正文（Helvetica），多次出现 LSTM / Long Short-Term Memory 等术语
//   long.pdf        50 页，同样的正文，用于懒加载与滚动性能测试
//   two-column.pdf  双栏（Times-Roman），行尾连字符断词；第 1 页按栏顺序写入内容流，
//                   第 2 页按行交错写入（左栏一行、右栏一行），用于测试分栏排序
//   ligature.pdf    嵌入 Times New Roman 子集，正文含 ﬁ / ﬂ 等连字字符（U+FB01 等）
//   glyph-ops.pdf   字形映射回归：TJ 字距、Tc/Tw/Tz/Ts/Tm、Form XObject、Tr 3 不可见文字、
//                   扫描件（整页图片 + 不可见文字）、/Rotate 90 页、连字字体、
//                   负字号与 180° 文字、Type3 字体（含不可见、FontMatrix 平移）、竖排（Identity-V）、
//                   无文字层的纯扫描页
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  TextRenderingMode,
  beginText,
  concatTransformationMatrix,
  degrees,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  showText,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FIXED_DATE = new Date("2026-01-01T00:00:00Z");
const LETTER: [number, number] = [612, 792];
const LIGATURE_FONT = "/System/Library/Fonts/Supplemental/Times New Roman.ttf";

const PARAGRAPHS = [
  "Long Short-Term Memory (LSTM) networks are a class of recurrent neural networks designed to capture long-range dependencies in sequential data. Unlike a plain recurrent network, an LSTM maintains a cell state that is updated through input, forget and output gates.",
  "In air traffic management (ATM), trajectory prediction is a core function. Controllers rely on accurate forecasts of aircraft positions, and modern decision support tools increasingly combine physical models of the atmosphere with data-driven predictors such as LSTMs.",
  "We train a stacked LSTM on surveillance data and compare it with a Transformer encoder that uses multi-head self-attention. The Long Short-Term Memory baseline is surprisingly competitive on short horizons, while the transformer architecture performs better beyond ten minutes.",
  "Each training sequence contains position, altitude and ground speed sampled every five seconds. We normalise all features, remove outliers caused by radar artefacts, and split the dataset chronologically so that the evaluation period never overlaps with the training period.",
  "Ablation experiments show that removing the forget gate degrades accuracy by a large margin, which confirms that the gating mechanism of Long Short-Term Memory is essential. Bidirectional LSTM variants did not help, because future observations are unavailable at prediction time.",
  "Finally, we discuss limitations. The model ignores weather information and the intentions of pilots, and it is evaluated on a single region of airspace. Extending the approach to other regions, and combining it with physics-based models of the atmosphere, is left for future work.",
];

const TWO_COL_PARAGRAPHS = [
  "Transformer architectures have recently replaced recurrent networks in many sequence modelling tasks. The transformer relies entirely on self-attention, which computes interactions between all pairs of positions in a sequence and therefore captures long-range dependencies without recurrence.",
  "Nevertheless, recurrent models remain attractive for streaming applications. A Long Short-Term Memory network processes observations incrementally, maintaining a compact representation of the past, and its computational requirements grow linearly with sequence length rather than quadratically.",
  "Our experiments compare both families on trajectory prediction for commercial aircraft. We report displacement errors at several horizons, discuss computational requirements, and analyse failure cases where the transformer hallucinates manoeuvres that never occur in the surveillance recordings.",
  "Interestingly, hybrid architectures that combine convolutional feature extraction with recurrent aggregation achieve competitive performance while requiring considerably fewer parameters. These observations suggest that architectural inductive biases still matter in data-limited regimes.",
];

// ---------- 排版工具 ----------

interface WrapOptions {
  hyphenate?: boolean;
  hyphenLog?: string[];
}

// 允许断词的位置（按英文排版习惯手写，只覆盖正文用到的长单词）
const HYPHENATION = `trans-former trans-formers archi-tec-tures archi-tec-ture archi-tec-tural se-quence inter-ac-tions
there-fore de-pen-den-cies re-cur-rence re-cur-rent net-works stream-ing ap-pli-ca-tions at-trac-tive ob-ser-va-tions
in-cre-men-tally main-tain-ing com-pact rep-re-sen-ta-tion com-pu-ta-tional re-quire-ments quad-rat-i-cally ex-per-i-ments
tra-jec-tory pre-dic-tion com-mer-cial dis-place-ment hori-zons hal-lu-ci-nates ma-noeu-vres sur-veil-lance record-ings
in-ter-est-ingly con-vo-lu-tional ex-trac-tion ag-gre-ga-tion com-pet-i-tive per-for-mance con-sid-er-ably param-e-ters
sug-gest in-duc-tive regimes mod-el-ling at-ten-tion re-placed nev-er-the-less pro-cesses length lin-early analyse failure`;
const HYPHEN_MAP = new Map(
  HYPHENATION.split(/\s+/).map((w) => [w.replace(/-/g, "").toLowerCase(), w] as const),
);

function hyphenPoints(word: string): number[] {
  const pattern = HYPHEN_MAP.get(word.toLowerCase());
  if (!pattern) return [];
  const points: number[] = [];
  let n = 0;
  for (const ch of pattern) {
    if (ch === "-") points.push(n);
    else n++;
  }
  return points;
}

/** 按宽度折行；hyphenate 时把放不下的长单词在行尾用连字符拆开 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number, opts: WrapOptions = {}): string[] {
  const width = (s: string) => font.widthOfTextAtSize(s, size);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    const candidate = line ? `${line} ${word}` : word;
    if (width(candidate) <= maxWidth) {
      line = candidate;
      i++;
      continue;
    }
    if (opts.hyphenate && line) {
      const m = /^([A-Za-z]+)(.*)$/.exec(word);
      const breaks = m ? hyphenPoints(m[1]) : [];
      // 从靠后的断点往前试，取能放进本行的最长前缀
      for (let b = breaks.length - 1; b >= 0; b--) {
        const head = m![1].slice(0, breaks[b]);
        if (width(`${line} ${head}-`) <= maxWidth) {
          const tail = m![1].slice(breaks[b]) + m![2];
          lines.push(`${line} ${head}-`);
          opts.hyphenLog?.push(`${head}- / ${tail}`);
          words[i] = tail;
          line = "";
          break;
        }
      }
      if (!line) continue;
    }
    if (!line) {
      // 单词比整行还宽，硬放
      line = word;
      i++;
    }
    lines.push(line);
    line = "";
  }
  if (line) lines.push(line);
  return lines;
}

function setMeta(doc: PDFDocument, title: string) {
  doc.setTitle(title);
  doc.setAuthor("PaperLens Fixtures");
  doc.setSubject("Generated test document");
  doc.setProducer("PaperLens scripts/make-fixtures.ts");
  doc.setCreator("pdf-lib");
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
}

function footer(page: PDFPage, font: PDFFont, n: number) {
  const text = String(n);
  page.drawText(text, { x: (LETTER[0] - font.widthOfTextAtSize(text, 9)) / 2, y: 36, size: 9, font });
}

// ---------- simple.pdf / long.pdf ----------

async function makeSingleColumn(pages: number, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  setMeta(doc, title);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 72;
  const size = 11;
  const leading = 15;
  const maxWidth = LETTER[0] - 2 * margin;

  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage(LETTER);
    let y = LETTER[1] - margin;
    if (p === 1) {
      page.drawText(title, { x: margin, y, size: 18, font: bold });
      y -= 28;
      page.drawText("PaperLens Fixtures", { x: margin, y, size: 11, font: body, color: rgb(0.3, 0.3, 0.3) });
      y -= 30;
    }
    page.drawText(`${p}. Section ${p}`, { x: margin, y, size: 13, font: bold });
    y -= 22;
    // 每页 4 段，按页码轮换，保证术语在每页都出现
    for (let k = 0; k < 4; k++) {
      const para = PARAGRAPHS[(p + k) % PARAGRAPHS.length];
      const lines = wrap(para, body, size, maxWidth);
      if (y - lines.length * leading < margin + 20) break;
      for (const line of lines) {
        page.drawText(line, { x: margin, y, size, font: body });
        y -= leading;
      }
      y -= 8;
    }
    footer(page, body, p);
  }
  return doc.save({ useObjectStreams: false });
}

// ---------- two-column.pdf ----------

async function makeTwoColumn(log: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const title = "Recurrent and Attention Models: A Two-Column Study";
  setMeta(doc, title);
  const body = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const margin = 54;
  const gutter = 24;
  const colWidth = (LETTER[0] - 2 * margin - gutter) / 2;
  const size = 10;
  const leading = 12.5;

  for (let p = 1; p <= 2; p++) {
    const page = doc.addPage(LETTER);
    let top = LETTER[1] - margin;
    if (p === 1) {
      const tw = bold.widthOfTextAtSize(title, 16);
      page.drawText(title, { x: (LETTER[0] - tw) / 2, y: top, size: 16, font: bold });
      top -= 36;
    }
    // 两栏各自从不同的段落开始排，避免左右栏内容雷同
    const columnLines = (start: number, dir: 1 | -1) => {
      const out: string[] = [];
      const n = TWO_COL_PARAGRAPHS.length;
      for (let k = 0; k < 8; k++) {
        const para = TWO_COL_PARAGRAPHS[(((start + dir * k) % n) + n) % n];
        out.push(...wrap(para, body, size, colWidth, { hyphenate: true, hyphenLog: log }), "");
      }
      return out;
    };
    const perCol = Math.floor((top - margin - 20) / leading);
    const left = columnLines(p - 1, 1).slice(0, perCol);
    const right = columnLines(p + 1, -1).slice(0, perCol);
    const drawLine = (line: string, col: 0 | 1, row: number) => {
      if (line) page.drawText(line, { x: margin + col * (colWidth + gutter), y: top - row * leading, size, font: body });
    };
    if (p === 1) {
      left.forEach((l, r) => drawLine(l, 0, r));
      right.forEach((l, r) => drawLine(l, 1, r));
    } else {
      for (let r = 0; r < perCol; r++) {
        if (left[r] !== undefined) drawLine(left[r], 0, r);
        if (right[r] !== undefined) drawLine(right[r], 1, r);
      }
    }
    footer(page, body, p);
  }
  return doc.save({ useObjectStreams: false });
}

// ---------- ligature.pdf ----------

async function makeLigature(): Promise<{ bytes: Uint8Array; ligatures: string[] }> {
  const fontBytes = readFileSync(LIGATURE_FONT);
  const fk = fontkit.create(fontBytes);
  const candidates = ["ﬀ", "ﬁ", "ﬂ", "ﬃ", "ﬄ"]; // ﬀ ﬁ ﬂ ﬃ ﬄ
  const ligatures = candidates.filter((c) => fk.hasGlyphForCodePoint(c.codePointAt(0)!));
  if (!ligatures.includes("ﬁ") || !ligatures.includes("ﬂ")) {
    throw new Error(`${LIGATURE_FONT} 没有 ﬁ/ﬂ 字形`);
  }
  const has = (c: string) => ligatures.includes(c);
  const ff = has("ﬀ") ? "ﬀ" : "ff";
  const ffi = has("ﬃ") ? "ﬃ" : "ffi";
  const ffl = has("ﬄ") ? "ﬄ" : "ffl";

  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const title = "Ligature Handling in Scientiﬁc PDFs";
  setMeta(doc, title.replace("ﬁ", "fi"));
  // 关闭自动连字（liga），只有正文里显式写出的 ﬁ/ﬂ 才用连字字形，ToUnicode 映射到 U+FB01 等
  const font = await doc.embedFont(fontBytes, {
    subset: true,
    customName: "PLSUBS+TimesNewRomanPSMT",
    features: { liga: false, clig: false, dlig: false },
  });

  const paragraphs = [
    `The ﬁrst ﬁgure shows the ﬂow ﬁeld around a ﬁxed wing. A signiﬁcant inﬂuence of the ﬂap conﬁguration on the wake is visible, and the eﬀect is ampliﬁed at high angles of attack.`
      .replace("eﬀect", `e${ff}ect`),
    `Plain spellings are mixed in on purpose: first, field, flow and figure are typed without ligature characters, so that a matcher must treat “ﬁeld” and “field” as the same word.`,
    `Long Short-Term Memory (LSTM) models are eﬃcient ﬁlters for noisy measurements. An LSTM can be ﬁne-tuned on a small dataset, and its ﬂexibility makes it a popular choice for trajectory ﬁtting.`
      .replace("eﬃcient", `e${ffi}cient`),
    `The baﬄe experiment and the ﬁnal ﬂight test are described in Section 4, together with the identiﬁcation procedure and a brief ﬂutter analysis.`
      .replace("baﬄe", `ba${ffl}e`),
  ];

  const margin = 72;
  const size = 12;
  const leading = 17;
  const maxWidth = LETTER[0] - 2 * margin;
  for (let p = 1; p <= 2; p++) {
    const page = doc.addPage(LETTER);
    let y = LETTER[1] - margin;
    if (p === 1) {
      page.drawText(title, { x: margin, y, size: 18, font });
      y -= 34;
    }
    for (let k = 0; k < paragraphs.length * 2; k++) {
      const para = paragraphs[(k + p - 1) % paragraphs.length];
      const lines = wrap(para, font, size, maxWidth);
      if (y - lines.length * leading < margin + 20) break;
      for (const line of lines) {
        page.drawText(line, { x: margin, y, size, font });
        y -= leading;
      }
      y -= 10;
    }
    footer(page, font, p);
  }
  return { bytes: await doc.save({ useObjectStreams: false }), ligatures };
}


// ---------- glyph-ops.pdf ----------

/** 生成纯灰色 PNG（扫描件页面的"图片"），不依赖图像库 */
function grayPng(w: number, h: number, gray: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 灰度
  const raw = Buffer.alloc((w + 1) * h, gray);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0; // 每行的过滤类型
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 在页面上用底层指令写文字；ops 在 BT/ET 内、Tf 之后执行 */
function rawText(page: PDFPage, font: PDFFont, size: number, x: number, y: number, ops: PDFOperator[]) {
  const key = page.node.newFontDictionary(font.name, font.ref);
  page.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(key, size), setTextMatrix(1, 0, 0, 1, x, y), ...ops, endText(), popGraphicsState());
}

/** TJ：字符串与字距调整（千分之一 em，正数左移）交替 */
function tj(font: PDFFont, parts: (string | number)[], doc: PDFDocument): PDFOperator {
  const arr = doc.context.obj(parts.map((p) => (typeof p === "number" ? p : font.encodeText(p))));
  return PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [arr]);
}

async function makeGlyphOps(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  setMeta(doc, "Glyph Mapping Regression");
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const left = 72;
  const T = (f: PDFFont, s: string) => showText(f.encodeText(s));

  // 第 1 页：TJ 字距、Tc、Tw、Tz、Ts、Tm 缩放
  {
    const page = doc.addPage(LETTER);
    let y = 700;
    const line = (font: PDFFont, size: number, ops: PDFOperator[]) => {
      rawText(page, font, size, left, y, ops);
      y -= size * 2.4;
    };
    line(helv, 14, [T(helv, "Plain reference line with ordinary words")]);
    line(helv, 14, [tj(helv, ["K", 60, "erned wor", -40, "ds ", -250, "with ", 120, "adjustments ", -600, "between ", "tokens"], doc)]);
    line(helv, 14, [setCharacterSpacing(0.8), T(helv, "Character spacing applied across words")]);
    line(helv, 14, [setCharacterSpacing(-0.4), T(helv, "Negative character spacing tightens letters")]);
    line(helv, 14, [setWordSpacing(8), T(helv, "Word spacing widens every space gap")]);
    line(helv, 14, [setCharacterSqueeze(70), T(helv, "Horizontal scaling seventy percent")]);
    line(times, 14, [setCharacterSqueeze(130), T(times, "Horizontal scaling widened letters")]);
    line(times, 16, [
      T(times, "Baseline text "),
      setTextRise(6),
      T(times, "raised superscript "),
      setTextRise(-4),
      T(times, "lowered subscript "),
      setTextRise(0),
      T(times, "returns"),
    ]);
    // Tm 带缩放和平移，同一 BT 内用 Td 换行
    line(helv, 10, [setTextMatrix(1.4, 0, 0, 1.4, left, y), T(helv, "Scaled text matrix line"), moveText(0, -16), T(helv, "Second line after moveText")]);
  }

  // 第 2 页：Form XObject（另一文档的页面嵌入为表单，缩放和平移后绘制两次）
  {
    const src = await PDFDocument.create({ updateMetadata: false });
    const sp = src.addPage([400, 200]);
    const sf = await src.embedFont(StandardFonts.Helvetica);
    sp.drawText("Form object paragraph about trajectory prediction", { x: 20, y: 150, size: 14, font: sf });
    sp.drawText("Second form line mentions recurrent networks", { x: 20, y: 120, size: 14, font: sf });
    const [form] = await doc.embedPdf(await src.save());
    const page = doc.addPage(LETTER);
    page.drawText("Page with form objects", { x: left, y: 720, size: 16, font: helv });
    page.drawPage(form, { x: left, y: 450, xScale: 1.2, yScale: 1.2 });
    page.drawPage(form, { x: left + 40, y: 200, xScale: 0.8, yScale: 0.8 });
  }

  // 第 3 页：可见文字上叠一份 Tr 3 不可见副本（类似 OCR 文字层与图片重合）
  {
    const page = doc.addPage(LETTER);
    const lines = ["Visible words with invisible duplicate layer", "Another line checks hidden text alignment"];
    lines.forEach((t, k) => {
      const y = 700 - k * 30;
      page.drawText(t, { x: left, y, size: 14, font: times });
      rawText(page, times, 14, left, y, [setTextRenderingMode(TextRenderingMode.Invisible), T(times, t)]);
    });
  }

  // 第 4 页：扫描件——整页图片 + 不可见文字
  {
    const page = doc.addPage(LETTER);
    const img = await doc.embedPng(grayPng(16, 16, 236));
    page.drawImage(img, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
    ["Scanned page with an invisible OCR layer", "Selecting words here snaps to word boundaries"].forEach((t, k) => {
      rawText(page, times, 14, left, 700 - k * 30, [setTextRenderingMode(TextRenderingMode.Invisible), T(times, t)]);
    });
  }

  // 第 5 页：/Rotate 90
  {
    const page = doc.addPage(LETTER);
    page.setRotation(degrees(90));
    page.drawText("Rotated page heading text", { x: left, y: 700, size: 18, font: helv });
    page.drawText("Body line on a rotated page for jump tests", { x: left, y: 400, size: 14, font: helv });
    // 页面中部的一个 cm 变换（旋转 0，平移）验证 transform 叠加
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 0, -200));
    page.drawText("Translated line under transform", { x: left, y: 400, size: 14, font: helv });
    page.pushOperators(popGraphicsState());
  }

  // 第 6 页：连字字体（ﬁ / ﬂ），并叠加 Tc
  {
    const tnr = await doc.embedFont(readFileSync(LIGATURE_FONT), {
      subset: true,
      customName: "PLSUBS+TimesNewRomanPSMT",
      features: { liga: false, clig: false, dlig: false },
    });
    const page = doc.addPage(LETTER);
    page.drawText("The ﬁrst ﬁgure shows ﬂow ﬁelds around ﬁxed wings", { x: left, y: 700, size: 16, font: tnr });
    rawText(page, tnr, 16, left, 660, [setCharacterSpacing(1), T(tnr, "Spaced ﬁnal ﬂight conﬁguration")]);
  }

  // 第 7 页：负字号（等价于旋转 180°）与 Tm 旋转 180° 的文字
  {
    const page = doc.addPage(LETTER);
    page.drawText("Upright reference line above", { x: left, y: 720, size: 14, font: helv });
    rawText(page, helv, -16, 500, 640, [T(helv, "Negative font size words")]);
    rawText(page, times, 16, 0, 0, [setTextMatrix(-1, 0, 0, -1, 500, 560), T(times, "Rotated half turn text")]);
  }

  // 第 8 页：Type3 字体。字形是矩形，墨迹即字形框；A/B/C 宽 600，空格 300
  {
    const ctx = doc.context;
    const proc = (w: number, x1: number, x2: number) => ctx.register(ctx.stream(`${w} 0 ${x1} 0 ${x2} 700 d1\n${x1} 0 ${x2 - x1} 700 re f`));
    const charProcs = ctx.obj({
      A: proc(600, 60, 540),
      B: proc(600, 80, 520),
      C: proc(600, 100, 500),
      space: ctx.register(ctx.stream("300 0 0 0 0 0 d1")),
    });
    const type3 = (fontMatrix: number[]) =>
      ctx.register(
        ctx.obj({
          Type: "Font",
          Subtype: "Type3",
          FontBBox: [0, 0, 600, 700],
          FontMatrix: fontMatrix,
          CharProcs: charProcs,
          Encoding: ctx.obj({ Type: "Encoding", Differences: [32, "space", 33, 65, "A", "B", "C"] }),
          FirstChar: 32,
          LastChar: 67,
          Widths: [300, ...Array(32).fill(0), 600, 600, 600],
          Resources: ctx.obj({}),
        }),
      );
    const page = doc.addPage(LETTER);
    const plain = page.node.newFontDictionary("T3a", type3([0.001, 0, 0, 0.001, 0, 0]));
    const shifted = page.node.newFontDictionary("T3b", type3([0.001, 0, 0, 0.001, 0.02, 0]));
    const hex = (s: string) => helv.encodeText(s); // WinAnsi 编码与这里的 Differences 一致（A=65, 空格=32）
    const bt = (font: PDFName, size: number, x: number, y: number, ops: PDFOperator[]) =>
      page.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(font, size), setTextMatrix(1, 0, 0, 1, x, y), ...ops, endText(), popGraphicsState());
    page.drawText("Type3 glyph boxes below", { x: left, y: 730, size: 14, font: helv });
    bt(plain, 20, left, 680, [showText(hex("ABC CAB BCA ACB"))]);
    // 同一 BT 内：不可见的 Type3 文字（canvas 不画也不推进）后接可见文字
    bt(plain, 20, left, 630, [setTextRenderingMode(TextRenderingMode.Invisible), showText(hex("CCC ")), setTextRenderingMode(TextRenderingMode.Fill), showText(hex("BAC CBA"))]);
    // FontMatrix 带平移：每个字形的前进量多 0.02 × 字号
    bt(shifted, 20, left, 580, [showText(hex("CAB ABC BBA"))]);
  }

  // 第 9 页：竖排（Identity-V），其后接横排文字，检查字形流仍然对齐
  {
    const vfont = await doc.embedFont(readFileSync(LIGATURE_FONT), {
      subset: true,
      customName: "PLSUBS+TimesNewRomanPSMT-V",
      features: { liga: false },
    });
    const page = doc.addPage(LETTER);
    page.drawText("Horizontal line before vertical text", { x: left, y: 740, size: 14, font: helv });
    rawText(page, vfont, 16, 300, 700, [T(vfont, "Vertical")]);
    page.drawText("Horizontal line after vertical text", { x: left, y: 300, size: 14, font: helv });
    // 把这个字体改成竖排编码（pdf-lib 默认 Identity-H）
    await vfont.embed();
    doc.context.lookup(vfont.ref, PDFDict).set(PDFName.of("Encoding"), PDFName.of("Identity-V"));
  }

  // 第 10 页：纯扫描（整页图片，没有文字层）
  {
    const page = doc.addPage(LETTER);
    const img = await doc.embedPng(grayPng(16, 16, 230));
    page.drawImage(img, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
  }
  return doc.save({ useObjectStreams: false });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const write = (name: string, bytes: Uint8Array) => {
    writeFileSync(join(OUT, name), bytes);
    console.log(`fixtures/${name}  ${(bytes.length / 1024).toFixed(1)} KB`);
  };
  write("simple.pdf", await makeSingleColumn(10, "Recurrent Models for Trajectory Prediction"));
  write("long.pdf", await makeSingleColumn(50, "Recurrent Models for Trajectory Prediction (Long)"));
  const hyphens: string[] = [];
  write("two-column.pdf", await makeTwoColumn(hyphens));
  console.log(`  行尾断词 ${hyphens.length} 处：${[...new Set(hyphens)].join("，")}`);
  const lig = await makeLigature();
  write("ligature.pdf", lig.bytes);
  write("glyph-ops.pdf", await makeGlyphOps());
  console.log(`  连字字形：${lig.ligatures.join(" ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
