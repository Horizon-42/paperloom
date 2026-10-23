// 论文列表的筛选与排序（纯函数）
import { t } from "@/i18n";
import type { PaperSort } from "@/app/stores/library";
import type { Paper } from "@/types/models";

/** 排序选项；显示名用 sortLabel */
export const SORT_OPTIONS: readonly PaperSort[] = ["added", "title", "year", "lastOpened", "citations"];

/** 引用数（没查过或没找到为 undefined） */
export const citationCount = (p: Paper) => (p.citations?.status === "found" ? p.citations.count : undefined);

export function sortLabel(sort: PaperSort): string {
  return t.library.paperList.sort[sort];
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const byTitle = (a: Paper, b: Paper) => collator.compare(a.title, b.title) || a.id.localeCompare(b.id);

export function sortPapers(papers: Paper[], sort: PaperSort): Paper[] {
  const xs = [...papers];
  switch (sort) {
    case "title":
      return xs.sort(byTitle);
    case "year":
      // 新的在前；没有年份的排最后
      return xs.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity) || byTitle(a, b));
    case "citations":
      // 多的在前；没有引用数的排最后
      return xs.sort((a, b) => (citationCount(b) ?? -Infinity) - (citationCount(a) ?? -Infinity) || byTitle(a, b));
    case "lastOpened":
      // 打开过的按最近打开排在前，没打开过的按添加时间
      return xs.sort(
        (a, b) =>
          (b.lastOpenedAt ?? -Infinity) - (a.lastOpenedAt ?? -Infinity) || b.addedAt - a.addedAt || byTitle(a, b),
      );
    case "added":
    default:
      return xs.sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b));
  }
}

/** "张三, 李四, 王五 等"（英文："… et al."） */
export function formatAuthorsShort(authors: string[], max = 3): string {
  if (!authors.length) return "";
  if (authors.length <= max) return authors.join(", ");
  return t.library.paperRow.authorsEtAl(authors.slice(0, max).join(", "));
}
