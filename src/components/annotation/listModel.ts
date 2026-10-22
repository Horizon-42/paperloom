// 批注列表与搜索的纯逻辑：筛选、按论文分组、排序、摘录
import type { Annotation } from "@/types/models";

export interface ListFilter {
  /** 只保留这些论文的批注；null/undefined 表示不限 */
  paperIds?: ReadonlySet<string> | null;
  /** 只保留这些颜色；空集表示不限 */
  colors?: ReadonlySet<string>;
  /** 小写关键词，全部出现在原文引用或笔记中才算匹配 */
  tokens?: string[];
}

export function annotationText(a: Pick<Annotation, "quote" | "note">): string {
  return `${a.quote.exact}\n${a.note}`.toLowerCase();
}

export function matchesFilter(a: Annotation, f: ListFilter): boolean {
  if (f.paperIds && !f.paperIds.has(a.paperId)) return false;
  if (f.colors && f.colors.size && !f.colors.has(a.color.toLowerCase())) return false;
  if (f.tokens?.length) {
    const h = annotationText(a);
    if (!f.tokens.every((t) => h.includes(t))) return false;
  }
  return true;
}

/** 同一论文内的阅读顺序：页码 → 第一个矩形自上而下 → 自左向右 → 创建时间 */
export function compareInPaper(a: Annotation, b: Annotation): number {
  if (a.page !== b.page) return a.page - b.page;
  const ra = a.rects[0];
  const rb = b.rects[0];
  if (ra && rb) {
    const ta = Math.max(ra[1], ra[3]);
    const tb = Math.max(rb[1], rb[3]);
    if (Math.abs(ta - tb) > 2) return tb - ta; // PDF y 向上
    const la = Math.min(ra[0], ra[2]);
    const lb = Math.min(rb[0], rb[2]);
    if (la !== lb) return la - lb;
  } else if (ra || rb) {
    return ra ? -1 : 1;
  }
  return a.createdAt - b.createdAt;
}

export interface PaperGroup {
  paperId: string;
  title: string;
  items: Annotation[];
}

export interface ListModel {
  /** 换文件后找不到原文的批注 */
  orphaned: Annotation[];
  groups: PaperGroup[];
  total: number;
}

/**
 * 筛选并按论文分组。分组按最近一次批注更新时间倒序（刚批注过的论文在前），组内按阅读顺序。
 * 论文已不存在的批注丢弃。
 */
export function buildListModel(anns: Annotation[], titleOf: (paperId: string) => string | undefined, f: ListFilter): ListModel {
  const orphaned: Annotation[] = [];
  const byPaper = new Map<string, { title: string; items: Annotation[]; latest: number }>();
  for (const a of anns) {
    const title = titleOf(a.paperId);
    if (title === undefined || !matchesFilter(a, f)) continue;
    if (a.anchorStatus === "orphaned") {
      orphaned.push(a);
      continue;
    }
    let g = byPaper.get(a.paperId);
    if (!g) byPaper.set(a.paperId, (g = { title, items: [], latest: 0 }));
    g.items.push(a);
    g.latest = Math.max(g.latest, a.updatedAt);
  }
  const groups = [...byPaper.entries()]
    .sort((x, y) => y[1].latest - x[1].latest || x[1].title.localeCompare(y[1].title, "zh-CN"))
    .map(([paperId, g]) => ({ paperId, title: g.title, items: g.items.sort(compareInPaper) }));
  orphaned.sort((x, y) => (titleOf(x.paperId) ?? "").localeCompare(titleOf(y.paperId) ?? "", "zh-CN") || compareInPaper(x, y));
  return { orphaned, groups, total: orphaned.length + groups.reduce((n, g) => n + g.items.length, 0) };
}

/** Markdown 笔记的纯文本摘录（去掉常见标记），用于列表单行显示 */
export function plainExcerpt(md: string, max = 140): string {
  const s = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\$\$([\s\S]*?)\$\$/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
