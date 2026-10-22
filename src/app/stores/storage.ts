import { create } from "zustand";

/**
 * 自动保存到 data/projects/<当前项目>/ 的状态：
 * probing 探测本地服务；offline 没有本地服务（数据只在浏览器里）；restoring 正在从文件夹恢复；
 * saved 已保存；pending 有改动等待保存；saving 正在保存；conflict 需要用户决定；error 保存失败（会自动重试）；
 * needs-migration data/ 还是旧版结构，服务不写入，自动保存暂停（数据留在浏览器里，迁移后刷新继续）
 */
export type StoragePhase = "probing" | "offline" | "restoring" | "saved" | "pending" | "saving" | "conflict" | "error" | "needs-migration";

/** 本地服务可以读写（不是探测中、没有服务或等待迁移） */
export function isStorageOnline(phase: StoragePhase): boolean {
  return phase !== "offline" && phase !== "probing" && phase !== "needs-migration";
}

export interface StorageConflict {
  /**
   * revision：文件夹被另一个窗口更新；local-empty：本浏览器的数据被清空；newer-format：文件夹数据来自更新版本；
   * db-reset：本地数据库被清空重建过（之后又有了新数据）；unreadable：data/library.json 无法读取
   */
  kind: "revision" | "local-empty" | "newer-format" | "db-reset" | "unreadable";
  folderRevision: number;
}

export interface StorageActivity {
  kind: "pdf-upload" | "pdf-fetch";
  done: number;
  total: number;
}

export interface StorageNotice {
  tone: "info" | "success" | "error";
  text: string;
  detail?: string[];
}

/** 由 services/storage/sync.ts 写入；负责同步的标签页经 BroadcastChannel 同步给其他标签页 */
export interface StorageSyncState {
  phase: StoragePhase;
  /** 当前项目数据目录的绝对路径与界面显示用的短名（如 "data/projects/default/"） */
  dataDir: string | null;
  dataDirLabel: string | null;
  lastSavedAt: number | null;
  error: string | null;
  conflict: StorageConflict | null;
  activity: StorageActivity | null;
  /** 论文引用、但本地和 data/pdfs 都没有的 PDF 数 */
  missingPdfs: number;
  /** 被本地服务拒绝（不会再重试）的 PDF 上传 */
  failedPdfUploads: number;
  markdownAt: number | null;
  markdownError: string | null;
  notice: StorageNotice | null;
  /** data/ 根目录下不属于项目结构的旧版文件（迁移后又运行过旧版本时出现） */
  strayLegacyFiles: string[];
}

export const initialStorageSyncState: StorageSyncState = {
  phase: "probing",
  dataDir: null,
  dataDirLabel: null,
  lastSavedAt: null,
  error: null,
  conflict: null,
  activity: null,
  missingPdfs: 0,
  failedPdfUploads: 0,
  markdownAt: null,
  markdownError: null,
  notice: null,
  strayLegacyFiles: [],
};

interface StorageUiState {
  dialogOpen: boolean;
  conflictDialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  setConflictDialogOpen: (open: boolean) => void;
  dismissNotice: () => void;
}

export const useStorageStore = create<StorageSyncState & StorageUiState>()((set) => ({
  ...initialStorageSyncState,
  dialogOpen: false,
  conflictDialogOpen: false,
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
  setConflictDialogOpen: (conflictDialogOpen) => set({ conflictDialogOpen }),
  dismissNotice: () => set({ notice: null }),
}));
