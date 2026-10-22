// 术语表模块的启动注册：向文库搜索注册"术语"结果提供者。App.tsx 会在首次渲染前 import 本文件。
import { useAppStore } from "@/app/stores/app";
import { useGlossaryStore } from "@/app/stores/glossary";
import { useIndexerStore } from "@/app/stores/indexer";
import { registerSearchProvider, type SearchHit } from "@/components/library/search";
import { db } from "@/db/schema";
import { MATCH_VERSION, NORMALIZE_VERSION } from "@/engine/types";
import { t } from "@/i18n";
import { getIndexerDebug, retryFailedExtractions, scheduleIndex, whenIndexerIdle } from "@/services/indexer";
import type { Term } from "@/types/models";
import { compareNames, noteSnippet, termMatchesQuery } from "./model";

/** 名称完全匹配 > 名称前缀 > 名称包含 > 别名包含 > 只在笔记中 */
function rank(t: Term, raw: string, tokens: string[]): number {
  const name = t.name.toLowerCase();
  const q = raw.trim().toLowerCase();
  if (name === q || t.aliases.some((a) => a.toLowerCase() === q)) return 0;
  if (name.startsWith(q)) return 1;
  if (tokens.every((k) => name.includes(k))) return 2;
  const aliases = t.aliases.join("\n").toLowerCase();
  if (tokens.every((k) => name.includes(k) || aliases.includes(k))) return 3;
  return 4;
}

registerSearchProvider({
  kind: "term",
  get label() {
    return t.term.searchLabel;
  },
  order: 2,
  limit: 50,
  async search(q) {
    const terms = await db.terms.toArray();
    return terms
      .filter((t) => termMatchesQuery(t, q.tokens))
      .map((t) => ({ t, r: rank(t, q.raw, q.tokens) }))
      .sort((a, b) => a.r - b.r || compareNames(a.t.name, b.t.name))
      .map(
        ({ t, r }): SearchHit => ({
          kind: "term",
          id: t.id,
          title: t.name,
          subtitle: t.aliases.length ? t.aliases.join(", ") : undefined,
          snippet: r === 4 ? noteSnippet(t.note, q.tokens) : undefined,
        }),
      );
  },
  activate(hit) {
    useGlossaryStore.getState().revealTerm(hit.id);
    useAppStore.getState().setView("glossary");
  },
});

if (import.meta.env.DEV) {
  // 供 e2e 测试读取索引进度、驱动术语表
  (window as unknown as Record<string, unknown>).__paperlensGlossary = {
    useGlossaryStore,
    useIndexerStore,
    scheduleIndex,
    retryFailedExtractions,
    whenIndexerIdle,
    getIndexerDebug,
    NORMALIZE_VERSION,
    MATCH_VERSION,
  };
}
