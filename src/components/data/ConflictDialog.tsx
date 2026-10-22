// 文件夹与本浏览器的数据不一致时让用户选择保留哪一份（自动保存在此期间暂停）
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useStorageStore } from "@/app/stores/storage";
import { btnGhost, btnOutline, btnPrimary, cx, dialogContent, dialogOverlay, dialogTitle } from "@/components/library/ui";
import { resolveStorageConflict, shortDirLabel, type ConflictChoice } from "@/services/storage/sync";
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
  const TITLES: Record<typeof kind, string> = {
    revision: "文件夹中的数据已被另一个窗口更新",
    "local-empty": "本浏览器中的数据已被清空",
    "newer-format": `${dir} 中的数据来自更新版本的 Paperloom`,
    "db-reset": "本地数据库已被重置",
    unreadable: `${dir}library.json 无法读取`,
  };
  // 每种情况下两个按钮的文字（第一个为主要操作）；null 表示不显示
  const primary: [ConflictChoice, string] | null =
    kind === "newer-format"
      ? null
      : kind === "unreadable"
        ? ["recover-backup", "从最近的可读备份恢复"]
        : kind === "revision"
          ? ["load-folder", "载入文件夹的数据（替换本浏览器中的数据）"]
          : ["load-folder", `从 ${dir} 恢复（替换本浏览器中的数据）`];
  const secondary: [ConflictChoice, string] | null =
    kind === "newer-format"
      ? null
      : kind === "local-empty"
        ? ["overwrite-folder", `清空 ${dir} 中的数据`]
        : kind === "db-reset"
          ? ["overwrite-folder", `把当前数据写入 ${dir}（会先备份）`]
          : kind === "unreadable"
            ? ["overwrite-folder", "用本浏览器的数据覆盖（损坏的文件会先备份）"]
            : ["overwrite-folder", "用本浏览器的数据覆盖文件夹"];
  const busyText = (c: ConflictChoice) => (c === "overwrite-folder" ? "正在保存…" : "正在载入…");
  const title = TITLES[kind];

  return (
    <Dialog.Root open={show} onOpenChange={(o) => !busy && setOpen(o)}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={cx(dialogContent, "w-[min(92vw,500px)]")} data-testid="storage-conflict-dialog" data-kind={kind}>
          <div className="mb-3 flex items-start gap-3">
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>{title}</Dialog.Title>
            <Dialog.Close
              className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              aria-label="关闭"
              disabled={!!busy}
            >
              <IconX width={16} height={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <div className="space-y-2 text-[13px] leading-relaxed text-neutral-600">
              {kind === "revision" && (
                <>
                  <p>
                    另一个窗口（例如用另一个地址或端口打开的 Paperloom）向 {dir} 保存了数据，而本浏览器中也有尚未保存的改动。
                    自动保存已暂停，请选择保留哪一份。
                  </p>
                  <p className="text-[12px] text-neutral-500">被替换的那一份会先备份到 {dir}backups/。</p>
                </>
              )}
              {kind === "local-empty" && (
                <>
                  <p>本浏览器中已经没有任何论文、批注和术语（可能清除了浏览器数据），但 {dir} 中还保存着数据。</p>
                  <p className="text-[12px] text-neutral-500">如果是有意删除了全部内容，可以选择清空文件夹中的数据（会先备份到 {dir}backups/）。</p>
                </>
              )}
              {kind === "newer-format" && (
                <p>请先更新 Paperloom 再打开。在此之前不会向 {dir} 写入任何内容，本浏览器中的改动仍然保存在浏览器里。</p>
              )}
              {kind === "db-reset" && (
                <>
                  <p>
                    本浏览器的数据库被清空后重新建立了（例如清除了浏览器数据），现在里面只有之后新建的内容。为免用这点数据覆盖 {dir}
                    中的完整文件库，自动保存已暂停。
                  </p>
                  <p className="text-[12px] text-neutral-500">两种选择都会先把将被替换的那一份备份到 {dir}backups/。</p>
                </>
              )}
              {kind === "unreadable" && (
                <>
                  <p>{dir}library.json 无法解析（可能被其他程序改坏了）。自动保存已暂停，不会用本浏览器的数据直接覆盖它。</p>
                  <p className="text-[12px] text-neutral-500">
                    可以用 {dir}backups/ 中最近一个可读的版本替换它（本浏览器的数据会先备份），或者用本浏览器的数据覆盖（损坏的文件会先另存）。
                  </p>
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
              {kind === "newer-format" ? "知道了" : "稍后决定"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
