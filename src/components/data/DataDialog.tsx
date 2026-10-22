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
import { formatDateTime, relativeTime } from "@/i18n/format";

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
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>数据与备份</Dialog.Title>
            <Dialog.Close className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label="关闭">
              <IconX width={16} height={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">自动保存状态、导出与导入备份</Dialog.Description>
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
      占用空间 {formatBytes(usage.total)}：library.json {formatBytes(usage.library)}、pdfs/ {formatBytes(usage.pdfs)}、backups/ {formatBytes(usage.backups)}
      {usage.trash ? `、trash/ ${formatBytes(usage.trash)}` : ""}
      {groups.length ? `、${groups.join("、")}` : ""}
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

  if (s.phase === "probing") return <Section title="自动保存">正在连接本地服务…</Section>;

  if (s.phase === "needs-migration") {
    return (
      <Section title="自动保存">
        <p className="flex gap-1.5 text-red-700">
          <IconAlert className="mt-0.5 shrink-0" width={15} height={15} />
          <span>
            数据需要迁移到项目结构：请运行 <Path>npm run migrate:projects</Path>。迁移前不会写入 <Path>data/</Path>，本浏览器中的数据不会丢失。
          </span>
        </p>
      </Section>
    );
  }

  if (s.phase === "offline") {
    const days = lastExport ? Math.floor((Date.now() - lastExport) / 86_400_000) : null;
    return (
      <Section title="自动保存">
        <p className="flex gap-1.5 text-amber-700">
          <IconAlert className="mt-0.5 shrink-0" width={15} height={15} />
          <span>未连接本地服务：数据只保存在本浏览器中，清除浏览器数据（或换一个地址、端口打开）就看不到了。</span>
        </p>
        <p>
          用 <Path>npm run dev</Path> 启动 Paperloom 时，数据会自动保存到项目的 <Path>data/</Path> 文件夹。没有本地服务时，建议每周导出一次 JSON 备份。
        </p>
        <p data-testid="storage-last-export">
          上次导出备份：{lastExport ? `${relativeTime(lastExport)}` : "从未导出"}
          {(days === null || days >= BACKUP_REMIND_DAYS) && <span className="text-amber-700">（建议现在导出一份）</span>}
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
    <Section title="自动保存">
      <p>
        数据自动保存在 <Path>{s.dataDir}</Path>：<Path>library.json</Path> 是全部笔记和批注，<Path>pdfs/</Path> 是 PDF 原文件，
        <Path>backups/</Path> 里有按小时滚动的历史版本。浏览器数据被清除时，打开 Paperloom 会自动从这里恢复。
      </p>
      <p>
        {s.phase === "saved" && s.lastSavedAt ? `上次保存：${relativeTime(s.lastSavedAt)}` : null}
        {s.phase === "pending" || s.phase === "saving" ? "正在保存…" : null}
        {s.phase === "restoring" ? "正在恢复…" : null}
        {s.phase === "conflict" ? "自动保存已暂停：文件夹中的数据与本浏览器不一致，请在提示中选择保留哪一份。" : null}
        {s.phase === "error" ? <span className="text-red-600">{s.error}</span> : null}
        {s.activity ? ` · ${s.activity.kind === "pdf-upload" ? "正在保存 PDF" : "正在从 data/pdfs 取回 PDF"} ${s.activity.done}/${s.activity.total}` : null}
      </p>
      {s.missingPdfs > 0 && (
        <p className="text-amber-700" data-testid="storage-missing-pdfs">
          {s.missingPdfs} 个 PDF 文件在本浏览器和 data/pdfs 中都找不到，打开对应论文时请重新导入该文件。
        </p>
      )}
      {s.failedPdfUploads > 0 && (
        <p className="text-amber-700" data-testid="storage-failed-uploads">
          {s.failedPdfUploads} 个 PDF 无法保存到 data/pdfs（本地服务拒绝了，详见浏览器控制台），它们仍保存在本浏览器中。
        </p>
      )}
      <Usage />
      {err && <p className="text-red-600">{err}</p>}
      <div>
        <button type="button" className={btnOutline} onClick={save} disabled={busy || s.phase === "conflict"}>
          {busy ? "正在保存…" : "立即保存"}
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

  const run = async (kind: "json" | "md") => {
    setBusy(kind);
    setMsg(null);
    try {
      if (kind === "json") {
        const { name } = await exportJsonBackup();
        setMsg({ ok: true, text: `已下载 ${name}` });
      } else {
        const r = await exportMarkdown();
        setMsg({ ok: true, text: r.mode === "folder" ? `已更新 ${r.path}/` : `已下载 ${r.name}` });
      }
    } catch (e) {
      setMsg({ ok: false, text: `导出失败：${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="导出">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnOutline} onClick={() => run("json")} disabled={!!busy} data-testid="export-json">
          <IconDownload width={15} height={15} />
          {busy === "json" ? "正在导出…" : "导出 JSON 备份"}
        </button>
        <button type="button" className={btnOutline} onClick={() => run("md")} disabled={!!busy} data-testid="export-markdown">
          {online ? <IconFolder width={15} height={15} /> : <IconDownload width={15} height={15} />}
          {busy === "md" ? "正在导出…" : online ? "重新生成 Markdown" : "导出 Markdown"}
        </button>
      </div>
      <p className="text-[12px] text-neutral-500">
        JSON 备份包含全部论文信息、批注、术语、画布和设置，不含 PDF 文件。
        {online ? (
          <>
            {" "}
            Markdown（每个术语、每篇论文一个文件，可用 Obsidian 打开）自动生成在 <Path>{`${s.dataDir}/markdown/`}</Path>
            {s.markdownAt ? `，上次生成：${relativeTime(s.markdownAt)}` : ""}。
          </>
        ) : (
          " Markdown 导出为一个合并的 .md 文件（术语与批注）。"
        )}
      </p>
      {s.markdownError && online && <p className="text-red-600">Markdown 生成失败：{s.markdownError}</p>}
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
      if (backup?.where === "folder") detail.unshift(`原来的数据已备份到 ${dataDir}/backups/${backup.name}`);
      if (backup?.where === "download") detail.unshift(`原来的数据已下载为 ${backup.name}`);
      if (c.papers) detail.push("本浏览器中没有的 PDF 需要重新导入（有本地服务时会自动从 data/pdfs 取回）");
      setPrepared(null);
      setState({ kind: "done", text: `已导入 ${c.papers} 篇论文、${c.terms} 个术语、${c.annotations} 条批注`, detail });
    } catch (e) {
      if ((e as { name?: string }).name === "ChangedSinceBackupError") {
        setOfflineBackup(null);
        setSavedConfirmed(false);
      }
      setState({ kind: "error", text: `导入失败：${errorText(e)}` });
    }
  };

  const downloadBackup = async () => {
    try {
      const b = await downloadPreImportBackup();
      setOfflineBackup(b);
      setSavedConfirmed(!b.name); // 本地没有数据时不用确认
    } catch (e) {
      setState({ kind: "error", text: `下载备份失败：${errorText(e)}` });
    }
  };
  const canConfirm = online || (!!offlineBackup && savedConfirmed);

  const p = prepared?.preview;
  return (
    <Section title="导入备份">
      <p>从 JSON 备份恢复：会替换本浏览器中的全部数据。</p>
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
          {state.kind === "reading" ? "正在读取…" : state.kind === "importing" ? "正在导入…" : "选择 JSON 文件…"}
        </button>
      )}
      {prepared && p && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3" data-testid="import-preview">
          <div className="font-medium text-neutral-800">{prepared.fileName}</div>
          <div className="mt-1 text-neutral-700">
            包含 {p.counts.papers} 篇论文、{p.counts.terms} 个术语、{p.counts.annotations} 条批注、{p.counts.boards} 块画布
            {p.counts.domains ? `、${p.counts.domains} 个领域` : ""}
            {p.exportedAt ? `（导出于 ${formatDateTime(p.exportedAt)}）` : ""}
          </div>
          {p.repairs.map((r, i) => (
            <div key={i} className="mt-0.5 text-[12px] text-neutral-500">
              {r}
            </div>
          ))}
          <div className="mt-2 text-[12px] text-amber-800">
            {online
              ? `导入会替换本浏览器中的全部数据。替换前会先把当前数据备份到 ${dataDir}/backups/。`
              : "导入会替换本浏览器中的全部数据。没有本地服务，请先下载当前数据的备份并确认已保存好。"}
          </div>
          {!online && (
            <div className="mt-2 space-y-1.5">
              <button type="button" className={btnOutline} onClick={downloadBackup} data-testid="import-download-backup">
                <IconDownload width={15} height={15} />
                {offlineBackup ? "重新下载备份" : "第一步：下载当前数据的备份"}
              </button>
              {offlineBackup?.name && (
                <label className="flex items-center gap-1.5 text-[12px] text-neutral-700">
                  <input
                    type="checkbox"
                    checked={savedConfirmed}
                    onChange={(e) => setSavedConfirmed(e.target.checked)}
                    data-testid="import-backup-saved"
                  />
                  我已保存好 {offlineBackup.name}
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
              {state.kind === "importing" ? "正在导入…" : "替换当前数据"}
            </button>
            <button type="button" className={btnGhost} onClick={() => setPrepared(null)} disabled={state.kind === "importing"}>
              取消
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
