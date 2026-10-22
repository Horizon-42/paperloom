// 本浏览器里另一个项目（不是当前项目）的数据库：删除项目前确认这里的数据在文件夹里已经有一份，
// 以及在"找不到项目"页面或删除只在本浏览器里的项目前导出。只读，用完即关闭。
// 只在应用启动之后（或"找不到项目"页面里）按需加载：它会加载 db/schema。
import Dexie from "dexie";
import { PaperLensDB } from "@/db/schema";
import { sha256Hex } from "@/lib/hash";
import { dbNameFor, projectApiBase } from "@/lib/project";
import { createStorageApi } from "@/services/storage/api";
import { countTables, hasUserData, serializeDataFile, serializeTables, type DataCounts } from "@/services/storage/format";
import { localFileHashes, readDataSnapshot, referencedFileHashes } from "@/services/storage/snapshot";

export function browserDbExists(id: string): Promise<boolean> {
  return Dexie.exists(dbNameFor(id));
}

/** 打开另一个项目的数据库（必须已存在，否则 Dexie 会新建一个空的） */
async function withProjectDb<T>(id: string, fn: (db: PaperLensDB) => Promise<T>): Promise<T> {
  const db = new PaperLensDB(dbNameFor(id));
  try {
    await db.open();
    return await fn(db);
  } finally {
    db.close();
  }
}

export interface BrowserCopy {
  exists: boolean;
  /** 有用户内容（或设置） */
  hasData: boolean;
  counts: DataCounts | null;
  /** tables 部分的 SHA-256（与 library.json 的 contentHash 同一算法） */
  hash: string | null;
  tablesJson: string | null;
  /** 论文引用、本浏览器里有文件的 PDF */
  localPdfs: string[];
}

export async function inspectBrowserCopy(id: string): Promise<BrowserCopy> {
  if (!(await browserDbExists(id))) return { exists: false, hasData: false, counts: null, hash: null, tablesJson: null, localPdfs: [] };
  return withProjectDb(id, async (db) => {
    const { tables } = await readDataSnapshot(db);
    const tablesJson = serializeTables(tables);
    const counts = countTables(tables);
    const [refs, local] = await Promise.all([referencedFileHashes(db), localFileHashes(db)]);
    return {
      exists: true,
      hasData: hasUserData(counts) || counts.kv > 0,
      counts,
      hash: await sha256Hex(new TextEncoder().encode(tablesJson).buffer as ArrayBuffer),
      tablesJson,
      localPdfs: [...refs.keys()].filter((h) => local.has(h)),
    };
  });
}

export type BrowserCopyState =
  /** 本浏览器里没有这个项目的数据库，或是空的 */
  | { state: "none" }
  /** 文件夹里的 library.json 与本浏览器的数据相同，PDF 也都在 */
  | { state: "synced" }
  /** 有文件夹里没有的内容：删除浏览器里的数据库会丢 */
  | { state: "unsynced"; detail: string };

/** 本浏览器里这个项目的数据是否已经完整地在它的文件夹里（删除浏览器里的数据库前调用） */
export async function browserCopyState(id: string): Promise<BrowserCopyState> {
  const copy = await inspectBrowserCopy(id);
  if (!copy.exists || (!copy.hasData && !copy.localPdfs.length)) return { state: "none" };
  const api = createStorageApi(projectApiBase(id));
  const st = await api.status();
  if (!st || st.needsMigration) throw new Error("无法连接本地服务，不能确认文件夹里的数据是否完整");
  if (!st.library.contentHash || st.library.contentHash !== copy.hash) {
    return { state: "unsynced", detail: st.library.exists ? "文件夹里的 library.json 与本浏览器的数据不一致，可能有尚未保存的改动" : "文件夹里还没有 library.json" };
  }
  const { hashes, trashed } = await api.listPdfs();
  const onServer = new Set([...hashes, ...trashed]);
  const missing = copy.localPdfs.filter((h) => !onServer.has(h));
  if (missing.length) return { state: "unsynced", detail: `${missing.length} 个 PDF 还没有保存到文件夹` };
  return { state: "synced" };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 把本浏览器里这个项目的数据下载为 JSON 备份（与"数据与备份"里的导出格式相同，不含 PDF）；没有数据时返回 null */
export async function exportBrowserCopy(id: string, label: string): Promise<string | null> {
  const copy = await inspectBrowserCopy(id);
  if (!copy.exists || !copy.tablesJson || !copy.hasData) return null;
  const d = new Date();
  const safe = label.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || id;
  const name = `paperlens-${safe}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  const text = serializeDataFile(copy.tablesJson, { exportedAt: d.toISOString() });
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
}
