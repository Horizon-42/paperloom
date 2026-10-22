// 主线程的术语匹配器：全应用共享一个 TermMatcher，订阅 terms / domains / 显示设置的变化。
// 只有影响匹配的字段（名称、别名、匹配方式、作用范围）变化时才重建并 version + 1，
// 只改笔记不会让各页重算下划线。快照对象只在相关内容变化时换新，组件可以直接用作依赖。
import { useSyncExternalStore } from "react";
import { liveQuery, type Subscription } from "dexie";
import { db } from "@/db/schema";
import { DEFAULT_TERM_DISPLAY, getTermDisplay, type TermDisplaySettings } from "@/db/repo/terms";
import { TermMatcher } from "@/engine/matcher";
import type { ScopeContext, TermLike } from "@/engine/types";
import type { Domain, Term } from "@/types/models";

export interface TermRuntime {
  /** terms 已至少加载过一次 */
  loaded: boolean;
  matcher: TermMatcher;
  /** 匹配器里的术语（只含匹配相关字段），与 matcher 同步更新 */
  termById: ReadonlyMap<string, TermLike>;
  /** 匹配规则相关字段变化时 +1 */
  version: number;
  /** 领域 id → 父领域 id */
  domainParent: ReadonlyMap<string, string | null>;
  /** 领域层级变化时 +1 */
  domainVersion: number;
  display: TermDisplaySettings;
  /** 最近一次重建匹配器的耗时（ms），供性能检查 */
  buildMs: number;
}

let snap: TermRuntime = {
  loaded: false,
  matcher: new TermMatcher([]),
  termById: new Map(),
  version: 0,
  domainParent: new Map(),
  domainVersion: 0,
  display: DEFAULT_TERM_DISPLAY,
  buildMs: 0,
};
const listeners = new Set<() => void>();
let subs: Subscription[] | null = null;
let termSig = "";
let domainSig = "";

function emit(next: Partial<TermRuntime>) {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

const scopeSig = (t: Term) => (t.scope?.kind === "domains" ? `d:${[...(t.scope.domainIds ?? [])].sort().join(",")}` : "g");

/** 影响匹配的字段签名 */
export function matchSignature(terms: readonly Term[]): string {
  return terms.map((t) => [t.id, t.name, (t.aliases ?? []).join("\u0001"), t.matchMode, scopeSig(t)].join("\u0002")).join("\u0003");
}

function onTerms(terms: Term[]) {
  const sig = matchSignature(terms);
  if (sig === termSig && snap.loaded) return;
  termSig = sig;
  const t0 = performance.now();
  const like: TermLike[] = terms.map(({ id, name, aliases, matchMode, scope }) => ({ id, name, aliases, matchMode, scope }));
  const matcher = new TermMatcher(like);
  const termById = new Map(like.map((t) => [t.id, t]));
  emit({ loaded: true, matcher, termById, version: snap.version + 1, buildMs: performance.now() - t0 });
}

function onDomains(domains: Domain[]) {
  const sig = domains
    .map((d) => `${d.id}>${d.parentId ?? ""}`)
    .sort()
    .join(",");
  if (sig === domainSig) return;
  domainSig = sig;
  emit({ domainParent: new Map(domains.map((d) => [d.id, d.parentId])), domainVersion: snap.domainVersion + 1 });
}

function onDisplay(d: TermDisplaySettings) {
  if (d.firstOnly === snap.display.firstOnly && d.hidden === snap.display.hidden) return;
  emit({ display: d });
}

/** 开始订阅（幂等）。register.ts 在应用启动时调用，打开第一篇论文前匹配器就已建好 */
export function startTermRuntime() {
  start();
}

function start() {
  if (subs) return;
  const fail = (what: string) => (err: unknown) => console.error(`[term] runtime: failed to read ${what}`, err);
  subs = [
    liveQuery(() => db.terms.toArray()).subscribe({ next: onTerms, error: fail("terms") }),
    liveQuery(() => db.domains.toArray()).subscribe({ next: onDomains, error: fail("fields") }),
    liveQuery(getTermDisplay).subscribe({ next: onDisplay, error: fail("display settings") }),
  ];
}

export function subscribeTermRuntime(cb: () => void): () => void {
  start();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTermRuntime(): TermRuntime {
  return snap;
}

export function useTermRuntime(): TermRuntime {
  return useSyncExternalStore(subscribeTermRuntime, getTermRuntime);
}

/** 等到 terms 至少加载一次（弹窗导航等异步逻辑用） */
export function whenTermRuntimeLoaded(): Promise<TermRuntime> {
  start();
  if (snap.loaded) return Promise.resolve(snap);
  return new Promise((resolve) => {
    const off = subscribeTermRuntime(() => {
      if (!snap.loaded) return;
      off();
      resolve(snap);
    });
  });
}

// ---- 每篇论文所属领域（多个页面覆盖层共享一个订阅） ----

interface PaperScopeEntry {
  /** undefined：查询中；null：论文不存在 */
  ids: string[] | null | undefined;
  key: string;
  listeners: Set<() => void>;
  sub: Subscription | null;
}

const paperScopes = new Map<string, PaperScopeEntry>();

function paperEntry(paperId: string): PaperScopeEntry {
  let e = paperScopes.get(paperId);
  if (!e) {
    const entry: PaperScopeEntry = { ids: undefined, key: "", listeners: new Set(), sub: null };
    entry.sub = liveQuery(() => db.papers.get(paperId)).subscribe({
      next: (p) => {
        const ids = p ? [...p.domainIds].sort() : null;
        const key = ids ? ids.join(",") : "\u0000";
        if (entry.ids !== undefined && key === entry.key) return;
        entry.ids = ids;
        entry.key = key;
        for (const l of entry.listeners) l();
      },
      error: (err: unknown) => console.error("[term] runtime: failed to read paper fields", err),
    });
    paperScopes.set(paperId, (e = entry));
  }
  return e;
}

/** 论文的领域 id（已排序）。查询中为 undefined，论文不存在为 null */
export function usePaperDomainIds(paperId: string): string[] | null | undefined {
  return useSyncExternalStore(
    (cb) => {
      const e = paperEntry(paperId);
      e.listeners.add(cb);
      return () => {
        e.listeners.delete(cb);
        // 没有订阅者时稍后释放，避免页面滚动时反复建立查询
        setTimeout(() => {
          if (e.listeners.size === 0 && paperScopes.get(paperId) === e) {
            e.sub?.unsubscribe();
            paperScopes.delete(paperId);
          }
        }, 5000);
      };
    },
    () => paperEntry(paperId).ids,
  );
}

/** 论文的作用范围上下文 */
export function scopeContext(paperDomainIds: readonly string[], domainParent: ReadonlyMap<string, string | null>): ScopeContext {
  return { paperDomainIds: [...paperDomainIds], domainParent };
}

/** 作用范围缓存键：论文领域 + 领域层级版本 */
export function scopeKey(paperDomainIds: readonly string[], rt: Pick<TermRuntime, "domainVersion">): string {
  return `${rt.domainVersion}|${paperDomainIds.join(",")}`;
}
