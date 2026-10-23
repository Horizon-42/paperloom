// 术语 → LaTeX acro 宏包的 \DeclareAcronym（纯函数，导出 .tex 和复制单条共用）。
// 缩写取规范名与别名中像缩写的那个，全称取规范名（规范名本身是缩写时取别名里的全称）；
// 全称是中文、别名里有英文全称时写进 foreign（"长短期记忆网络（Long Short-Term Memory, LSTM）"）。
// 没有缩写的术语 short = long = 名称、首次出现也只写名称，并带 tag = noabbrev 方便从缩写表里排除。
import { isAcronymLike } from "@/engine/matcher";
import type { Term } from "@/types/models";

export const NO_ABBREV_TAG = "noabbrev";

export interface AcroEntry {
  short: string;
  long: string;
  foreign?: string;
  /** 没有缩写：short 与 long 相同 */
  noAbbrev: boolean;
}

const HAN = /\p{Script=Han}/u;
const isLatinPhrase = (s: string) => /\p{Script=Latin}/u.test(s) && !HAN.test(s);

/** 像缩写：单个词、不太长，全大写（LSTM、LSTMs）或至少两个大写字母（BiLSTM、ResNet） */
function isShortForm(s: string): boolean {
  if (!s || /\s/.test(s) || [...s].length > 12) return false;
  if (isAcronymLike(s)) return true;
  return (s.match(/\p{Lu}/gu)?.length ?? 0) >= 2;
}

/** 缩写本身是复数形式：LSTMs、GNNs（末尾 s 前是大写字母） */
const isPluralShort = (s: string) => s.length >= 3 && s.endsWith("s") && /\p{Lu}/u.test(s[s.length - 2]);

export function acroEntry(term: Pick<Term, "name" | "aliases">): AcroEntry {
  const name = term.name.trim();
  const forms = [...new Set([name, ...term.aliases.map((a) => a.trim())].filter(Boolean))];
  const shorts = forms.filter(isShortForm);
  const longs = forms.filter((f) => !isShortForm(f));
  // 同时有 LSTM 和 LSTMs 时取单数；优先全大写的，再取最短的
  const singular = shorts.filter((s) => !(s.endsWith("s") && shorts.includes(s.slice(0, -1))));
  const short = singular.sort((a, b) => Number(isAcronymLike(b)) - Number(isAcronymLike(a)) || a.length - b.length)[0];
  const long = isShortForm(name) ? longs[0] : name;
  if (!short || !long) return { short: name, long: name, noAbbrev: true };
  const foreign = HAN.test(long) ? longs.find((f) => f !== long && isLatinPhrase(f)) : undefined;
  return { short, long, foreign, noAbbrev: false };
}

/** acro 的 id：小写 ASCII 字母、数字和连字符；取不出来（如全是中文）时为 term */
function baseId(entry: AcroEntry): string {
  const slug = entry.short
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // é → e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "term";
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 给每个术语分配 id（术语 id → acro id）。按创建时间先后，重名的加 -2、-3……
 * 复制单条时也用全部术语来算，保证和导出文件里的一致
 */
export function assignAcroIds(terms: readonly Term[]): Map<string, string> {
  const ordered = [...terms].sort((a, b) => a.createdAt - b.createdAt || byString(a.id, b.id));
  const bases = ordered.map((x) => baseId(acroEntry(x)));
  // 编号时避开所有自然 id：本来就叫 pe-2 的术语不会被重名的 pe 抢走
  const natural = new Set(bases);
  const taken = new Set<string>();
  const out = new Map<string, string>();
  ordered.forEach((x, i) => {
    let id = bases[i];
    if (taken.has(id)) {
      let n = 2;
      while (natural.has(`${id}-${n}`) || taken.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    taken.add(id);
    out.set(x.id, id);
  });
  return out;
}

const TEX_SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/** 转义 LaTeX 特殊字符。值外面另包一层花括号，逗号和等号就不会被 key-value 解析误读 */
export function texEscape(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[\\{}&%$#_~^]/g, (c) => TEX_SPECIAL[c]);
}

export function declareAcronym(term: Pick<Term, "name" | "aliases">, id: string): string {
  const e = acroEntry(term);
  const value = (s: string) => `{${texEscape(s)}}`;
  const props: [string, string][] = [
    ["short", value(e.short)],
    ["long", value(e.long)],
  ];
  if (e.foreign) props.push(["foreign", value(e.foreign)]);
  // 复数默认在末尾加 s；中文、或缩写本身就是复数（只有 GNNs）时，复数就是原样
  if (HAN.test(e.short) || isPluralShort(e.short)) props.push(["short-plural-form", value(e.short)]);
  if (HAN.test(e.long)) props.push(["long-plural-form", value(e.long)]);
  if (e.noAbbrev) props.push(["first-style", "short"], ["tag", NO_ABBREV_TAG]);
  const width = Math.max(...props.map(([k]) => k.length));
  return `\\DeclareAcronym{${id}}{\n${props.map(([k, v]) => `  ${k.padEnd(width)} = ${v} ,`).join("\n")}\n}`;
}

const commentLines = (text: string) =>
  text
    .trim()
    .split(/\r\n|\r|\n/) // TeX 把单独的 \r 也当作换行：漏掉的话后面的文字就跑出注释了
    .map((l) => (l.trim() ? `% ${l.trimEnd()}` : "%"));

/**
 * 整个 .tex 文件：开头的说明注释 + 按缩写字母序排列的声明。
 * 术语笔记以注释写在对应声明上方。ids 缺省按 terms 自己分配；只导出一部分时传全部术语分配的
 */
export function glossaryToAcro(terms: readonly Term[], header: readonly string[], ids = assignAcroIds(terms)): string {
  const items = terms
    .map((term) => ({ term, id: ids.get(term.id) ?? baseId(acroEntry(term)), key: acroEntry(term).short.toLocaleLowerCase() }))
    .sort((a, b) => byString(a.key, b.key) || byString(a.id, b.id));
  const blocks = items.map(({ term, id }) => {
    const note = term.note.trim() ? `${commentLines(term.note).join("\n")}\n` : "";
    return note + declareAcronym(term, id);
  });
  return [...commentLines(header.join("\n")), "", blocks.join("\n\n"), ""].join("\n");
}
