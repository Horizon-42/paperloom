import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { projectKey } from "@/lib/project";

/** 左栏筛选：全部 / 全局术语 / 无作用范围（限定领域但列表为空或领域都已删除）/ 某个领域（含子领域） */
export type GlossaryFilter = { kind: "all" } | { kind: "global" } | { kind: "unscoped" } | { kind: "domain"; id: string };

export type GlossarySortKey = "name" | "occurrences" | "updated";

export interface GlossarySort {
  key: GlossarySortKey;
  dir: "asc" | "desc";
}

/** 各排序键第一次点选时的默认方向 */
export const DEFAULT_SORT_DIR: Record<GlossarySortKey, GlossarySort["dir"]> = {
  name: "asc",
  occurrences: "desc",
  updated: "desc",
};

interface GlossaryState {
  selectedTermId: string | null;
  filter: GlossaryFilter;
  query: string;
  sort: GlossarySort;
  /** 左栏领域树中展开的领域 */
  expanded: Record<string, true>;
  /** 需要在列表中定位的术语（搜索结果激活时）；seq 每次请求自增 */
  reveal: { termId: string; seq: number } | null;

  select: (termId: string | null) => void;
  setFilter: (filter: GlossaryFilter) => void;
  setQuery: (query: string) => void;
  /** 点选排序键：已是当前键时切换方向，否则用该键的默认方向 */
  toggleSort: (key: GlossarySortKey) => void;
  setSort: (sort: GlossarySort) => void;
  toggleExpanded: (domainId: string) => void;
  /** 选中并定位到某个术语 */
  revealTerm: (termId: string) => void;
  clearReveal: () => void;
}

let revealSeq = 0;

export const useGlossaryStore = create<GlossaryState>()(
  persist(
    (set) => ({
      selectedTermId: null,
      filter: { kind: "all" },
      query: "",
      sort: { key: "name", dir: "asc" },
      expanded: {},
      reveal: null,

      select: (selectedTermId) => set({ selectedTermId }),
      setFilter: (filter) => set({ filter }),
      setQuery: (query) => set({ query }),
      toggleSort: (key) =>
        set((s) => ({
          sort: s.sort.key === key ? { key, dir: s.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_SORT_DIR[key] },
        })),
      setSort: (sort) => set({ sort }),
      toggleExpanded: (id) =>
        set((s) => {
          const next = { ...s.expanded };
          if (next[id]) delete next[id];
          else next[id] = true;
          return { expanded: next };
        }),
      revealTerm: (termId) => set({ selectedTermId: termId, reveal: { termId, seq: ++revealSeq } }),
      clearReveal: () => set({ reveal: null }),
    }),
    {
      // 内容含本项目的 id（选中的领域、术语、画布）：按项目分开存
      name: projectKey("paperlens.glossary"),
      storage: createJSONStorage(() => localStorage),
      // 只记住偏好类状态
      partialize: (s) => ({ filter: s.filter, sort: s.sort, expanded: s.expanded }),
    },
  ),
);
