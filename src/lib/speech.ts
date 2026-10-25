// 朗读用的纯函数：分句、判断语言、挑选语音（D19）。不碰 speechSynthesis 本身，方便测试。

export interface Span {
  start: number;
  end: number;
}

/** 句末：英文句号/问号/叹号后跟空白，或中文句末标点 */
// i18n-ignore: 中文标点是分句规则，不是界面文字
const SENTENCE_END = /[.!?](?=\s)|[。！？；]|\n{2,}/g;
/** 一句太长时（公式、列表）在这些地方再切开：部分浏览器朗读长句十几秒后会中断 */
// i18n-ignore: 中文标点是分句规则，不是界面文字
const SOFT_BREAK = /[,;:，；：、](?=\s?)/g;
/** 一段最多这么多字：英文约 15 秒；中文一个字读得慢得多，单独限制 */
const MAX_LATIN = 220;
const MAX_HAN = 70;

/** 论文里常见、后面不断句的缩写 */
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|et al|cf|vs|etc|fig|figs|eq|eqs|sec|tab|ref|refs|no|approx|resp|al)$/i;

/** 这个句点不是句末：缩写（e.g.、Fig.）或行首的小节、列表编号（"1. Introduction"、"3.2. Method"；"Table 3. We" 照常断句） */
function notSentenceEnd(text: string, dot: number): boolean {
  const before = text.slice(Math.max(0, dot - 12), dot);
  if (ABBREV.test(before)) return true;
  return /(?:^|\n)\s*\d{1,2}(?:\.\d{1,2})*$/.test(text.slice(Math.max(0, dot - 12 - 1), dot)) && /\d$/.test(before);
}

/** 这一段允许的最大长度：以汉字为主时短得多 */
function maxLen(text: string, s: number, e: number): number {
  const seg = text.slice(s, e);
  const han = seg.match(/\p{Script=Han}/gu)?.length ?? 0;
  return han * 2 > seg.length ? MAX_HAN : MAX_LATIN;
}

/** 把文字切成句子（下标区间，去掉两端空白，跳过空句）。太长的句子在逗号等处再切 */
export function splitSentences(text: string): Span[] {
  const out: Span[] = [];
  const push = (s: number, e: number) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ start: s, end: e });
  };
  const pushSplit = (s: number, e: number) => {
    const max = maxLen(text, s, e);
    let from = s;
    while (e - from > max) {
      // 在限度以内最后一个逗号等处切；没有（或太靠前）时在最后一个空白处切；再没有就硬切
      let cut = -1;
      SOFT_BREAK.lastIndex = from;
      for (let m = SOFT_BREAK.exec(text); m && m.index + m[0].length <= from + max; m = SOFT_BREAK.exec(text)) cut = m.index + m[0].length;
      if (cut < from + max / 3) {
        const sp = text.lastIndexOf(" ", from + max);
        cut = sp > from + max / 3 ? sp : from + max;
      }
      push(from, cut);
      from = cut;
    }
    push(from, e);
  };
  let from = 0;
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(text); m; m = SENTENCE_END.exec(text)) {
    if (m[0] === "." && notSentenceEnd(text, m.index)) continue;
    const cut = m.index + m[0].length;
    pushSplit(from, cut);
    from = cut;
  }
  pushSplit(from, text.length);
  return out;
}

const HAN = /\p{Script=Han}/gu;
const LATIN = /\p{Script=Latin}/gu;

/** 以汉字为主时读中文，否则读英文 */
export function detectLang(text: string): "zh" | "en" {
  const han = text.match(HAN)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  // 一个汉字大致相当于一个英文单词（约 5 个字母）
  return han * 5 >= latin && han > 0 ? "zh" : "en";
}

export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

/** macOS 的趣味语音和 Eloquence 合成语音：不适合朗读论文 */
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|junior|organ|pipe organ|ralph|superstar|trinoids|whisper|wobble|zarvox|fred|kathy|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
/** 公认音质好的系统语音 */
const GOOD = /^(samantha|alex|ava|allison|susan|zoe|tom|evan|nathan|daniel|karen|moira|serena|tingting|ting-ting|lili|yu-shu|meijia|sinji|microsoft (aria|jenny|guy|xiaoxiao|yunxi))\b/i;

/**
 * 挑选语音：语言匹配（zh 优先 zh-CN）；排除趣味语音；Natural / Enhanced / Premium 和公认好的语音优先，
 * 其次本机语音（网络语音常常不报告读到的位置、断网不能用）、系统默认；都没有时返回 null，交给浏览器用默认语音
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], lang: "zh" | "en", preferred?: string | null): V | null {
  if (preferred) {
    const v = voices.find((x) => x.name === preferred);
    if (v && v.lang.toLowerCase().startsWith(lang)) return v;
  }
  const want = lang === "zh" ? ["zh-cn", "zh-hans", "zh"] : ["en-us", "en-gb", "en"];
  const score = (v: V) => {
    const l = v.lang.toLowerCase().replace("_", "-");
    const li = want.findIndex((w) => l.startsWith(w));
    if (li < 0 || NOVELTY.test(v.name)) return -1;
    return (
      (want.length - li) * 100 +
      (/enhanced|premium|natural/i.test(v.name) ? 40 : 0) +
      (GOOD.test(v.name) ? 20 : 0) +
      (v.localService ? 10 : 0) +
      (v.default ? 5 : 0)
    );
  };
  let best: V | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = score(v);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return bestScore >= 0 ? best : null;
}

/** 从 charIndex 开始的一个词的结束位置（Safari 的 boundary 事件没有 charLength）。汉字一个字算一个词 */
export function wordEnd(text: string, from: number): number {
  const m = /^\p{Script=Han}|^[\p{L}\p{N}'’-]+|^\S/u.exec(text.slice(from));
  return from + (m ? m[0].length : 0);
}
