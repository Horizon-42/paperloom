// 侧栏全局搜索：按"论文 / 批注 / 术语"分组的可扩展结构。
//
// 扩展方式：其他模块在启动时调用 registerSearchProvider({...})，提供
//   - kind / label / order：分组类型、分组标题、分组顺序
//   - search(query)：返回命中列表；内部用 Dexie 查询时，侧栏的 useLiveQuery 会自动随数据变化刷新
//   - activate(hit)：点击结果时做什么（如 jumpTo 到批注位置、打开术语弹窗）
// 论文分组由本模块提供（搜标题、作者和标签，"#xx" 只搜标签），侧栏用 PaperRow 展示以保留右键菜单和拖拽。
import { useSyncExternalStore } from "react";
import { listPapers } from "@/db/repo/papers";
import { useReaderStore } from "@/app/stores/reader";
import type { Paper } from "@/types/models";

export type SearchGroupKind = "paper" | "annotation" | "term";

export interface SearchQuery {
  raw: string;
  /** 小写、按空白切分；全部命中才算匹配 */
  tokens: string[];
}

export interface SearchHit {
  kind: SearchGroupKind;
  id: string;
  title: string;
  /** 第二行：作者、批注所在论文、术语别名等 */
  subtitle?: string;
  /** 命中片段（可选） */
  snippet?: string;
  paperId?: string;
  page?: number;
}

export interface SearchProvider {
  kind: SearchGroupKind;
  label: string;
  /** 分组显示顺序，小的在前 */
  order: number;
  /** 每组最多显示多少条，缺省 50 */
  limit?: number;
  search(query: SearchQuery): Promise<SearchHit[]>;
  activate(hit: SearchHit): void;
}

export interface SearchGroup {
  kind: SearchGroupKind;
  label: string;
  hits: SearchHit[];
  /** 截断前的命中总数 */
  total: number;
}

export function parseQuery(raw: string): SearchQuery {
  return { raw, tokens: raw.toLowerCase().split(/\s+/).filter(Boolean) };
}

/** 所有 token 都出现在 haystack 中（不区分大小写） */
export function matchesAll(haystack: string, tokens: string[]): boolean {
  const h = haystack.toLowerCase();
  return tokens.every((t) => h.includes(t));
}

/**
 * 标题、作者、标签都参与匹配；以 # 开头的 token（如 "#待读"）只在标签中找。
 * 单独一个 "#" 不算条件。
 */
export function paperMatches(paper: Pick<Paper, "title" | "authors" | "tags">, tokens: string[]): boolean {
  const tags = paper.tags ?? [];
  const plain: string[] = [];
  const tagTokens: string[] = [];
  for (const t of tokens) {
    if (/^[#＃]/.test(t)) {
      const rest = t.replace(/^[#＃]+/, "");
      if (rest) tagTokens.push(rest);
    } else plain.push(t);
  }
  if (!plain.length && !tagTokens.length) return false;
  if (!tagTokens.every((t) => tags.some((x) => x.toLowerCase().includes(t)))) return false;
  return matchesAll(`${paper.title}\n${paper.authors.join("\n")}\n${tags.join("\n")}`, plain);
}

export const paperSearchProvider: SearchProvider = {
  kind: "paper",
  label: "论文",
  order: 0,
  limit: 200,
  async search(q) {
    const papers = await listPapers();
    return papers
      .filter((p) => paperMatches(p, q.tokens))
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((p) => ({ kind: "paper", id: p.id, paperId: p.id, title: p.title, subtitle: p.authors.join(", ") }));
  },
  activate(hit) {
    useReaderStore.getState().openPaper(hit.id);
  },
};

// ---- 注册表 ----

const providers = new Map<SearchGroupKind, SearchProvider>([["paper", paperSearchProvider]]);
let snapshot: SearchProvider[] = [...providers.values()];
const listeners = new Set<() => void>();

function emit() {
  snapshot = [...providers.values()].sort((a, b) => a.order - b.order);
  listeners.forEach((l) => l());
}

/** 注册（或替换同类型的）搜索提供者；返回注销函数 */
export function registerSearchProvider(p: SearchProvider): () => void {
  providers.set(p.kind, p);
  emit();
  return () => {
    if (providers.get(p.kind) === p) {
      providers.delete(p.kind);
      emit();
    }
  };
}

export function getSearchProviders(): SearchProvider[] {
  return snapshot;
}

export function useSearchProviders(): SearchProvider[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSearchProviders,
    getSearchProviders,
  );
}

/** 依次调用所有提供者；单个提供者出错只让该组为空 */
export async function runSearch(raw: string, list: SearchProvider[] = getSearchProviders()): Promise<SearchGroup[]> {
  const q = parseQuery(raw);
  if (!q.tokens.length) return [];
  const groups: SearchGroup[] = [];
  for (const p of list) {
    let hits: SearchHit[] = [];
    try {
      hits = await p.search(q);
    } catch (e) {
      console.warn(`[search] ${p.kind} provider failed`, e);
    }
    groups.push({ kind: p.kind, label: p.label, hits: hits.slice(0, p.limit ?? 50), total: hits.length });
  }
  return groups;
}

export function getSearchProvider(kind: SearchGroupKind): SearchProvider | undefined {
  return providers.get(kind);
}
