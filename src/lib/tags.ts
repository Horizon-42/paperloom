// 论文标签的规范化与查询（纯函数，不碰数据库，可在 Worker 和存储格式校验中使用）。
// 标签就是字符串，存在 Paper.tags 里；比较时不区分大小写（tagKey），显示用第一次出现时的写法。

import type { Paper } from "@/types/models";

/** 单个标签的最大长度（按字符计） */
export const TAG_MAX_LENGTH = 40;

/** 输入框里分隔多个标签的字符：逗号、分号（含全角）、换行 */
const SEPARATORS = /[,，;；\n\r]+/;

/** 去掉开头的 #（可以有多个，中间夹空格也算）、分隔符，合并空白，截断到 TAG_MAX_LENGTH；结果可能为空串。幂等 */
export function normalizeTag(raw: string): string {
  const t = raw
    .normalize("NFC")
    .replace(/[,，;；\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[#＃]\s*)+/, "");
  return [...t].slice(0, TAG_MAX_LENGTH).join("").trim();
}

/** 比较用的键：不区分大小写 */
export function tagKey(tag: string): string {
  return normalizeTag(tag).toLocaleLowerCase();
}

/** 规范化、去掉空的、不区分大小写去重（保留第一次出现的写法和顺序） */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = normalizeTag(r);
    const k = t.toLocaleLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** "a, b；c" → ["a", "b", "c"] */
export function parseTagInput(raw: string): string[] {
  return normalizeTags(raw.split(SEPARATORS));
}

export function paperTags(paper: Pick<Paper, "tags">): string[] {
  return paper.tags ?? [];
}

export function hasTag(paper: Pick<Paper, "tags">, tag: string): boolean {
  const k = tagKey(tag);
  return paperTags(paper).some((t) => t.toLocaleLowerCase() === k);
}

export interface TagInfo {
  name: string;
  /** 带这个标签的论文数 */
  count: number;
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/**
 * 文库里出现过的所有标签及论文数，按名称排序。
 * 同一标签大小写写法不同时，显示添加最早的那篇论文上的写法。
 */
export function collectTags(papers: readonly Pick<Paper, "tags" | "addedAt" | "id">[]): TagInfo[] {
  const byKey = new Map<string, TagInfo & { at: number; id: string }>();
  for (const p of papers) {
    for (const t of paperTags(p)) {
      const k = t.toLocaleLowerCase();
      const cur = byKey.get(k);
      if (!cur) byKey.set(k, { name: t, count: 1, at: p.addedAt, id: p.id });
      else {
        cur.count++;
        if (p.addedAt < cur.at || (p.addedAt === cur.at && p.id < cur.id)) Object.assign(cur, { name: t, at: p.addedAt, id: p.id });
      }
    }
  }
  return [...byKey.values()]
    .map(({ name, count }) => ({ name, count }))
    .sort((a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 同时带有 filter 中所有标签的论文（filter 为空时原样返回） */
export function filterPapersByTags<T extends Pick<Paper, "tags">>(papers: T[], filter: readonly string[]): T[] {
  if (!filter.length) return papers;
  const keys = filter.map(tagKey);
  return papers.filter((p) => {
    const own = new Set(paperTags(p).map((t) => t.toLocaleLowerCase()));
    return keys.every((k) => own.has(k));
  });
}

/** 在 tags 中把 from 换成 to（保持位置）；不含 from 时返回 null */
export function renameInTags(tags: readonly string[], from: string, to: string): string[] | null {
  const k = tagKey(from);
  const i = tags.findIndex((t) => t.toLocaleLowerCase() === k);
  if (i < 0) return null;
  const next = [...tags];
  next[i] = to;
  return normalizeTags(next.filter((t, j) => j === i || t.toLocaleLowerCase() !== tagKey(to)));
}

/** 在已有标签中找同名的（不区分大小写），用于沿用文库里的写法 */
export function findTag<T extends { name: string }>(all: readonly T[], tag: string): T | undefined {
  const k = tagKey(tag);
  return k ? all.find((t) => t.name.toLocaleLowerCase() === k) : undefined;
}

/**
 * 标签输入框的自动补全：不区分大小写的子串匹配，排除 exclude（论文已有的标签）。
 * 与输入完全相同的排最前，其余按论文数从多到少、再按名称；query 为空时返回全部。
 */
export function suggestTags(all: readonly TagInfo[], query: string, exclude: readonly string[] = [], limit = Infinity): TagInfo[] {
  const q = tagKey(query);
  const skip = new Set(exclude.map((t) => t.toLocaleLowerCase()));
  const hits = all.filter((t) => {
    const k = t.name.toLocaleLowerCase();
    return !skip.has(k) && (!q || k.includes(q));
  });
  hits.sort(
    (a, b) =>
      Number(b.name.toLocaleLowerCase() === q) - Number(a.name.toLocaleLowerCase() === q) ||
      b.count - a.count ||
      collator.compare(a.name, b.name),
  );
  return hits.length > limit ? hits.slice(0, limit) : hits;
}

/** 标签颜色的稳定编号（0 … size-1）：对 tagKey 做 FNV-1a 哈希，大小写不同的同一标签颜色相同 */
export function tagColorIndex(tag: string, size: number): number {
  const k = tagKey(tag);
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % size;
}

/** 两组标签列表的内容是否相同（名称、论文数、顺序都一样） */
export function sameTagInfos(a: readonly TagInfo[], b: readonly TagInfo[]): boolean {
  return a.length === b.length && a.every((t, i) => t.name === b[i].name && t.count === b[i].count);
}
