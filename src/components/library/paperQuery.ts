// 论文列表的筛选与排序（纯函数）
import type { LibrarySelection, PaperSort } from "@/app/stores/library";
import { getSubtreeIds, isUnfiled } from "@/services/domainTree";
import type { Domain, Paper } from "@/types/models";

export const SORT_OPTIONS: { value: PaperSort; label: string }[] = [
  { value: "added", label: "添加时间" },
  { value: "title", label: "标题" },
  { value: "year", label: "年份" },
  { value: "lastOpened", label: "最近打开" },
];

/** 选中领域时包含其所有子领域下的论文 */
export function filterPapersBySelection(papers: Paper[], domains: Domain[], selection: LibrarySelection): Paper[] {
  if (selection.kind === "all") return papers;
  if (selection.kind === "unfiled") {
    const existing = new Set(domains.map((d) => d.id));
    return papers.filter((p) => isUnfiled(p, existing));
  }
  if (!domains.some((d) => d.id === selection.id)) return [];
  const ids = new Set(getSubtreeIds(domains, selection.id));
  return papers.filter((p) => p.domainIds.some((id) => ids.has(id)));
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

/** "张三, 李四, 王五 等" */
export function formatAuthorsShort(authors: string[], max = 3): string {
  if (!authors.length) return "";
  if (authors.length <= max) return authors.join(", ");
  return `${authors.slice(0, max).join(", ")} 等`;
}
