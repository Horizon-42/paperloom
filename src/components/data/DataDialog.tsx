// "数据与备份"对话框：自动保存状态、导出 JSON / Markdown、导入 JSON 备份（开发文档 F4.1、F4.2）
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useLiveQuery } from "dexie-react-hooks";
import { isStorageOnline, useStorageStore } from "@/app/stores/storage";
import { db } from "@/db/schema";
import { btnDanger, btnGhost, btnOutline, cx, dialogContent, dialogOverlay, dialogTitle } from "@/components/library/ui";
import type { StorageUsage } from "@/services/storage/api";
import {
  applyPreparedImport,
  BACKUP_REMIND_DAYS,
  downloadPreImportBackup,
  exportJsonBackup,
  exportMarkdown,
  LAST_EXPORT_KEY,
  prepareImport,
  type PreImportBackup,
  type PreparedImport,
} from "@/services/storage/exportImport";
import { flushStorage, getStorageApi } from "@/services/storage/sync";
import { IconAlert, IconDownload, IconFolder, IconUpload, IconX } from "./icons";
import { t } from "@/i18n";
import { formatDateTime, relativeTime } from "@/i18n/format";
import { Trans } from "@/i18n/Trans";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DataDialog() {
  const open = useStorageStore((s) => s.dialogOpen);
  const setOpen = useStorageStore((s) => s.setDialogOpen);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={cx(dialogContent, "w-[min(92vw,540px)] max-h-[88vh] overflow-y-auto")} data-testid="storage-dialog">
          <div className="mb-3 flex items-start gap-3">
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>{t.data.dialog.title}</Dialog.Title>
            <Dialog.Close className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label={t.common.close}>
              <IconX width={16} height={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{t.data.dialog.description}</Dialog.Description>
          <AutoSaveSection />
          <ExportSection />
          <ImportSection />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-neutral-100 py-3.5 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-[13px] font-semibold text-neutral-800">{title}</h3>
      <div className="space-y-2 text-[12.5px] leading-relaxed text-neutral-600">{children}</div>
    </section>
  );
}

const Path = ({ children }: { children: ReactNode }) => (
  <code className="break-all rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11.5px] text-neutral-700">{children}</code>
);

// ---------- 自动保存 ----------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** data/ 各部分占用的磁盘空间（打开对话框时读一次） */
function Usage() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    getStorageApi()
      .usage()
      .then((u) => !cancelled && setUsage(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!usage) return null;
  const groups = Object.entries(usage.groups).map(([g, n]) => `${g}/ ${formatBytes(n)}`);
  return (
    <p className="text-[12px] text-neutral-500" data-testid="storage-usage">
      {t.data.dialog.autoSave.usage({
        total: formatBytes(usage.total),
        library: formatBytes(usage.library),
        pdfs: formatBytes(usage.pdfs),
        backups: formatBytes(usage.backups),
        trash: usage.trash ? formatBytes(usage.trash) : null,
        groups,
      })}
    </p>
  );
}

function AutoSaveSection() {
  const s = useStorageStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lastExport = useLiveQuery(async () => {
    const rec = await db.kv.get(LAST_EXPORT_KEY);
    return typeof rec?.value === "number" ? rec.value : null;
  });
  const m = t.data.dialog.autoSave;

  if (s.phase === "probing") return <Section title={m.title}>{m.probing}</Section>;

  if (s.phase === "needs-migration") {
    return (
      <Section title={m.title}>
        <p className="flex gap-1.5 text-red-700">
          <IconAlert className="mt-0.5 shrink-0" width={15} height={15} />
          <span>
            <Trans text={m.needsMigration} values={{ cmd: <Path>npm run migrate:projects</Path>, dir: <Path>data/</Path> }} />
          </span>
        </p>
      </Section>
    );
  }

  if (s.phase === "offline") {
    const days = lastExport ? Math.floor((Date.now() - lastExport) / 86_400_000) : null;
    return (
      <Section title={m.title}>
        <p className="flex gap-1.5 text-amber-700">
          <IconAlert className="mt-0.5 shrink-0" width={15} height={15} />
          <span>{m.offlineWarning}</span>
        </p>
        <p>
          <Trans text={m.offlineHowTo} values={{ cmd: <Path>npm run dev</Path>, dir: <Path>data/</Path> }} />
        </p>
        <p data-testid="storage-last-export">
          {m.lastExport(lastExport ? relativeTime(lastExport) : m.neverExported)}
          {(days === null || days >= BACKUP_REMIND_DAYS) && <span className="text-amber-700">{m.exportNow}</span>}
        </p>
      </Section>
    );
  }

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await flushStorage();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={m.title}>
      <p>
        <Trans
          text={m.onlineInfo}
          values={{ dir: <Path>{s.dataDir}</Path>, library: <Path>library.json</Path>, pdfs: <Path>pdfs/</Path>, backups: <Path>backups/</Path> }}
        />
      </p>
      <p>
        {s.phase === "saved" && s.lastSavedAt ? m.lastSaved(relativeTime(s.lastSavedAt)) : null}
        {s.phase === "pending" || s.phase === "saving" ? m.saving : null}
        {s.phase === "restoring" ? m.restoring : null}
        {s.phase === "conflict" ? m.paused : null}
        {s.phase === "error" ? <span className="text-red-600">{s.error}</span> : null}
        {s.activity ? ` · ${s.activity.kind === "pdf-upload" ? m.pdfUpload : m.pdfFetch} ${s.activity.done}/${s.activity.total}` : null}
      </p>
      {s.missingPdfs > 0 && (
        <p className="text-amber-700" data-testid="storage-missing-pdfs">
          {m.missingPdfs(s.missingPdfs)}
        </p>
      )}
      {s.failedPdfUploads > 0 && (
        <p className="text-amber-700" data-testid="storage-failed-uploads">
          {m.failedUploads(s.failedPdfUploads)}
        </p>
      )}
      <Usage />
      {err && <p className="text-red-600">{err}</p>}
      <div>
        <button type="button" className={btnOutline} onClick={save} disabled={busy || s.phase === "conflict"}>
          {busy ? m.saving : m.saveNow}
        </button>
      </div>
    </Section>
  );
}

// ---------- 导出 ----------

function ExportSection() {
  const s = useStorageStore();
  const online = isStorageOnline(s.phase);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"json" | "md" | null>(null);
  const m = t.data.dialog.export;

  const run = async (kind: "json" | "md") => {
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === "json") {
        const { name } = await exportJsonBackup();
        setMsg({ ok: true, text: m.downloaded(name) });
      } else {
        const r = await exportMarkdown();
        setMsg({ ok: true, text: r.mode === "folder" ? m.updated(r.path) : m.downloaded(r.name) });
      }
    } catch (e) {
      setMsg({ ok: false, text: m.failed(errorText(e)) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title={m.title}>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnOutline} onClick={() => run("json")} disabled={!!busy} data-testid="export-json">
          <IconDownload width={15} height={15} />
          {busy === "json" ? m.exporting : m.json}
        </button>
        <button type="button" className={btnOutline} onClick={() => run("md")} disabled={!!busy} data-testid="export-markdown">
          {online ? <IconFolder width={15} height={15} /> : <IconDownload width={15} height={15} />}
          {busy === "md" ? m.exporting : online ? m.regenerateMarkdown : m.markdown}
        </button>
      </div>
      <p className="text-[12px] text-neutral-500">
        {m.jsonNote}
        {online ? (
          <>
            {" "}
            <Trans
              text={m.markdownFolder}
              values={{ dir: <Path>{`${s.dataDir}/markdown/`}</Path>, last: s.markdownAt ? m.lastGenerated(relativeTime(s.markdownAt)) : "" }}
            />
          </>
        ) : (
          ` ${m.markdownCombined}`
        )}
      </p>
      {s.markdownError && online && <p className="text-red-600">{m.markdownFailed(s.markdownError)}</p>}
      {msg && (
        <p className={msg.ok ? "text-emerald-700" : "text-red-600"} data-testid="export-result">
          {msg.text}
        </p>
      )}
    </Section>
  );
}

// ---------- 导入 ----------

function ImportSection() {
  const online = useStorageStore((s) => isStorageOnline(s.phase));
  const dataDir = useStorageStore((s) => s.dataDir);
  const input = useRef<HTMLInputElement>(null);
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  // 没有本地服务时的第一步：下载当前数据的备份，并由用户确认已保存
  const [offlineBackup, setOfflineBackup] = useState<PreImportBackup | null>(null);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const m = t.data.dialog.import;
  const [state, setState] = useState<{ kind: "idle" | "reading" | "importing" } | { kind: "error"; text: string } | { kind: "done"; text: string; detail: string[] }>({
    kind: "idle",
  });

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setPrepared(null);
    setOfflineBackup(null);
    setSavedConfirmed(false);
    setState({ kind: "reading" });
    try {
      setPrepared(await prepareImport(file));
      setState({ kind: "idle" });
    } catch (e) {
      setState({ kind: "error", text: errorText(e) });
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  const confirm = async () => {
    if (!prepared) return;
    setState({ kind: "importing" });
    try {
      const { result, backup } = await applyPreparedImport(prepared, offlineBackup ?? undefined);
      const c = result.counts;
      const detail = [...result.repairs];
      if (backup?.where === "folder") detail.unshift(m.backedUpTo(`${dataDir}/backups/${backup.name}`));
      if (backup?.where === "download") detail.unshift(m.downloadedAs(backup.name));
      if (c.papers) detail.push(m.pdfsNeeded);
      setPrepared(null);
      setState({ kind: "done", text: m.done(c), detail });
    } catch (e) {
      if ((e as { name?: string }).name === "ChangedSinceBackupError") {
        setOfflineBackup(null);
        setSavedConfirmed(false);
      }
      setState({ kind: "error", text: m.failed(errorText(e)) });
    }
  };

  const downloadBackup = async () => {
    try {
      const b = await downloadPreImportBackup();
      setOfflineBackup(b);
      setSavedConfirmed(!b.name); // 本地没有数据时不用确认
    } catch (e) {
      setState({ kind: "error", text: m.downloadFailed(errorText(e)) });
    }
  };
  const canConfirm = online || (!!offlineBackup && savedConfirmed);

  const p = prepared?.preview;
  return (
    <Section title={m.title}>
      <p>{m.intro}</p>
      <input
        ref={input}
        type="file"
        accept=".json,.gz,application/json,application/gzip"
        className="hidden"
        data-testid="import-json-input"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {!prepared && (
        <button type="button" className={btnOutline} onClick={() => input.current?.click()} disabled={state.kind === "reading" || state.kind === "importing"}>
          <IconUpload width={15} height={15} />
          {state.kind === "reading" ? m.reading : state.kind === "importing" ? m.importing : m.choose}
        </button>
      )}
      {prepared && p && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3" data-testid="import-preview">
          <div className="font-medium text-neutral-800">{prepared.fileName}</div>
          <div className="mt-1 text-neutral-700">
            {m.contains(p.counts)}
            {p.exportedAt ? m.exportedAt(formatDateTime(p.exportedAt)) : ""}
          </div>
          {p.repairs.map((r, i) => (
            <div key={i} className="mt-0.5 text-[12px] text-neutral-500">
              {r}
            </div>
          ))}
          <div className="mt-2 text-[12px] text-amber-800">
            {online ? m.warnOnline(dataDir ?? "data") : m.warnOffline}
          </div>
          {!online && (
            <div className="mt-2 space-y-1.5">
              <button type="button" className={btnOutline} onClick={downloadBackup} data-testid="import-download-backup">
                <IconDownload width={15} height={15} />
                {offlineBackup ? m.downloadAgain : m.downloadFirst}
              </button>
              {offlineBackup?.name && (
                <label className="flex items-center gap-1.5 text-[12px] text-neutral-700">
                  <input
                    type="checkbox"
                    checked={savedConfirmed}
                    onChange={(e) => setSavedConfirmed(e.target.checked)}
                    data-testid="import-backup-saved"
                  />
                  {m.savedConfirm(offlineBackup.name)}
                </label>
              )}
            </div>
          )}
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              className={btnDanger}
              onClick={confirm}
              disabled={state.kind === "importing" || !canConfirm}
              data-testid="import-confirm"
            >
              {state.kind === "importing" ? m.importing : m.replace}
            </button>
            <button type="button" className={btnGhost} onClick={() => setPrepared(null)} disabled={state.kind === "importing"}>
              {t.common.cancel}
            </button>
          </div>
        </div>
      )}
      {state.kind === "error" && (
        <p className="text-red-600" data-testid="import-error">
          {state.text}
        </p>
      )}
      {state.kind === "done" && (
        <div data-testid="import-result">
          <p className="text-emerald-700">{state.text}</p>
          {state.detail.map((d, i) => (
            <p key={i} className="text-[12px] text-neutral-500">
              {d}
            </p>
          ))}
        </div>
      )}
    </Section>
  );
}
