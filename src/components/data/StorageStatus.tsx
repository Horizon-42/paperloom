// 侧栏底部：自动保存状态（点击打开"数据与备份"对话框）、恢复结果提示、冲突对话框、需要迁移时的阻断提示。
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useStorageStore, type StorageSyncState } from "@/app/stores/storage";
import { db } from "@/db/schema";
import { cx } from "@/components/library/ui";
import { BACKUP_REMIND_DAYS, LAST_EXPORT_KEY } from "@/services/storage/exportImport";
import { shortDirLabel } from "@/services/storage/sync";
import { ConflictDialog } from "./ConflictDialog";
import { DataDialog } from "./DataDialog";
import { MigrationNotice } from "./MigrationNotice";
import { IconX } from "./icons";
import { relativeTime } from "@/i18n/format";

const DAY = 86_400_000;

/** 每 30 秒刷新一次相对时间 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** 没有本地服务时：距上次导出（或最早导入论文）超过一周则提醒导出备份。返回天数，不需要提醒时为 null */
export function useBackupReminder(enabled: boolean, now: number): number | null {
  const info = useLiveQuery(async () => {
    if (!enabled) return null;
    const [rec, oldest] = await Promise.all([db.kv.get(LAST_EXPORT_KEY), db.papers.orderBy("addedAt").first()]);
    return { last: typeof rec?.value === "number" ? rec.value : null, oldest: oldest?.addedAt ?? null };
  }, [enabled]);
  if (!enabled || !info || info.oldest === null) return null;
  const since = info.last ?? info.oldest;
  // now 每 30 秒才更新一次，数据刚变化时用当前时间
  const days = Math.floor((Math.max(now, Date.now()) - since) / DAY);
  return days >= BACKUP_REMIND_DAYS ? days : null;
}

type Tone = "gray" | "green" | "blue" | "amber" | "red";

function describe(s: StorageSyncState, now: number, remindDays: number | null): { tone: Tone; text: string; busy?: boolean } {
  const dir = shortDirLabel(s.dataDirLabel);
  switch (s.phase) {
    case "probing":
      return { tone: "gray", text: "正在连接本地服务…" };
    case "offline":
      return remindDays !== null
        ? { tone: "amber", text: `数据只在本浏览器中 · 已 ${remindDays} 天未导出备份` }
        : { tone: "amber", text: "未连接本地服务：数据只保存在本浏览器中" };
    case "restoring":
      return { tone: "blue", text: `正在从 ${dir} 恢复…`, busy: true };
    case "pending":
    case "saving":
      return { tone: "blue", text: "正在保存…", busy: true };
    case "conflict":
      if (s.conflict?.kind === "local-empty") return { tone: "red", text: "本浏览器的数据已被清空，自动保存已暂停" };
      if (s.conflict?.kind === "newer-format") return { tone: "red", text: `${dir} 中的数据来自更新版本，自动保存已暂停` };
      if (s.conflict?.kind === "db-reset") return { tone: "red", text: "本地数据库已被重置，自动保存已暂停" };
      if (s.conflict?.kind === "unreadable") return { tone: "red", text: `${dir}library.json 无法读取，自动保存已暂停` };
      return { tone: "red", text: "文件夹中的数据已被另一个窗口更新" };
    case "error":
      return { tone: "red", text: s.error ?? "保存失败" };
    case "needs-migration":
      return { tone: "red", text: "数据需要迁移到项目结构，自动保存已暂停" };
    case "saved": {
      const a = s.activity;
      if (a) {
        const what = a.kind === "pdf-upload" ? "正在保存 PDF" : "正在取回 PDF";
        return { tone: "blue", text: `已保存到 ${dir} · ${what} ${Math.min(a.done + 1, a.total)}/${a.total}`, busy: true };
      }
      return { tone: "green", text: `已保存到 ${dir}${s.lastSavedAt ? ` · ${relativeTime(s.lastSavedAt, now)}` : ""}` };
    }
  }
}

const DOT: Record<Tone, string> = {
  gray: "bg-neutral-300",
  green: "bg-emerald-500",
  blue: "bg-blue-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

export function StorageStatus() {
  const s = useStorageStore();
  const now = useNow();
  const remindDays = useBackupReminder(s.phase === "offline", now);
  const { tone, text, busy } = describe(s, now, remindDays);

  // 出现冲突时弹出对话框（关掉后点状态栏可再打开）
  const conflictKey = s.phase === "conflict" ? `${s.conflict?.kind}:${s.conflict?.folderRevision}` : null;
  useEffect(() => {
    if (conflictKey) useStorageStore.getState().setConflictDialogOpen(true);
  }, [conflictKey]);

  const open = () => {
    if (s.phase === "conflict") s.setConflictDialogOpen(true);
    else s.setDialogOpen(true);
  };

  return (
    <>
      {s.strayLegacyFiles.length > 0 && <StrayLegacyWarning files={s.strayLegacyFiles} />}
      {s.phase === "offline" && <BrowserOnlyHint onExport={() => s.setDialogOpen(true)} />}
      {s.notice && <Notice />}
      <button
        type="button"
        onClick={open}
        className="flex w-full items-center gap-2 border-t border-neutral-200 px-3 py-2 text-left text-[11.5px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
        title={s.dataDir ? `数据与备份（${s.dataDir}）` : "数据与备份"}
        data-testid="storage-status"
        data-phase={s.phase}
      >
        <span className={cx("h-2 w-2 shrink-0 rounded-full", DOT[tone], busy && "animate-pulse")} aria-hidden />
        <span className={cx("min-w-0 flex-1 truncate", (tone === "red" || tone === "amber") && "text-neutral-700")}>{text}</span>
      </button>
      <DataDialog />
      <ConflictDialog />
      <MigrationNotice />
    </>
  );
}

// 与项目无关：每个浏览器只需看一次
const BROWSER_ONLY_HINT_KEY = "paperlens:browser-only-hint-dismissed";

/** 没有本地服务（如在线版）时的首次提示：数据只在浏览器里，清除网站数据会一并删除 */
function BrowserOnlyHint({ onExport }: { onExport: () => void }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(BROWSER_ONLY_HINT_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(BROWSER_ONLY_HINT_KEY, "1");
    } catch {
      // 存不了就只在本次隐藏
    }
  };
  return (
    <div className="border-t border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900" role="note" data-testid="browser-only-hint">
      <div className="space-y-1 leading-snug">
        <div className="font-medium">数据只保存在这个浏览器里</div>
        <div className="text-amber-800">论文和批注不会上传到任何服务器。但清除浏览器的网站数据、换浏览器或换电脑后都会看不到，请定期导出备份。</div>
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onExport} className="rounded bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-700">
          导出备份
        </button>
        <button type="button" onClick={dismiss} className="rounded px-2 py-1 text-amber-800 hover:bg-amber-100">
          知道了
        </button>
      </div>
    </div>
  );
}

/** data/ 根目录下又出现了旧版文件：多半是迁移后又启动过旧版本，它把改动写在了根目录（新版本不读取） */
function StrayLegacyWarning({ files }: { files: string[] }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const shown = files.slice(0, 4).join("、") + (files.length > 4 ? ` 等 ${files.length} 项` : "");
  return (
    <div className="border-t border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900" role="alert" data-testid="stray-legacy-warning">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1 leading-snug">
          <div className="font-medium">data/ 根目录下有旧版本写入的文件：{shown}</div>
          <div className="text-amber-800">
            可能是迁移到项目结构之后又启动过旧版本。新版本不读取这些文件。如果在旧版本里做过改动，请在「数据与备份」中导入 data/library.json（导入前会自动备份当前数据）；
            确认不需要之后，把这些文件移出 data/（例如移到 data-backup-before-projects-旧版残留/）。
          </div>
        </div>
        <button type="button" onClick={() => setHidden(true)} className="rounded p-0.5 text-amber-500 hover:bg-amber-100 hover:text-amber-800" aria-label="暂时隐藏提示">
          <IconX width={14} height={14} />
        </button>
      </div>
    </div>
  );
}

function Notice() {
  const notice = useStorageStore((s) => s.notice);
  const dismiss = useStorageStore((s) => s.dismissNotice);
  // 成功提示 15 秒后自动收起
  useEffect(() => {
    if (notice?.tone !== "success") return;
    const t = window.setTimeout(dismiss, 15_000);
    return () => window.clearTimeout(t);
  }, [notice, dismiss]);
  if (!notice) return null;
  const color = notice.tone === "error" ? "text-red-700" : notice.tone === "success" ? "text-emerald-700" : "text-neutral-700";
  return (
    <div className="border-t border-neutral-200 bg-white px-3 py-2.5 text-xs" role="status" aria-live="polite" data-testid="storage-notice">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className={cx("font-medium leading-snug", color)}>{notice.text}</div>
          {notice.detail?.map((d, i) => (
            <div key={i} className="mt-0.5 leading-snug text-neutral-500">
              {d}
            </div>
          ))}
        </div>
        {notice.tone !== "info" && (
          <button
            type="button"
            onClick={dismiss}
            className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
            aria-label="关闭提示"
          >
            <IconX width={14} height={14} />
          </button>
        )}
      </div>
    </div>
  );
}
