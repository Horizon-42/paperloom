// 侧栏底部的导入进度与结果汇总
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { useLibraryStore, type ImportJob } from "@/app/stores/library";
import { IconX } from "./icons";
import { cx } from "./ui";

export function ImportStatus() {
  const job = useLibraryStore((s) => s.importJob);
  const setJob = useLibraryStore((s) => s.setImportJob);
  const [showDetails, setShowDetails] = useState(false);

  const added = job?.items.filter((i) => i.status === "added") ?? [];
  const dups = job?.items.filter((i) => i.status === "duplicate") ?? [];
  const failed = job?.items.filter((i) => i.status === "failed") ?? [];

  // 全部成功时几秒后自动收起；有重复或失败时保留，等用户查看
  const autoHide = !!job?.finished && dups.length === 0 && failed.length === 0;
  useEffect(() => {
    if (!autoHide) return;
    const timer = window.setTimeout(() => setJob(null), 5000);
    return () => window.clearTimeout(timer);
  }, [autoHide, job, setJob]);
  useEffect(() => {
    if (!job) setShowDetails(false);
  }, [job]);

  if (!job) return null;

  return (
    <div className="border-t border-neutral-200 bg-white px-3 py-2.5 text-xs" role="status" aria-live="polite" data-testid="import-status">
      {!job.finished ? (
        <Progress job={job} />
      ) : (
        <>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-neutral-700">{headline(job, added.length, dups.length)}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Chip tone="green" n={added.length} text={t.library.importStatus.addedCount(added.length)} />
                <Chip tone="amber" n={dups.length} text={t.library.importStatus.duplicateCount(dups.length)} />
                <Chip tone="red" n={failed.length} text={t.library.importStatus.failedCount(failed.length)} />
              </div>
            </div>
            <button
              type="button"
              onClick={() => setJob(null)}
              className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              aria-label={t.library.importStatus.close}
            >
              <IconX width={14} height={14} />
            </button>
          </div>
          {dups.length + failed.length > 0 && (
            <>
              <button type="button" onClick={() => setShowDetails((v) => !v)} className="mt-1.5 text-[11.5px] text-blue-600 hover:underline">
                {showDetails ? t.library.importStatus.hideDetails : t.library.importStatus.showDetails}
              </button>
              {showDetails && (
                <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
                  {failed.map((i, k) => (
                    <li key={`f${k}`} className="leading-snug">
                      <span className="text-red-600">{t.library.importStatus.failed}</span> <span className="break-all text-neutral-700">{i.fileName}</span>
                      <span className="text-neutral-400"> — {i.error}</span>
                    </li>
                  ))}
                  {dups.map((i, k) => (
                    <li key={`d${k}`} className="leading-snug">
                      <span className="text-amber-600">{t.library.importStatus.duplicate}</span>{" "}
                      <button
                        type="button"
                        className="break-all text-left text-neutral-700 hover:text-blue-600 hover:underline"
                        onClick={() => i.paperId && useLibraryStore.getState().revealPaper(i.paperId)}
                      >
                        {i.fileName}
                      </button>
                      <span className="text-neutral-400"> — {t.library.importStatus.alreadyInLibrary(i.title)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function headline(job: ImportJob, added: number, dups: number): string {
  if (job.items.length === 1) {
    const i = job.items[0];
    if (i.status === "duplicate") return t.library.importStatus.oneDuplicate(i.title ?? i.fileName);
    if (i.status === "added") return t.library.importStatus.oneAdded;
    return t.library.importStatus.oneFailed;
  }
  if (added === 0 && dups === job.items.length) return t.library.importStatus.allDuplicates;
  return t.library.importStatus.done;
}

function Progress({ job }: { job: ImportJob }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-neutral-600">
        <span className="font-medium">
          {t.library.importStatus.progress(Math.min(job.done + 1, job.total), job.total)}
        </span>
        <span className="tabular-nums text-neutral-400">{pct}%</span>
      </div>
      {job.current && <div className="mt-0.5 truncate text-[11.5px] text-neutral-400">{job.current}</div>}
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-neutral-100">
        <div className="h-full rounded-full bg-blue-500 transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Chip({ tone, n, text }: { tone: "green" | "amber" | "red"; n: number; text: string }) {
  const colors = {
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    red: "bg-red-50 text-red-700",
  }[tone];
  return (
    <span className={cx("rounded px-1.5 py-0.5 text-[11.5px]", n ? colors : "bg-neutral-50 text-neutral-400")}>
      {text}
    </span>
  );
}
