// 引用数的界面（D17）：论文行上的简写、编辑信息里的详情、第一次查询前的说明、批量查询的进度
import { htmlLang, t } from "@/i18n";
import { useEffect, useState } from "react";
import { useLibraryStore } from "@/app/stores/library";
import { workUrl } from "@/lib/openalex";
import type { Paper } from "@/types/models";
import { formatCount, getOpenAlexKey, hasCitationConsent, lookupOne, runCitations, saveCitationSettings, stopCitations } from "./citationController";
import { Shell } from "./DialogShell";
import { IconX } from "./icons";
import { btnGhost, btnOutline, btnPrimary, cx, input } from "./ui";

const SOURCE = "OpenAlex";
const day = (ms: number) => new Date(ms).toLocaleDateString(htmlLang());

/** 论文行上的"被引 1.9k"：只在查到时显示 */
export function CitationBadge({ paper }: { paper: Paper }) {
  const c = paper.citations;
  if (c?.status !== "found") return null;
  const tx = t.library.citations;
  return (
    <span
      className="shrink-0 tabular-nums text-neutral-400"
      title={tx.badgeTitle({ count: formatCount(c.count), source: SOURCE, date: day(c.fetchedAt) })}
      data-citations={c.count}
    >
      {tx.badge(formatCount(c.count, true))}
    </span>
  );
}

/**
 * 编辑信息里的引用数：结果、怎么匹配到的、查询按钮。
 * beforeQuery：查询前先保存表单里改过的 DOI；返回 false 时不查（DOI 格式不对）
 */
export function CitationDetail({ paper, beforeQuery }: { paper: Paper; beforeQuery?: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const c = paper.citations;
  const tx = t.library.citations;
  const query = async () => {
    setBusy(true);
    try {
      if (beforeQuery && !(await beforeQuery())) return;
      await lookupOne(paper.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-start gap-2 rounded-md border border-neutral-200 px-3 py-2 text-[12.5px]" data-citation-detail>
      <div className="min-w-0 flex-1 leading-relaxed">
        {c?.status === "found" ? (
          <>
            <div className="text-neutral-800">
              <span className="font-medium tabular-nums">{tx.singleFound(formatCount(c.count))}</span>
              <span className="text-neutral-400"> · {SOURCE} · {day(c.fetchedAt)}</span>
            </div>
            <div className="truncate text-[11.5px] text-neutral-500" title={c.matchedTitle}>
              {c.matchedBy === "doi" ? tx.byDoi : tx.byTitle(c.matchedTitle, c.matchedYear ? ` · ${c.matchedYear}` : "")}
              {c.preprint && tx.preprint}
            </div>
            <a href={workUrl(c.workId)} target="_blank" rel="noreferrer noopener" className="text-[11.5px] text-blue-700 hover:underline">
              {tx.openWork}
            </a>
          </>
        ) : (
          <div className="text-neutral-500">{c?.status === "notFound" ? `${tx.notFound} · ${day(c.fetchedAt)}` : tx.never}</div>
        )}
      </div>
      <button
        type="button"
        className={cx(btnOutline, "h-7 shrink-0 px-2.5 text-[12px]")}
        disabled={busy}
        data-citation-query
        onClick={() => (hasCitationConsent() ? void query() : setAsking(true))}
      >
        {c ? tx.refresh : tx.query}
      </button>
      {/* 叠在编辑信息对话框上，不替换它（表单里的改动还没保存） */}
      {asking && <CitationConsentDialog paperIds={[paper.id]} onClose={() => setAsking(false)} onConfirm={() => void query()} />}
    </div>
  );
}

/** 查询前的说明（第一次，或"查询设置"）：会发给 OpenAlex 什么；可选的 API key */
export function CitationConsentDialog({ paperIds, onClose, onConfirm }: { paperIds: string[]; onClose: () => void; onConfirm?: () => void }) {
  const tx = t.library.citations.consent;
  const [apiKey, setApiKey] = useState(getOpenAlexKey);
  const [dontAsk, setDontAsk] = useState(hasCitationConsent);
  return (
    <Shell title={tx.title} onClose={onClose}>
      <form
        className="space-y-3 text-[13px] leading-relaxed text-neutral-700"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation(); // 从编辑信息里打开时，不要冒泡到外面那个表单（React 事件会穿过 portal）
          saveCitationSettings({ dontAsk, apiKey });
          onClose();
          if (onConfirm) onConfirm();
          else if (paperIds.length) void runCitations(paperIds);
        }}
        data-citation-consent
      >
        <p>{tx.body}</p>
        <p className="text-neutral-500">{tx.how}</p>
        <p className="text-neutral-500">{tx.quota}</p>
        <div>
          <label className="mb-1 block text-xs font-medium text-neutral-500" htmlFor="openalex-key">
            {tx.apiKey}
          </label>
          <input id="openalex-key" className={input} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />
          <p className="mt-1 text-[11.5px] text-neutral-400">{tx.apiKeyHint}</p>
        </div>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />
          {tx.dontAsk}
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnGhost} onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className={btnPrimary}>
            {paperIds.length ? tx.confirm(paperIds.length) : t.common.save}
          </button>
        </div>
      </form>
    </Shell>
  );
}

/** 侧栏底部：批量查询的进度与结果 */
export function CitationStatus() {
  const job = useLibraryStore((s) => s.citationJob);
  const setJob = useLibraryStore((s) => s.setCitationJob);
  const tx = t.library.citations;
  // 顺利完成时几秒后收起；中途停止的保留，等用户看到原因
  const autoHide = !!job?.finished && !job.stopped;
  useEffect(() => {
    if (!autoHide) return;
    const timer = window.setTimeout(() => setJob(null), 5000);
    return () => window.clearTimeout(timer);
  }, [autoHide, job, setJob]);
  if (!job) return null;
  // 停止时没查的论文也报告了进度（skipped），所以按查到和没找到的算剩下几篇
  const left = job.total - job.found - job.notFound;
  return (
    <div className="flex items-start gap-2 border-t border-neutral-200 bg-white px-3 py-2.5 text-xs" role="status" aria-live="polite" data-testid="citation-status">
      <div className="min-w-0 flex-1">
        {!job.finished ? (
          <>
            <div className="text-neutral-700">{job.phase === "scan" ? tx.scanning(job.done, job.total) : tx.running(job.done, job.total)}</div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-neutral-100">
              <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} />
            </div>
          </>
        ) : (
          <>
            <div className="font-medium text-neutral-700">{tx.done(job.found, job.notFound)}</div>
            {job.stopped && <div className={cx("mt-0.5", job.stopped === "aborted" ? "text-neutral-500" : "text-amber-700")}>{tx.stopped[job.stopped](left)}</div>}
          </>
        )}
      </div>
      {!job.finished ? (
        <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-blue-700 hover:bg-blue-50" onClick={stopCitations}>
          {tx.stop}
        </button>
      ) : (
        <button type="button" className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label={t.common.close} onClick={() => setJob(null)}>
          <IconX width={13} height={13} />
        </button>
      )}
    </div>
  );
}
