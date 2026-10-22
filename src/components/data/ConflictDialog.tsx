// 文件夹与本浏览器的数据不一致时让用户选择保留哪一份（自动保存在此期间暂停）
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useStorageStore } from "@/app/stores/storage";
import { btnGhost, btnOutline, btnPrimary, cx, dialogContent, dialogOverlay, dialogTitle } from "@/components/library/ui";
import { resolveStorageConflict, shortDirLabel, type ConflictChoice } from "@/services/storage/sync";
import { t } from "@/i18n";
import { Trans } from "@/i18n/Trans";
import { IconX } from "./icons";

export function ConflictDialog() {
  const open = useStorageStore((s) => s.conflictDialogOpen);
  const setOpen = useStorageStore((s) => s.setConflictDialogOpen);
  const phase = useStorageStore((s) => s.phase);
  const conflict = useStorageStore((s) => s.conflict);
  const dir = shortDirLabel(useStorageStore((s) => s.dataDirLabel));
  const [busy, setBusy] = useState<ConflictChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 冲突已解决（或在其他标签页解决了）就关闭
  const show = open && (phase === "conflict" || busy !== null) && !!conflict;

  const choose = async (choice: ConflictChoice) => {
    setBusy(choice);
    setError(null);
    try {
      await resolveStorageConflict(choice);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!conflict) return null;
  const kind = conflict.kind;
  const m = t.data.conflict;
  const TITLES: Record<typeof kind, string> = {
    revision: m.title.revision,
    "local-empty": m.title.localEmpty,
    "newer-format": m.title.newerFormat(dir),
    "db-reset": m.title.dbReset,
    unreadable: m.title.unreadable(dir),
  };
  // 每种情况下两个按钮的文字（第一个为主要操作）；null 表示不显示
  const primary: [ConflictChoice, string] | null =
    kind === "newer-format"
      ? null
      : kind === "unreadable"
        ? ["recover-backup", m.recoverBackup]
        : kind === "revision"
          ? ["load-folder", m.loadFolder]
          : ["load-folder", m.restoreFrom(dir)];
  const secondary: [ConflictChoice, string] | null =
    kind === "newer-format"
      ? null
      : kind === "local-empty"
        ? ["overwrite-folder", m.clearFolder(dir)]
        : kind === "db-reset"
          ? ["overwrite-folder", m.writeCurrent(dir)]
          : kind === "unreadable"
            ? ["overwrite-folder", m.overwriteDamaged]
            : ["overwrite-folder", m.overwriteFolder];
  const busyText = (c: ConflictChoice) => (c === "overwrite-folder" ? m.saving : m.loading);
  const title = TITLES[kind];
  const withDir = (text: string) => <Trans text={text} values={{ dir }} />;

  return (
    <Dialog.Root open={show} onOpenChange={(o) => !busy && setOpen(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={cx(dialogContent, "w-[min(92vw,500px)]")} data-testid="storage-conflict-dialog" data-kind={kind}>
          <div className="mb-3 flex items-start gap-3">
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>{title}</Dialog.Title>
            <Dialog.Close
              className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              aria-label={t.common.close}
              disabled={!!busy}
            >
              <IconX width={16} height={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <div className="space-y-2 text-[13px] leading-relaxed text-neutral-600">
              {kind === "revision" && (
                <>
                  <p>{withDir(m.revisionBody)}</p>
                  <p className="text-[12px] text-neutral-500">{withDir(m.backupNote)}</p>
                </>
              )}
              {kind === "local-empty" && (
                <>
                  <p>{withDir(m.localEmptyBody)}</p>
                  <p className="text-[12px] text-neutral-500">{withDir(m.localEmptyNote)}</p>
                </>
              )}
              {kind === "newer-format" && <p>{withDir(m.newerFormatBody)}</p>}
              {kind === "db-reset" && (
                <>
                  <p>{withDir(m.dbResetBody)}</p>
                  <p className="text-[12px] text-neutral-500">{withDir(m.dbResetNote)}</p>
                </>
              )}
              {kind === "unreadable" && (
                <>
                  <p>{withDir(m.unreadableBody)}</p>
                  <p className="text-[12px] text-neutral-500">{withDir(m.unreadableNote)}</p>
                </>
              )}
            </div>
          </Dialog.Description>
          {error && <p className="mt-2 text-[12.5px] text-red-600">{error}</p>}
          <div className="mt-4 flex flex-col gap-2">
            {primary && (
              <button type="button" className={btnPrimary} onClick={() => choose(primary[0])} disabled={!!busy} data-testid={`conflict-${primary[0]}`}>
                {busy === primary[0] ? busyText(primary[0]) : primary[1]}
              </button>
            )}
            {secondary && (
              <button type="button" className={btnOutline} onClick={() => choose(secondary[0])} disabled={!!busy} data-testid={`conflict-${secondary[0]}`}>
                {busy === secondary[0] ? busyText(secondary[0]) : secondary[1]}
              </button>
            )}
            <button type="button" className={btnGhost} onClick={() => setOpen(false)} disabled={!!busy}>
              {kind === "newer-format" ? m.gotIt : m.later}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
