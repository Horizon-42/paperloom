// 查询引用数的入口（D17）：第一次先弹出说明（会把 DOI 或标题发给 OpenAlex），之后直接查。
// 进度和结果写进 library store 的 citationJob（侧栏底部显示）；单篇查询只给一条提示。
import { useAnnotationStore } from "@/app/stores/annotation";
import { useLibraryStore } from "@/app/stores/library";
import { db } from "@/db/schema";
import { htmlLang, t } from "@/i18n";
import { OpenAlexError, isAbortError } from "@/lib/openalex";
import { needsRefresh, refreshCitations } from "@/services/citationService";

// 与项目无关、只属于本浏览器的设置：不经过 projectKey，也不进导出和同步
const CONSENT_KEY = "paperlens.citations.consent";
const API_KEY_KEY = "paperlens.openalex.apiKey";

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 无痕模式等：下次再问
  }
}

export const hasCitationConsent = () => readLocal(CONSENT_KEY) === "1";
export const getOpenAlexKey = () => readLocal(API_KEY_KEY) ?? "";

/** 说明对话框里确认：记下设置 */
export function saveCitationSettings(o: { dontAsk: boolean; apiKey: string }) {
  writeLocal(CONSENT_KEY, o.dontAsk ? "1" : null);
  writeLocal(API_KEY_KEY, o.apiKey.trim() || null);
}

export const formatCount = (n: number, compact = false) =>
  new Intl.NumberFormat(htmlLang(), compact ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(n);

let controller: AbortController | null = null;

/** 查询这些论文的引用数：还没同意过时先弹出说明 */
export function requestCitations(paperIds: string[]): void {
  if (!paperIds.length) return;
  if (!hasCitationConsent()) {
    useLibraryStore.getState().openDialog({ kind: "citationConsent", paperIds });
    return;
  }
  void runCitations(paperIds);
}

/** 批量查询：跳过最近查过的 */
export async function requestAllCitations(): Promise<void> {
  const now = Date.now();
  const ids = (await db.papers.toArray()).filter((p) => needsRefresh(p, now)).map((p) => p.id);
  if (!ids.length) {
    useAnnotationStore.getState().showToast(t.library.citations.allFresh);
    return;
  }
  requestCitations(ids);
}

export function stopCitations(): void {
  controller?.abort();
}

/**
 * 已同意后执行查询。单篇查询（右键菜单、编辑信息）独立进行，只给一条提示；
 * 批量查询同时只跑一批（侧栏底部显示进度，可停止），再发起时先停掉正在跑的那批
 */
export async function runCitations(paperIds: string[]): Promise<void> {
  const single = paperIds.length === 1;
  const ctl = new AbortController();
  if (!single) {
    controller?.abort();
    controller = ctl;
  }
  const store = useLibraryStore.getState;
  const toast = useAnnotationStore.getState().showToast;
  if (!single) store().setCitationJob({ total: paperIds.length, done: 0, found: 0, notFound: 0, phase: "scan", finished: false });
  const update = (f: Parameters<ReturnType<typeof store>["setCitationJob"]>[0]) => {
    if (!single && controller === ctl) store().setCitationJob(f);
  };
  try {
    const r = await refreshCitations(paperIds, {
      apiKey: getOpenAlexKey() || undefined,
      signal: ctl.signal,
      onScan: (done, total) => update((j) => j && { ...j, phase: "scan", done, total }),
      onProgress: (done, total, last) =>
        update((j) =>
          j && {
            ...j,
            phase: "lookup",
            total,
            done,
            found: j.found + (last.status === "found" ? 1 : 0),
            notFound: j.notFound + (last.status === "notFound" ? 1 : 0),
          },
        ),
    });
    const stopped = r.stopped?.kind;
    update((j) => j && { ...j, finished: true, ...(stopped ? { stopped } : {}) });
    if (single) {
      const o = r.outcomes[0];
      if (o?.status === "found") toast(t.library.citations.singleFound(formatCount(o.citations.count)));
      else if (o?.status === "notFound") toast(t.library.citations.singleNotFound);
      else if (stopped) toast(t.library.citations.stopped[stopped](1), { kind: "error" });
    }
  } catch (e) {
    const aborted = isAbortError(e);
    const kind = aborted ? "aborted" : e instanceof OpenAlexError ? e.kind : "error";
    if (kind === "error") console.error(e);
    update((j) => j && { ...j, finished: true, stopped: kind });
    if (single && !aborted) toast(t.library.citations.stopped[kind](1), { kind: "error" });
  } finally {
    if (controller === ctl) controller = null;
  }
}

/** 单篇查询，等它完成（编辑信息对话框里的按钮用来显示进行中） */
export async function lookupOne(paperId: string): Promise<void> {
  await runCitations([paperId]);
}
