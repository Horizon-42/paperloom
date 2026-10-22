// 导出 JSON / Markdown、导入 JSON 备份（开发文档 F4.1、F4.2）。供数据对话框调用。
import { db } from "@/db/schema";
import { scheduleIndex } from "@/services/indexer";
import { DataFormatError } from "./format";
import { getServiceStatus, getStorageRunner, regenerateMarkdown } from "./sync";
import type { ImportPreview, ReplaceResult } from "./tasks";

/** kv：上次导出 JSON 备份的时间（没有本地服务时据此提醒每周备份）。storage: 前缀不导出 */
export const LAST_EXPORT_KEY = "storage:lastExportAt";
export const BACKUP_REMIND_DAYS = 7;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}${pad(d.getMinutes())}`;

export function backupFileName(d = new Date()): string {
  return `paperlens-backup-${ymd(d)}.json`;
}

/** 触发浏览器下载 */
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function recordExport(): Promise<void> {
  await db.kv.put({ key: LAST_EXPORT_KEY, value: Date.now() });
}

/** 导出全部数据为 JSON（不含 PDF）并下载 */
export async function exportJsonBackup(): Promise<{ name: string }> {
  const { text } = await getStorageRunner().call("exportJson");
  const name = backupFileName();
  downloadText(name, text, "application/json");
  await recordExport();
  return { name };
}

export type MarkdownExport = { mode: "folder"; path: string } | { mode: "download"; name: string };

/** 有本地服务：立即重新生成 data/markdown/；没有：下载一个合并的 .md 文件 */
export async function exportMarkdown(): Promise<MarkdownExport> {
  const status = await getServiceStatus();
  if (status) {
    await regenerateMarkdown();
    return { mode: "folder", path: `${status.dataDir}/markdown` };
  }
  const text = await getStorageRunner().call("combinedMarkdown");
  const name = `paperlens-notes-${ymd(new Date())}.md`;
  downloadText(name, text, "text/markdown");
  return { mode: "download", name };
}

export interface PreparedImport {
  fileName: string;
  text: string;
  preview: ImportPreview;
}

/** gzip 文件头 1f 8b：data/backups/ 里的备份是 .json.gz */
async function readMaybeGzip(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return file.text();
  const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** 读取并校验备份文件（.json 或 data/backups/ 里的 .json.gz）。格式不对时抛出 DataFormatError（消息可直接展示） */
export async function prepareImport(file: File): Promise<PreparedImport> {
  let text: string;
  try {
    text = await readMaybeGzip(file);
  } catch {
    throw new DataFormatError("无法读取文件（不是有效的 JSON 或 gzip 文件）");
  }
  const preview = await getStorageRunner().call("previewImport", text);
  return { fileName: file.name, text, preview };
}

export interface PreImportBackup {
  name: string | null;
  /** 备份时本地数据的指纹：导入时据此确认备份之后没有新改动 */
  fingerprint: string;
}

/**
 * 没有本地服务时导入前的第一步：下载一份当前数据（本地没有数据时不下载）。
 * 浏览器不会告诉页面文件是否真的保存了，所以界面要求用户确认后才能进行第二步。
 */
export async function downloadPreImportBackup(): Promise<PreImportBackup> {
  const { text, counts, fingerprint } = await getStorageRunner().call("exportJson");
  if (!(counts.papers || counts.terms || counts.annotations || counts.domains || counts.boards || counts.notes || counts.links)) {
    return { name: null, fingerprint };
  }
  const d = new Date();
  const name = `paperlens-backup-before-import-${ymd(d)}-${hm(d)}.json`;
  downloadText(name, text, "application/json");
  await recordExport();
  return { name, fingerprint };
}

export interface ImportOutcome {
  result: ReplaceResult;
  /** 替换前做的备份 */
  backup: { where: "folder"; name: string } | { where: "download"; name: string } | null;
}

/** 下载备份之后本地又有改动（替换会丢掉这些改动） */
export class ChangedSinceBackupError extends Error {
  override name = "ChangedSinceBackupError";
  constructor() {
    super("下载备份之后本地数据又有改动，请重新下载一份备份再导入");
  }
}

/**
 * 用备份替换全部数据。有本地服务时先把当前数据备份到 data/backups/；没有服务时必须先调用 downloadPreImportBackup，
 * 并把它的结果传进来。替换在同一事务里确认备份之后本地没有新改动，否则不做任何修改。
 */
export async function applyPreparedImport(p: PreparedImport, offlineBackup?: PreImportBackup): Promise<ImportOutcome> {
  const runner = getStorageRunner();
  const status = await getServiceStatus();
  let result: ReplaceResult | null = null;
  let backup: ImportOutcome["backup"] = null;
  if (status) {
    for (let attempt = 0; !result; attempt++) {
      const b = await runner.call("backupLocal", "before-import");
      backup = b.name ? { where: "folder", name: b.name } : null;
      try {
        result = await runner.call("applyImport", { text: p.text, expect: b.fingerprint });
      } catch (e) {
        if ((e as { name?: string }).name !== "LocalChangedError" || attempt >= 2) throw e;
      }
    }
  } else {
    if (!offlineBackup) throw new Error("请先下载当前数据的备份");
    backup = offlineBackup.name ? { where: "download", name: offlineBackup.name } : null;
    try {
      result = await runner.call("applyImport", { text: p.text, expect: offlineBackup.fingerprint });
    } catch (e) {
      if ((e as { name?: string }).name === "LocalChangedError") throw new ChangedSinceBackupError();
      throw e;
    }
  }
  // 全文缓存、出现位置由索引器按需重建；本地没有的 PDF 由存储模块从 data/pdfs 取回
  scheduleIndex();
  return { result, backup };
}
