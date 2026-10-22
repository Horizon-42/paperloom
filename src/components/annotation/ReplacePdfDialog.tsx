// "替换 PDF 文件"对话框：选择新文件 → 替换并重新锚定批注 → 显示结果
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useLiveQuery } from "dexie-react-hooks";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useAppStore } from "@/app/stores/app";
import { getPaper } from "@/db/repo/papers";
import { replacePaperFile, type ReplaceOutcome } from "@/services/reanchorService";
import { IconX } from "@/components/library/icons";
import { t } from "@/i18n";
import { btnGhost, btnOutline, btnPrimary, cx, dialogContent, dialogOverlay, dialogTitle } from "@/components/library/ui";

export function ReplacePdfDialog() {
  const dlg = useAnnotationStore((s) => s.replaceDialog);
  if (!dlg) return null;
  return <ReplaceDialogInner key={dlg.paperId} paperId={dlg.paperId} />;
}

function ReplaceDialogInner({ paperId }: { paperId: string }) {
  const close = useAnnotationStore((s) => s.closeReplaceDialog);
  const paper = useLiveQuery(() => getPaper(paperId).then((p) => p ?? null), [paperId]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReplaceOutcome | null>(null);

  const run = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await replacePaperFile(paperId, file));
    } catch (e) {
      setOutcome({ status: "failed", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const replaced = outcome?.status === "replaced";
  return (
    <Dialog.Root open onOpenChange={(o) => !o && !busy && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={dialogContent} data-replace-dialog>
          <div className="mb-3 flex items-start gap-3">
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>{t.reader.replace.title}</Dialog.Title>
            <Dialog.Close
              className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              aria-label={t.common.close}
              disabled={busy}
            >
              <IconX width={16} height={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <div className="text-[13px] leading-relaxed text-neutral-600">
              {paper && <p className="mb-2 font-medium text-neutral-800">{t.common.quote(paper.title)}</p>}
              <p>{t.reader.replace.intro}</p>
            </div>
          </Dialog.Description>

          {!replaced && (
            <label
              className={cx(
                "mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center text-[13px]",
                "border-neutral-300 text-neutral-500 hover:bg-neutral-50",
                busy && "pointer-events-none opacity-60",
              )}
            >
              <input
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                data-replace-input
                disabled={busy}
                onChange={(e) => {
                  void run(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {busy ? t.reader.replace.busy : t.reader.replace.choose}
            </label>
          )}

          {outcome && <OutcomeMessage outcome={outcome} />}

          <div className="mt-5 flex justify-end gap-2">
            {replaced && outcome.orphaned > 0 && (
              <button
                type="button"
                className={btnOutline}
                onClick={() => {
                  close();
                  useAppStore.getState().setView("annotations");
                }}
              >
                {t.reader.replace.viewOrphaned}
              </button>
            )}
            <button type="button" className={replaced ? btnPrimary : btnGhost} disabled={busy} onClick={close}>
              {replaced ? t.reader.replace.done : t.common.cancel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function OutcomeMessage({ outcome }: { outcome: ReplaceOutcome }) {
  const box = "mt-3 rounded-md px-3 py-2 text-[13px] leading-relaxed";
  const r = t.reader.replace;
  switch (outcome.status) {
    case "unchanged":
      return <p className={cx(box, "bg-neutral-100 text-neutral-700")} data-replace-result="unchanged">{r.unchanged}</p>;
    case "conflict":
      return (
        <p className={cx(box, "bg-red-50 text-red-700")} data-replace-result="conflict">
          {r.conflict(outcome.other.title)}
        </p>
      );
    case "failed":
      return <p className={cx(box, "bg-red-50 text-red-700")} data-replace-result="failed">{r.failed(outcome.error)}</p>;
    case "replaced": {
      if (outcome.reanchorFailed) {
        return (
          <p className={cx(box, "bg-amber-50 text-amber-800")} data-replace-result="replaced" data-reanchor-failed>
            {r.replacedReanchorFailed(outcome.pageCount)}
          </p>
        );
      }
      const total = outcome.relocated + outcome.orphaned + outcome.restored;
      return (
        <p className={cx(box, "bg-green-50 text-green-800")} data-replace-result="replaced">
          {total === 0
            ? r.replacedNothing(outcome.pageCount)
            : r.replacedSummary(outcome.pageCount, outcome.relocated + outcome.restored, outcome.orphaned)}
        </p>
      );
    }
  }
}
