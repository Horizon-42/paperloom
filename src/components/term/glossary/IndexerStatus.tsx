// 后台索引进度：提取全文 / 更新索引；无法提取的论文可展开查看
import * as Popover from "@radix-ui/react-popover";
import { useLiveQuery } from "dexie-react-hooks";
import { useIndexerStore } from "@/app/stores/indexer";
import { listPapers } from "@/db/repo/papers";
import { t } from "@/i18n";
import { retryFailedExtractions } from "@/services/indexer";

export function IndexerStatus() {
  const running = useIndexerStore((s) => s.running);
  const phase = useIndexerStore((s) => s.phase);
  const done = useIndexerStore((s) => s.done);
  const total = useIndexerStore((s) => s.total);
  const failures = useIndexerStore((s) => s.failures);

  const tx = t.term.indexer;
  const label = !running
    ? null
    : phase === "extract"
      ? tx.extracting(Math.min(done + 1, total), total)
      : total > 0
        ? tx.updating(done, total)
        : tx.updatingIndeterminate;
  const ratio = running && total > 0 ? Math.min(1, done / total) : 0;

  return (
    <div className="flex items-center gap-3 text-[12px] text-neutral-500" role="status" aria-live="polite" data-testid="indexer-status">
      {label && (
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
          <span className="tabular-nums">{label}</span>
          {total > 0 && (
            <span className="h-1 w-20 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
              <span className="block h-full rounded-full bg-blue-500 transition-[width]" style={{ width: `${ratio * 100}%` }} />
            </span>
          )}
        </div>
      )}
      {failures.length > 0 && <FailureList failures={failures} />}
    </div>
  );
}

function FailureList({ failures }: { failures: { paperId: string; message: string; autoRetry?: boolean }[] }) {
  const papers = useLiveQuery(listPapers, []);
  const title = (id: string) => papers?.find((p) => p.id === id)?.title ?? id;
  const tx = t.term.indexer;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="rounded px-1.5 py-0.5 text-amber-700 hover:bg-amber-50">
          {tx.failedCount(failures.length)}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-80 rounded-lg border border-neutral-200 bg-white p-3 text-[12.5px] shadow-lg shadow-neutral-900/10"
        >
          <div className="mb-2 flex items-start gap-2">
            <p className="flex-1 text-neutral-500">{tx.failedIntro}</p>
            {failures.length > 1 && (
              <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-50" onClick={() => retryFailedExtractions()}>
                {tx.retryAll}
              </button>
            )}
          </div>
          <ul className="max-h-64 space-y-1.5 overflow-y-auto">
            {failures.map((f) => (
              <li key={f.paperId} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-neutral-800">{title(f.paperId)}</div>
                  <div className="text-[11.5px] text-neutral-400">{f.message}</div>
                </div>
                <button
                  type="button"
                  aria-label={tx.retryPaper(title(f.paperId))}
                  className="shrink-0 rounded px-1.5 py-0.5 text-blue-600 hover:bg-blue-50"
                  onClick={() => retryFailedExtractions([f.paperId])}
                >
                  {t.common.retry}
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
