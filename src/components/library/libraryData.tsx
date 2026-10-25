// 侧栏共用的数据：论文和领域各查一次，派生出树、计数等，供子组件读取。
// 结构共享保证某篇论文写入后只有它的对象引用变化；领域相关的派生值只随领域变化。
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listDomains } from "@/db/repo/domains";
import { listFieldNotes } from "@/db/repo/notes";
import { listPapers } from "@/db/repo/papers";
import { collectTags, sameTagInfos, type TagInfo } from "@/lib/tags";
import { buildDomainTree, countPapersByDomain, isUnfiled, type DomainNode } from "@/services/domainTree";
import type { Domain, Note, Paper } from "@/types/models";
import { shareById, type Shared } from "./structural";

export interface LibraryData {
  loaded: boolean;
  papers: Paper[];
  paperById: Map<string, Paper>;
  domains: Domain[];
  domainById: Map<string, Domain>;
  tree: DomainNode[];
  /** 每个领域（含子领域）的论文数 */
  counts: Map<string, number>;
  unfiledCount: number;
  /** 文库里所有标签及论文数（按名称排序） */
  tags: TagInfo[];
  /** 领域 id → 该领域的领域笔记（按创建时间） */
  notesByDomain: Map<string, Note[]>;
}

const LibraryDataContext = createContext<LibraryData | null>(null);

function useShared<T extends { id: string }>(list: T[] | undefined): Shared<T> | undefined {
  const prev = useRef<Shared<T> | null>(null);
  return useMemo(() => {
    if (!list) return undefined;
    prev.current = shareById(prev.current, list);
    return prev.current;
  }, [list]);
}

const EMPTY_PAPERS: Shared<Paper> = { list: [], byId: new Map() };
const EMPTY_DOMAINS: Shared<Domain> = { list: [], byId: new Map() };
const EMPTY_NOTES: Note[] = [];

export function LibraryDataProvider({ children }: { children: ReactNode }) {
  const papersShared = useShared(useLiveQuery(listPapers, []));
  const domainsShared = useShared(useLiveQuery(listDomains, []));
  const fieldNotes = useLiveQuery(listFieldNotes, []) ?? EMPTY_NOTES;
  const notesByDomain = useMemo(() => {
    const m = new Map<string, Note[]>();
    for (const n of fieldNotes) {
      const list = m.get(n.domainId!);
      if (list) list.push(n);
      else m.set(n.domainId!, [n]);
    }
    return m;
  }, [fieldNotes]);
  const loaded = papersShared !== undefined && domainsShared !== undefined;
  const p = papersShared ?? EMPTY_PAPERS;
  const d = domainsShared ?? EMPTY_DOMAINS;

  const tree = useMemo(() => buildDomainTree(d.list), [d]);
  // 内容没变（如只改了 lastOpenedAt）时沿用上一次的数组，依赖它的组件不必重新渲染
  const prevTags = useRef<TagInfo[]>([]);
  const tags = useMemo(() => {
    const next = collectTags(p.list);
    if (!sameTagInfos(prevTags.current, next)) prevTags.current = next;
    return prevTags.current;
  }, [p]);
  const derived = useMemo(() => {
    const existing = new Set(d.byId.keys());
    return {
      counts: countPapersByDomain(d.list, p.list),
      unfiledCount: p.list.reduce((n, x) => n + (isUnfiled(x, existing) ? 1 : 0), 0),
    };
  }, [p, d]);

  const value = useMemo<LibraryData>(
    () => ({
      loaded,
      papers: p.list,
      paperById: p.byId,
      domains: d.list,
      domainById: d.byId,
      tree,
      ...derived,
      tags,
      notesByDomain,
    }),
    [loaded, p, d, tree, derived, tags, notesByDomain],
  );

  return <LibraryDataContext.Provider value={value}>{children}</LibraryDataContext.Provider>;
}

export function useLibraryData(): LibraryData {
  const v = useContext(LibraryDataContext);
  if (!v) throw new Error("useLibraryData must be used inside LibraryDataProvider");
  return v;
}
