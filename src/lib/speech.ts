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
const MAX_SENTENCE = 220;

/** 论文里常见、后面不断句的缩写 */
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|et al|cf|vs|etc|fig|figs|eq|eqs|sec|tab|ref|refs|no|approx|resp|al)$/i;

/** 这个句点不是句末：缩写（e.g.、Fig.）或小节、列表编号（"1. Introduction"、"3.2. Method"） */
function notSentenceEnd(text: string, dot: number): boolean {
  const before = text.slice(Math.max(0, dot - 12), dot);
  if (ABBREV.test(before)) return true;
  return /(?:^|\s)\d{1,2}(?:\.\d{1,2})*$/.test(before);
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
    if (e - s <= MAX_SENTENCE) return push(s, e);
    let from = s;
    SOFT_BREAK.lastIndex = s;
    for (let m = SOFT_BREAK.exec(text); m && m.index < e; m = SOFT_BREAK.exec(text)) {
      const cut = m.index + m[0].length;
      if (cut - from >= MAX_SENTENCE / 3) {
        push(from, cut);
        from = cut;
      }
    }
    // 仍然太长（没有标点）：按空白硬切
    while (e - from > MAX_SENTENCE) {
      let cut = text.lastIndexOf(" ", from + MAX_SENTENCE);
      if (cut <= from) cut = from + MAX_SENTENCE;
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

/**
 * 挑选语音：语言匹配（zh 优先 zh-CN），本机语音优先（网络语音常常不报告读到的位置、断网不能用），
 * 名字带 Enhanced / Premium 的音质更好；都没有时返回 null，交给浏览器用默认语音
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
    if (li < 0) return -1;
    return (want.length - li) * 10 + (v.localService ? 5 : 0) + (/enhanced|premium|natural/i.test(v.name) ? 3 : 0) + (v.default ? 1 : 0);
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

/** 从 charIndex 开始的一个词的结束位置（Safari 的 boundary 事件没有 charLength） */
export function wordEnd(text: string, from: number): number {
  const m = /^[\p{L}\p{N}'’-]+|^\S/u.exec(text.slice(from));
  return from + (m ? m[0].length : 0);
}
