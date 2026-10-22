// 侧栏全局搜索的"批注"分组：搜原文引用和笔记，点击跳转到原文
import type { SearchProvider } from "@/components/library/search";
import { getAnnotation, listAllAnnotations } from "@/db/repo/annotations";
import { db } from "@/db/schema";
import { t } from "@/i18n";
import { jumpToAnnotation } from "./actions";
import { matchesFilter, plainExcerpt } from "./listModel";

export const annotationSearchProvider: SearchProvider = {
  kind: "annotation",
  get label() {
    return t.reader.search.group;
  },
  order: 1,
  limit: 50,
  async search(q) {
    const anns = (await listAllAnnotations()).filter((a) => matchesFilter(a, { tokens: q.tokens }));
    if (!anns.length) return [];
    const paperIds = [...new Set(anns.map((a) => a.paperId))];
    const papers = await db.papers.bulkGet(paperIds);
    const title = new Map(paperIds.map((id, i) => [id, papers[i]?.title]));
    return anns
      .filter((a) => title.get(a.paperId) !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((a) => ({
        kind: "annotation" as const,
        id: a.id,
        paperId: a.paperId,
        page: a.page,
        title: a.quote.exact.length > 120 ? `${a.quote.exact.slice(0, 119)}…` : a.quote.exact,
        subtitle: `${title.get(a.paperId)} · ${t.reader.page(a.page)}${a.anchorStatus === "orphaned" ? ` · ${t.reader.list.orphaned}` : ""}`,
        snippet: a.note.trim() ? plainExcerpt(a.note, 100) : undefined,
      }));
  },
  activate(hit) {
    void getAnnotation(hit.id).then((a) => a && jumpToAnnotation(a));
  },
};
