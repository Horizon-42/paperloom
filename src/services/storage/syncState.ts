// 本浏览器（本源）与当前项目的 data/projects/<id>/ 的同步记录：上次保存或载入时文件夹的 revision、当时本地数据的哈希。
// 存在 localStorage：与 IndexedDB 一样按源隔离、被同源的标签页共享，而且写它不会触发数据变化事件。
// 键按项目区分（lib/project.ts 的 projectKey）：default 项目沿用原来的键。
import { projectKey } from "@/lib/project";

const KEY = "paperlens:storage:sync";

export interface SyncRecord {
  /** 对应哪个数据目录；换了目录则视为从未同步 */
  dataDir: string;
  /** 0 表示未知 */
  revision: number;
  /** 与该 revision 对应的本地数据哈希；null 表示未知 */
  hash: string | null;
}

/** 迁移前的同步记录：以 data/ 根目录为标识，及迁移后项目文件夹当前的 revision 与内容哈希 */
export interface LegacySyncAlias {
  dataDir: string;
  revision: number;
  contentHash: string | null;
}

/**
 * 迁移到项目结构之前，default 项目的同步记录以 data/ 根目录为标识；迁移把根目录的内容原样移进 data/projects/default/，
 * revision 与内容都不变。所以只有记录的 revision 和数据哈希都与项目文件夹当前的一致时才沿用它；
 * 否则（例如迁移后又运行过旧版本，它在根目录写出了另一份数据）当作不知道同步到哪里，交给冲突处理，绝不按它快进覆盖本地数据。
 */
export function loadSyncRecord(dataDir: string, legacy?: LegacySyncAlias): SyncRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(projectKey(KEY)) ?? "null") as Partial<SyncRecord> | null;
    if (raw && typeof raw.dataDir === "string" && Number.isInteger(raw.revision)) {
      const hash = typeof raw.hash === "string" ? raw.hash : null;
      if (raw.dataDir === dataDir) return { dataDir, revision: raw.revision!, hash };
      if (legacy && raw.dataDir === legacy.dataDir && raw.revision === legacy.revision && hash !== null && hash === legacy.contentHash) {
        return { dataDir, revision: raw.revision!, hash };
      }
    }
  } catch {
    // localStorage 不可用或内容损坏
  }
  return { dataDir, revision: 0, hash: null };
}

export function saveSyncRecord(rec: SyncRecord): void {
  try {
    localStorage.setItem(projectKey(KEY), JSON.stringify(rec));
  } catch {
    // 忽略：下次启动按未知处理（最坏情况是多一次冲突提示）
  }
}

const DB_KEY = "paperlens:storage:dbInstance";

/** 本源上次见到的 IndexedDB 实例标识（与数据库 kv 里的 storage:dbInstance 对照，见 snapshot.ts） */
export function loadDbInstance(): string | null {
  try {
    return localStorage.getItem(projectKey(DB_KEY));
  } catch {
    return null;
  }
}

export function saveDbInstance(id: string): void {
  try {
    localStorage.setItem(projectKey(DB_KEY), id);
  } catch {
    // 忽略：下次启动时按首次使用处理
  }
}

export function newDbInstanceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
