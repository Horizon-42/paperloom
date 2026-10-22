// 当前论文里每个术语的全部出现位置（弹窗 ↑/↓ 导航用）。
// 用全文缓存（ensurePageTexts，偏移与 ctx.text.normalized 一致）+ 主线程匹配器逐页匹配，
// 按 (论文, 文件, 匹配器版本, 作用范围) 缓存；50 页约十几毫秒，首次需要从 PDF 提取全文时会慢一些。
import { useEffect, useState } from "react";
import { db } from "@/db/schema";
import { ensurePageTexts } from "@/services/pageTextService";
import { buildOccurrenceIndex, type OccurrencePos } from "./logic/occurrences";
import { scopeContext, scopeKey, usePaperDomainIds, useTermRuntime, whenTermRuntimeLoaded } from "./runtime";

type Index = Map<string, OccurrencePos[]>;

const cache = new Map<string, { key: string; promise: Promise<Index> }>();
const MAX_PAPERS = 8;

export async function getPaperOccurrenceIndex(paperId: string): Promise<Index> {
  const rt = await whenTermRuntimeLoaded();
  const paper = await db.papers.get(paperId);
  if (!paper) return new Map();
  const domainIds = [...paper.domainIds].sort();
  const key = `${paper.fileHash}|${rt.version}|${scopeKey(domainIds, rt)}`;
  const hit = cache.get(paperId);
  if (hit && hit.key === key) return hit.promise;
  const promise = ensurePageTexts(paperId).then((pages) => buildOccurrenceIndex(pages, rt.matcher, scopeContext(domainIds, rt.domainParent)));
  promise.catch(() => {
    if (cache.get(paperId)?.promise === promise) cache.delete(paperId);
  });
  cache.delete(paperId);
  cache.set(paperId, { key, promise });
  while (cache.size > MAX_PAPERS) cache.delete(cache.keys().next().value!);
  return promise;
}

export type PositionsState = { status: "loading" } | { status: "ready"; list: OccurrencePos[] } | { status: "error" };

/** 某术语在某论文中的全部出现位置；术语、领域或论文所属领域变化时重算。enabled 为 false 时不计算 */
export function useTermPositions(paperId: string, termId: string, enabled = true): PositionsState {
  const rt = useTermRuntime();
  const domainIds = usePaperDomainIds(paperId);
  const [state, setState] = useState<{ key: string; pt: string; value: PositionsState }>({ key: "", pt: "", value: { status: "loading" } });
  const pt = `${paperId}|${termId}`;
  const key = `${pt}|${rt.version}|${rt.domainVersion}|${domainIds?.join(",") ?? "?"}`;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getPaperOccurrenceIndex(paperId).then(
      (idx) => !cancelled && setState({ key, pt, value: { status: "ready", list: idx.get(termId) ?? [] } }),
      (err: unknown) => {
        console.warn("术语导航：读取全文失败", err);
        if (!cancelled) setState({ key, pt, value: { status: "error" } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!enabled) return { status: "loading" };
  // 同一术语重算期间沿用上一次的结果，避免计数闪烁
  return state.key === key || state.pt === pt ? state.value : { status: "loading" };
}
