// 自动保存到 data/projects/<当前项目>/：IndexedDB 是工作副本，项目文件夹是它的镜像（由 Vite 插件里的本地服务读写，见 server/）。
// 每个项目有自己的数据库和文件夹（lib/project.ts）；下文的"文件夹""data/"都指当前项目的文件夹。
// data/ 还是旧版结构（需要迁移）时服务不写入：进入 needs-migration，不启动镜像，数据留在 IndexedDB 里。
//
// 启动：探测本地服务 → 本地没有数据而 data/library.json 有 → 自动恢复；否则正常镜像。
// 镜像：监听 IndexedDB 的变化（含其他标签页和 Worker 的写入），library.json 防抖 2 秒（最多推迟 10 秒），
//   PDF 按差异上传，Markdown 和附加文件组防抖 10 秒（最多 60 秒）；页面隐藏或关闭时尽量立即保存。
//   失败后按 3/10/30/60 秒退避重试（"立即保存"、页面隐藏只让第一次不等待）。
// 并发：同源、同项目的多个标签页共用 IndexedDB，用 navigator.locks 选出一个标签页负责镜像，其余经 BroadcastChannel 显示它的状态
//   （锁和频道名带项目 id，不同项目的标签页各自选）；
//   不同源（如 5173 与 127.0.0.1:5173）各有一份 IndexedDB，靠 library.json 的 revision 做乐观并发：
//   本地没改动而文件夹更新了就直接载入；两边都改了则暂停并让用户选择。文件夹里就是本地这份数据（contentHash 相同，
//   例如写入成功但响应丢失）时直接采用文件夹的 revision。
// 数据安全：IndexedDB 被清空重建（数据库实例标识对不上）、library.json 无法读取、本地数据被清空时都暂停并询问，
//   不把残缺的数据当作新版本写进 data/；替换本地数据前在同一事务里确认期间没有新改动。
// 恢复后 PDF 按需读取（lib/pdfDocs 的后备来源），后台也逐个取回。
import Dexie, { type ObservabilitySet } from "dexie";
import { DATA_FORMAT_VERSION, db } from "@/db/schema";
import { t } from "@/i18n";
import { setMissingPdfResolver } from "@/lib/pdfDocs";
import { currentProjectId, DEFAULT_PROJECT_ID, projectScoped } from "@/lib/project";
import { retryFailedExtractions, scheduleIndex } from "@/services/indexer";
import { initialStorageSyncState, useStorageStore, type StorageConflict, type StorageSyncState } from "@/app/stores/storage";
import { createStorageApi, StorageApiError, type ServiceStatus, type StorageApi } from "./api";
import { classifyMutation } from "./changes";
import { extraFileGroups } from "./extraFiles";
import { prepareExtraFiles } from "./extraNames";
import { hasUserData, type DataCounts } from "./format";
import { createTaskRunner, type TaskRunner } from "./runner";
import { loadDbInstance, loadSyncRecord, newDbInstanceId, saveDbInstance, saveSyncRecord, type SyncRecord } from "./syncState";
import type { FolderState, MirrorResult, PdfDiff, ReplaceResult } from "./tasks";

/** 锁和频道按项目区分（default 也带后缀），不同项目的标签页互不影响 */
const lockName = () => projectScoped("paperlens-storage");
const channelName = () => projectScoped("paperlens-storage");
const LIBRARY_DEBOUNCE_MS = 2000;
const LIBRARY_MAX_WAIT_MS = 10_000;
const DERIVED_DEBOUNCE_MS = 10_000;
const DERIVED_MAX_WAIT_MS = 60_000;
const RETRY_DELAYS_MS = [3000, 10_000, 30_000, 60_000];
/** 窗口获得焦点时检查文件夹是否被其他窗口更新，最多这么频繁 */
const FOLDER_CHECK_MIN_INTERVAL_MS = 3000;
/** data/ 下由存储模块自己使用的目录，附加文件组不能用 */
const RESERVED_GROUPS = new Set(["markdown", "pdfs", "backups", "trash", "tmp"]);

/**
 * 冲突时的选择：load-folder 载入文件夹的数据（替换本地，先备份本地）；overwrite-folder 用本地数据覆盖文件夹（先备份文件夹）；
 * recover-backup 用 data/backups 中最近的可读备份替换损坏的 library.json，再载入
 */
export type ConflictChoice = "load-folder" | "overwrite-folder" | "recover-backup";

type ChannelMessage =
  | { type: "hello" }
  | { type: "state"; state: Partial<StorageSyncState> }
  | { type: "request"; id: string; action: "flush" | "markdown" | ConflictChoice }
  | { type: "done"; id: string; error?: string };

function describeError(e: unknown): string {
  if (e instanceof StorageApiError) return e.message;
  if (e instanceof TypeError) return t.data.errors.cannotConnect;
  return e instanceof Error ? e.message : String(e);
}

const isLocalChanged = (e: unknown) => (e as { name?: string } | null)?.name === "LocalChangedError";

/** 服务端明确拒绝、重试也没用的错误（4xx，排除超时和限流） */
function isPermanent(e: unknown): boolean {
  return e instanceof StorageApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
}

function folderOf(s: ServiceStatus): FolderState {
  return {
    exists: s.library.exists,
    hasData: s.library.hasData,
    revision: s.library.revision,
    contentHash: s.library.contentHash ?? null,
    unreadable: !!s.library.error,
  };
}

/** 界面上显示的数据目录：项目内为 "data/projects/<id>/"；其他位置的长路径只显示最后一级 */
export function shortDirLabel(label: string | null | undefined): string {
  if (!label) return "data/";
  if (label.length <= 28) return label;
  const parts = label.replace(/\/+$/, "").split("/");
  return `…/${parts[parts.length - 1]}/`;
}

function countsText(c: Partial<DataCounts>): string {
  return t.data.sync.counts(c);
}

function waitIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 50);
  });
}

// ---------------------------------------------------------------------------
// 负责镜像的标签页
// ---------------------------------------------------------------------------

interface Action {
  choice: ConflictChoice | "flush" | "markdown";
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface UploadItem {
  hash: string;
  attempts: number;
  retryAt: number;
}

type RestoreReason = "startup" | "fast-forward" | "conflict" | "reset" | "recover";

class Mirror {
  private sync: SyncRecord;
  private folder: FolderState;
  /** 本地数据库应有的实例标识（见 snapshot.ts 的 DB_INSTANCE_KEY） */
  private instance: string | null;
  private dirty = { library: false, pdfs: false, markdown: false, extras: false };
  private firstDirty = { library: 0, derived: 0 };
  private due = { library: 0, derived: 0 };
  /** 立即执行（页面隐藏、用户点"立即保存"）；失败一次后清除，之后按退避时间重试 */
  private urgent = false;
  /** 冲突：等用户决定，期间不写文件夹 */
  private paused = false;
  private running = false;
  private savingLibrary = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private pdfRetryAt = 0;
  private uploadQueue: UploadItem[] = [];
  private fetchQueue: PdfDiff["toFetch"] = [];
  private failedUploads = new Map<string, string>();
  private progress = { upload: { done: 0, total: 0 }, fetch: { done: 0, total: 0 } };
  private actions: Action[] = [];
  private idleWaiters: (() => void)[] = [];
  private lastFolderCheck = 0;
  private lastMirror: MirrorResult | null = null;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(
    private readonly runner: TaskRunner,
    private readonly api: StorageApi,
    private status: ServiceStatus,
    private readonly publish: (patch: Partial<StorageSyncState>) => void,
  ) {
    // 迁移到项目结构之前的同步记录以 data/ 根目录为标识：revision 与内容哈希都与项目文件夹一致时才沿用（见 syncState.ts）
    const legacy =
      currentProjectId() === DEFAULT_PROJECT_ID && status.dataRoot
        ? { dataDir: status.dataRoot, revision: status.library.revision, contentHash: status.library.contentHash ?? null }
        : undefined;
    this.sync = loadSyncRecord(status.dataDir, legacy);
    this.folder = folderOf(status);
    this.instance = loadDbInstance();
  }

  async start(): Promise<void> {
    const s = this.status;
    this.publish({ dataDir: s.dataDir, dataDirLabel: s.dataDirLabel, phase: "saving", error: null, strayLegacyFiles: s.strayLegacyFiles ?? [] });
    try {
      await this.startup();
    } catch (e) {
      const text = t.data.sync.restoreFailed(shortDirLabel(s.dataDirLabel), describeError(e));
      this.publish({ phase: "error", error: text, notice: { tone: "error", text } });
      // 不能接着镜像：会用空数据覆盖文件夹
      this.paused = true;
    }
    if (this.stopped) return;
    this.subscribe();
    // 启动检查：关闭期间（或服务不在时）的改动、缺失的 PDF、Markdown
    this.dirty.library = this.dirty.pdfs = this.dirty.markdown = this.dirty.extras = true;
    this.due.library = Date.now();
    this.due.derived = Date.now() + DERIVED_DEBOUNCE_MS;
    void this.pump();
  }

  /** 启动时的决定：版本、数据库是否被重建、文件夹是否可读、是否需要从文件夹恢复 */
  private async startup(): Promise<void> {
    const s = this.status;
    if (s.library.exists && s.library.version !== null && Math.floor(s.library.version) > DATA_FORMAT_VERSION) {
      this.enterConflict({ kind: "newer-format", folderRevision: s.library.revision });
      return;
    }
    const local = await this.runner.call("inspectLocal");
    const localHasData = hasUserData(local.counts);
    if (local.dbInstance === null || this.instance === null || local.dbInstance !== this.instance) {
      const reset = this.instance !== null && local.dbInstance !== this.instance;
      if (reset && localHasData) {
        // IndexedDB 被清空后（localStorage 还在）又有了新数据：不能把这点数据当成完整的文件库写进 data/
        this.enterConflict({ kind: "db-reset", folderRevision: s.library.revision });
        return;
      }
      if (local.dbInstance !== null && !reset) this.adoptInstance(local.dbInstance);
      else await this.stampNewInstance();
    }
    if (s.library.error) {
      this.enterConflict({ kind: "unreadable", folderRevision: 0 });
      return;
    }
    if (!localHasData && s.library.hasData) await this.restore("startup", local.fingerprint);
    else this.publish({ phase: "saved", lastSavedAt: s.library.savedAt });
  }

  private adoptInstance(id: string): void {
    this.instance = id;
    saveDbInstance(id);
  }

  private async stampNewInstance(): Promise<void> {
    const id = newDbInstanceId();
    await this.runner.call("stampDb", id);
    this.adoptInstance(id);
  }

  private subscribe(): void {
    const onMutated = (parts: ObservabilitySet) => {
      const k = classifyMutation(parts, db.name);
      if (k.data) {
        this.markLibrary();
        this.markDerived(true);
      }
      if (k.files) this.markPdfs();
      if (k.occurrences) this.markDerived(false);
    };
    Dexie.on.storagemutated.subscribe(onMutated);
    // 数据库被意外关闭（例如清除了站点数据）：尽快检查一次，发现被重建就暂停
    const onClose = () => this.markLibrary(0);
    db.on("close", onClose);
    const onHide = () => {
      if (document.visibilityState === "hidden") this.flushSoon();
    };
    const onPageHide = () => this.flushSoon();
    const onFocus = () => void this.checkFolder();
    const onVisible = () => {
      if (document.visibilityState === "visible") void this.checkFolder();
    };
    // 大文件库的保存可能来不及在页面关闭前完成（keepalive 只能带 64 KB）：有未保存的改动时请浏览器先确认
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!this.hasUnsaved()) return;
      this.flushSoon();
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onHide);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("focus", onFocus);
    window.addEventListener("beforeunload", onBeforeUnload);
    this.unsubscribers.push(() => {
      Dexie.on.storagemutated.unsubscribe(onMutated);
      db.on("close").unsubscribe(onClose);
      document.removeEventListener("visibilitychange", onHide);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("beforeunload", onBeforeUnload);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribers.forEach((fn) => fn());
    this.notifyIdle(true);
  }

  private hasUnsaved(): boolean {
    return !this.paused && (this.dirty.library || this.savingLibrary);
  }

  // ---------- 调度 ----------

  /** 数据有改动：防抖 2 秒，持续有改动时最多推迟 10 秒 */
  private markLibrary(debounce = LIBRARY_DEBOUNCE_MS): void {
    const now = Date.now();
    if (!this.dirty.library) this.firstDirty.library = now;
    this.dirty.library = true;
    this.due.library = Math.max(this.failures ? this.due.library : 0, Math.min(now + debounce, this.firstDirty.library + LIBRARY_MAX_WAIT_MS));
    const phase = useStorageStore.getState().phase;
    if (!this.paused && phase === "saved") this.publish({ phase: "pending" });
    this.schedule();
  }

  /** 论文或 PDF 文件有变化：随 library 一起（或 2 秒后）比对 data/pdfs */
  private markPdfs(): void {
    this.dirty.pdfs = true;
    if (!this.dirty.library) this.due.library = Math.max(this.due.library, Date.now() + LIBRARY_DEBOUNCE_MS);
    this.schedule();
  }

  /** Markdown（及附加文件组）需要更新：防抖 10 秒，最多推迟 60 秒 */
  private markDerived(extras: boolean): void {
    const now = Date.now();
    if (!this.dirty.markdown && !this.dirty.extras) this.firstDirty.derived = now;
    this.dirty.markdown = true;
    if (extras) this.dirty.extras = true;
    this.due.derived = Math.min(now + DERIVED_DEBOUNCE_MS, this.firstDirty.derived + DERIVED_MAX_WAIT_MS);
    this.schedule();
  }

  private flushSoon(): void {
    if (this.stopped) return;
    this.urgent = true;
    void this.pump();
  }

  /** 立即保存全部待保存的内容（不等后台取回 PDF）；失败时以错误结束，冲突时直接返回 */
  flush(): Promise<void> {
    if (this.paused) return Promise.resolve();
    this.dirty.library = this.dirty.pdfs = this.dirty.markdown = this.dirty.extras = true;
    const p = new Promise<void>((resolve, reject) => this.actions.push({ choice: "flush", resolve, reject }));
    this.urgent = true;
    void this.pump();
    return p;
  }

  regenerateMarkdown(): Promise<void> {
    return this.enqueue("markdown");
  }

  resolveConflict(choice: ConflictChoice): Promise<void> {
    return this.enqueue(choice);
  }

  private enqueue(choice: Action["choice"]): Promise<void> {
    const p = new Promise<void>((resolve, reject) => this.actions.push({ choice, resolve, reject }));
    void this.pump();
    return p;
  }

  private takeFlushes(): Action[] {
    const flushes = this.actions.filter((a) => a.choice === "flush");
    this.actions = this.actions.filter((a) => a.choice !== "flush");
    return flushes;
  }

  /** 一次失败：不再"立即"重试，等着的 flush 以错误结束 */
  private failed(e: unknown): void {
    this.urgent = false;
    for (const a of this.takeFlushes()) a.reject(e);
  }

  private nextUploadAt(): number {
    return this.uploadQueue.reduce((m, x) => Math.min(m, x.retryAt), Infinity);
  }

  private schedule(): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const times: number[] = [];
    if (!this.paused) {
      if (this.dirty.library || this.dirty.pdfs) times.push(this.due.library);
      if (this.dirty.markdown || this.dirty.extras) times.push(this.due.derived);
      if (this.uploadQueue.length) times.push(this.nextUploadAt());
      if (this.fetchQueue.length) times.push(this.pdfRetryAt);
    }
    if (!times.length) return;
    const wait = Math.max(0, Math.min(...times) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, wait);
  }

  private isIdle(): boolean {
    return (
      this.paused ||
      (!this.running && !this.dirty.library && !this.dirty.pdfs && !this.dirty.markdown && !this.dirty.extras && !this.uploadQueue.length)
    );
  }

  /** 等待保存工作完成（e2e 用；不等后台取回 PDF） */
  whenIdle(): Promise<void> {
    if (this.isIdle() && !this.running) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private notifyIdle(force = false): void {
    if (!force && !this.isIdle()) return;
    const ws = this.idleWaiters;
    this.idleWaiters = [];
    ws.forEach((w) => w());
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      while (!this.stopped) {
        const now = Date.now();
        const action = this.actions.find((a) => a.choice !== "flush");
        if (action) {
          this.actions.splice(this.actions.indexOf(action), 1);
          await this.runAction(action);
          continue;
        }
        if (this.paused) break;
        const urgent = this.urgent || this.actions.length > 0;
        if (this.dirty.library && (urgent || now >= this.due.library)) {
          await this.saveLibrary();
          continue;
        }
        if (this.paused) break;
        if (this.dirty.pdfs && (urgent || now >= this.due.library)) {
          await this.diffPdfs();
          continue;
        }
        if ((this.dirty.markdown || this.dirty.extras) && (urgent || now >= this.due.derived)) {
          await this.writeDerived();
          continue;
        }
        const upload = this.uploadQueue.find((x) => x.retryAt <= now);
        if (upload) {
          await this.uploadOne(upload);
          continue;
        }
        // 能做的都做完了：flush 的等待者可以返回（不等后台取回 PDF）
        if (this.actions.length && !this.dirty.library && !this.dirty.pdfs && !this.dirty.markdown && !this.dirty.extras && !this.uploadQueue.length) {
          this.takeFlushes().forEach((a) => a.resolve());
          continue;
        }
        if (this.actions.length) break; // 还有等待重试的上传：flush 稍后结束
        if (this.fetchQueue.length && now >= this.pdfRetryAt && !this.dirty.library) {
          await this.fetchNext();
          continue;
        }
        break;
      }
    } finally {
      this.running = false;
      this.urgent = false;
      // 冲突时 flush 不再等待
      if (this.paused) this.takeFlushes().forEach((a) => a.resolve());
      this.notifyIdle();
      this.schedule();
    }
  }

  private async runAction(a: Action): Promise<void> {
    try {
      if (a.choice === "markdown") {
        this.dirty.markdown = true;
        await this.writeDerived(true);
      } else if (a.choice === "load-folder") {
        await this.loadFolder();
      } else if (a.choice === "overwrite-folder") {
        await this.overwriteFolder();
      } else if (a.choice === "recover-backup") {
        await this.recoverBackup();
      }
      a.resolve();
    } catch (e) {
      a.reject(e);
    }
  }

  // ---------- library.json ----------

  private async saveLibrary(): Promise<void> {
    this.dirty.library = false;
    this.firstDirty.library = 0;
    this.savingLibrary = true;
    this.publish({ phase: "saving" });
    let r: MirrorResult;
    try {
      r = await this.runner.call("mirrorLibrary", {
        baseRevision: this.sync.revision,
        lastHash: this.sync.hash,
        folder: this.folder,
        dbInstance: this.instance,
        keepalive: document.visibilityState === "hidden",
      });
    } catch (e) {
      this.retryLibraryLater(e);
      return;
    } finally {
      this.savingLibrary = false;
    }
    this.failures = 0;
    this.handleMirrorResult(r);
    try {
      if (r.status === "behind") await this.restore("fast-forward", r.fingerprint);
      else if (r.status === "db-reset" && !r.localHasData) {
        // 数据库被清空、还没有新数据：像启动时一样从文件夹恢复（文件夹也没数据就只换个标识）
        await this.stampNewInstance();
        if (this.folder.hasData) await this.restore("reset", r.fingerprint);
        else this.publish({ phase: "saved", conflict: null });
      }
    } catch (e) {
      if (isLocalChanged(e)) {
        // 载入期间本地有了新改动：放弃载入，按正常流程保存（文件夹已更新，会变成冲突让用户选择）
        this.markLibrary(0);
        this.publish({ phase: "pending" });
      } else this.retryLibraryLater(e);
    }
  }

  private handleMirrorResult(r: MirrorResult): void {
    this.lastMirror = r;
    switch (r.status) {
      case "saved":
      case "adopted":
        this.sync = { dataDir: this.status.dataDir, revision: r.revision, hash: r.hash };
        saveSyncRecord(this.sync);
        this.folder = {
          exists: true,
          hasData: r.status === "saved" ? !!r.hasData : this.folder.hasData,
          revision: r.revision,
          contentHash: r.hash,
          unreadable: false,
        };
        this.publish({
          phase: this.dirty.library ? "pending" : "saved",
          lastSavedAt: r.savedAt ?? Date.now(),
          error: null,
          conflict: null,
          ...(r.backup
            ? { notice: { tone: "info" as const, text: t.data.sync.shrinkBackup(r.backup) } }
            : {}),
        });
        if (import.meta.env.DEV && r.status === "saved") {
          const tm = r.timings;
          console.debug(
            `[storage] saved r${r.revision}, ${(r.bytes / 1024).toFixed(0)} KB (in worker: read ${tm.readMs.toFixed(0)} ms, serialize ${tm.serializeMs.toFixed(0)} ms, hash ${tm.hashMs.toFixed(0)} ms; write ${tm.putMs.toFixed(0)} ms)`,
          );
        }
        break;
      case "unchanged":
      case "empty":
        this.publish({ phase: this.dirty.library ? "pending" : "saved", error: null, lastSavedAt: useStorageStore.getState().lastSavedAt ?? Date.now() });
        break;
      case "behind":
        break;
      case "db-reset":
        if (r.localHasData) this.enterConflict({ kind: "db-reset", folderRevision: r.folderRevision ?? this.folder.revision });
        break;
      case "conflict":
        this.enterConflict({ kind: "revision", folderRevision: r.folderRevision ?? this.folder.revision });
        break;
      case "local-empty":
        this.enterConflict({ kind: "local-empty", folderRevision: r.folderRevision ?? this.folder.revision });
        break;
      case "unreadable":
        this.enterConflict({ kind: "unreadable", folderRevision: 0 });
        break;
      case "newer-format":
        this.enterConflict({ kind: "newer-format", folderRevision: r.folderRevision ?? this.folder.revision });
        break;
    }
  }

  private retryLibraryLater(e: unknown): void {
    this.dirty.library = true;
    const delay = RETRY_DELAYS_MS[Math.min(this.failures++, RETRY_DELAYS_MS.length - 1)];
    this.due.library = Date.now() + delay;
    this.firstDirty.library = Date.now();
    this.failed(e);
    console.warn("[storage] save failed, will retry", e);
    this.publish({ phase: "error", error: t.data.sync.saveFailed(describeError(e)) });
  }

  private enterConflict(conflict: StorageConflict): void {
    this.paused = true;
    this.folder = { ...this.folder, revision: conflict.folderRevision };
    this.publish({ phase: "conflict", conflict });
  }

  /** 窗口获得焦点时看看文件夹是否被其他窗口更新了：是的话检查一次（本地没改动则直接载入） */
  private async checkFolder(): Promise<void> {
    if (this.stopped || this.paused || Date.now() - this.lastFolderCheck < FOLDER_CHECK_MIN_INTERVAL_MS) return;
    this.lastFolderCheck = Date.now();
    const s = await this.api.status();
    if (!s || this.stopped) return;
    if (s.needsMigration) {
      // 服务端的 data/ 被换回了旧版结构（不应发生）：不再写入
      this.paused = true;
      this.publish({ phase: "needs-migration" });
      return;
    }
    this.status = s;
    this.publish({ strayLegacyFiles: s.strayLegacyFiles ?? [] });
    const f = folderOf(s);
    if (f.revision !== this.sync.revision || f.contentHash !== this.sync.hash || !f.exists || f.unreadable) {
      this.folder = f;
      this.markLibrary(0);
    }
  }

  // ---------- 恢复与冲突处理 ----------

  /**
   * 用 data/library.json 替换本地数据。expect 是决定替换时本地数据的指纹：
   * 替换在同一事务里先核对，期间有新改动则抛出 LocalChangedError、不做任何修改。
   */
  private async restore(reason: RestoreReason, expect: string, recoveredFrom?: string): Promise<ReplaceResult & { revision: number }> {
    const label = shortDirLabel(this.status.dataDirLabel);
    this.publish({ phase: "restoring", notice: { tone: "info", text: t.data.sync.restoring(label) } });
    let r: ReplaceResult & { revision: number };
    try {
      r = await this.runner.call("restoreFromService", { expect });
    } catch (e) {
      this.publish({ notice: null });
      throw e;
    }
    this.sync = { dataDir: this.status.dataDir, revision: r.revision, hash: r.hash };
    saveSyncRecord(this.sync);
    this.folder = { exists: true, hasData: hasUserData(r.counts), revision: r.revision, contentHash: null, unreadable: false };
    this.paused = false;
    scheduleIndex();
    this.dirty.pdfs = true;
    this.due.library = Date.now();
    const detail = [...r.repairs];
    if (r.counts.papers) detail.push(t.data.sync.pdfsLater);
    const text =
      reason === "fast-forward"
        ? t.data.sync.loadedFromOtherWindow(countsText(r.counts))
        : reason === "recover"
          ? t.data.sync.restoredFromBackup(String(recoveredFrom), countsText(r.counts))
          : t.data.sync.restoredFrom(label, countsText(r.counts));
    this.publish({ phase: "saved", conflict: null, error: null, lastSavedAt: Date.now(), notice: { tone: "success", text, detail } });
    return r;
  }

  /** 先把本地数据备份到 data/backups/，再替换；备份到替换之间本地又有改动时重来（最多 3 次） */
  private async backupThenRestore(reason: RestoreReason, recoveredFrom?: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const b = await this.runner.call("backupLocal", "browser-before-load");
      try {
        await this.restore(reason, b.fingerprint, recoveredFrom);
        return;
      } catch (e) {
        if (!isLocalChanged(e) || attempt >= 2) throw e;
      }
    }
  }

  private async withConflictRollback(phase: "restoring" | "saving", fn: () => Promise<void>): Promise<void> {
    const conflict = useStorageStore.getState().conflict;
    this.publish({ phase });
    try {
      await fn();
    } catch (e) {
      this.paused = true;
      this.publish({ phase: "conflict", conflict, error: describeError(e) });
      throw e;
    }
  }

  /** 选择"载入文件夹的数据"：先把本地独有的 PDF 和本地数据存进 data/，再替换 */
  private async loadFolder(): Promise<void> {
    const kind = useStorageStore.getState().conflict?.kind;
    await this.withConflictRollback("restoring", async () => {
      const diff = await this.runner.call("pdfDiff");
      for (const hash of diff.toUpload) await this.runner.call("uploadPdf", hash).catch(() => false);
      const s = await this.api.status();
      if (s) {
        this.status = s;
        this.folder = folderOf(s);
      }
      await this.backupThenRestore("conflict");
      if (kind === "db-reset") await this.stampNewInstance();
    });
  }

  /** 选择"用本浏览器的数据覆盖文件夹"：先备份文件夹中的 library.json（无法读取的由服务端另存） */
  private async overwriteFolder(): Promise<void> {
    const kind = useStorageStore.getState().conflict?.kind;
    await this.withConflictRollback("saving", async () => {
      if (kind === "db-reset") await this.stampNewInstance();
      const before = await this.api.status();
      if (before?.library.exists && !before.library.error) await this.api.backup("before-overwrite");
      const s = await this.api.status();
      if (!s) throw new Error(t.data.errors.cannotConnect);
      this.status = s;
      this.folder = folderOf(s);
      const r = await this.runner.call("mirrorLibrary", {
        baseRevision: this.folder.revision,
        lastHash: null,
        folder: this.folder,
        dbInstance: this.instance,
        force: true,
        allowEmpty: true,
        overwriteUnreadable: this.folder.unreadable,
      });
      if (r.status !== "saved" && r.status !== "adopted") {
        this.handleMirrorResult(r);
        throw new Error(t.data.sync.folderChangedAgain);
      }
      this.paused = false;
      this.handleMirrorResult(r);
      this.dirty.pdfs = this.dirty.markdown = this.dirty.extras = true;
      this.due.library = this.due.derived = Date.now();
    });
  }

  /** library.json 无法读取时：用 data/backups 中最近的可读备份替换它，再载入（先备份本地数据） */
  private async recoverBackup(): Promise<void> {
    await this.withConflictRollback("restoring", async () => {
      const b = await this.runner.call("backupLocal", "browser-before-load");
      const { name } = await this.api.recoverLibrary();
      const s = await this.api.status();
      if (s) {
        this.status = s;
        this.folder = folderOf(s);
      }
      try {
        await this.restore("recover", b.fingerprint, name);
      } catch (e) {
        if (!isLocalChanged(e)) throw e;
        await this.backupThenRestore("recover", name);
      }
    });
  }

  // ---------- PDF ----------

  private async diffPdfs(): Promise<void> {
    this.dirty.pdfs = false;
    let d: PdfDiff;
    try {
      d = await this.runner.call("pdfDiff");
    } catch (e) {
      this.dirty.pdfs = true;
      this.due.library = Date.now() + RETRY_DELAYS_MS[1];
      this.failed(e);
      console.warn("[storage] PDF diff failed", e);
      return;
    }
    // 进行中重新比对（例如取回的 PDF 写入 db.files 又触发了一次）时进度接着算；被服务拒绝过的不再上传
    const up = this.uploadQueue.length ? this.progress.upload.done : 0;
    const fe = this.fetchQueue.length ? this.progress.fetch.done : 0;
    const prev = new Map(this.uploadQueue.map((x) => [x.hash, x]));
    this.uploadQueue = d.toUpload.filter((h) => !this.failedUploads.has(h)).map((hash) => prev.get(hash) ?? { hash, attempts: 0, retryAt: 0 });
    this.fetchQueue = d.toFetch;
    this.progress.upload = { done: up, total: up + this.uploadQueue.length };
    this.progress.fetch = { done: fe, total: fe + d.toFetch.length };
    this.publish({ missingPdfs: d.missing.length });
    this.publishActivity();
  }

  private publishActivity(): void {
    const { upload, fetch } = this.progress;
    if (this.uploadQueue.length) this.publish({ activity: { kind: "pdf-upload", done: upload.done, total: upload.total } });
    else if (this.fetchQueue.length) this.publish({ activity: { kind: "pdf-fetch", done: fetch.done, total: fetch.total } });
    else this.publish({ activity: null });
  }

  /** 上传一个 PDF。失败的排到队尾按退避时间重试，不挡后面的；被服务明确拒绝（4xx）的不再重试，在界面上提示 */
  private async uploadOne(item: UploadItem): Promise<void> {
    const i = this.uploadQueue.indexOf(item);
    this.uploadQueue.splice(i, 1);
    try {
      await this.runner.call("uploadPdf", item.hash);
      this.progress.upload.done++;
    } catch (e) {
      if (isPermanent(e)) {
        console.warn(`[storage] data/pdfs rejected PDF ${item.hash.slice(0, 12)}…, giving up`, e);
        this.failedUploads.set(item.hash, describeError(e));
        this.progress.upload.total--;
        this.publish({ failedPdfUploads: this.failedUploads.size });
      } else {
        console.warn("[storage] PDF upload failed, will retry", e);
        item.attempts++;
        item.retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
        this.uploadQueue.push(item);
        this.failed(e);
      }
    }
    this.publishActivity();
  }

  /** 后台取回一个 PDF（低优先级：先等主线程空闲） */
  private async fetchNext(): Promise<void> {
    await waitIdle();
    const item = this.fetchQueue[0];
    if (!item || this.stopped) return;
    try {
      const ok = await this.runner.call("backfillPdf", item.hash);
      this.fetchQueue.shift();
      this.progress.fetch.done++;
      if (ok) {
        // 恢复后索引器可能因为缺文件把这些论文记为失败：取回后重试
        retryFailedExtractions(item.paperIds);
        scheduleIndex({ paperIds: item.paperIds });
      }
    } catch (e) {
      console.warn("[storage] PDF fetch failed, will retry", e);
      this.fetchQueue.push(this.fetchQueue.shift()!);
      this.pdfRetryAt = Date.now() + RETRY_DELAYS_MS[2];
    }
    this.publishActivity();
  }

  // ---------- Markdown 与附加文件组 ----------

  private async writeDerived(throwOnError = false): Promise<void> {
    const md = this.dirty.markdown;
    const extras = this.dirty.extras;
    this.dirty.markdown = this.dirty.extras = false;
    this.firstDirty.derived = 0;
    if (md) {
      try {
        await this.runner.call("writeMarkdown");
        this.publish({ markdownAt: Date.now(), markdownError: null });
      } catch (e) {
        console.warn("[storage] Markdown generation failed", e);
        this.dirty.markdown = true;
        this.due.derived = Date.now() + RETRY_DELAYS_MS[3];
        this.publish({ markdownError: describeError(e) });
        this.failed(e);
        if (throwOnError) throw e;
      }
    }
    if (extras) {
      for (const [group, producer] of extraFileGroups()) {
        if (RESERVED_GROUPS.has(group)) {
          console.warn(`[storage] extra file group name "${group}" is reserved, skipped`);
          continue;
        }
        try {
          await this.api.putFiles(group, prepareExtraFiles(group, await producer()));
        } catch (e) {
          console.warn(`[storage] writing data/${group}/ failed`, e);
        }
      }
    }
  }

  debug() {
    return {
      sync: this.sync,
      folder: this.folder,
      instance: this.instance,
      dirty: { ...this.dirty },
      paused: this.paused,
      running: this.running,
      uploadQueue: this.uploadQueue.map((x) => x.hash),
      failedUploads: [...this.failedUploads.keys()],
      fetchQueue: this.fetchQueue.map((f) => f.hash),
      usesWorker: this.runner.usesWorker(),
      lastMirror: this.lastMirror && { status: this.lastMirror.status, revision: this.lastMirror.revision, bytes: this.lastMirror.bytes, timings: this.lastMirror.timings },
    };
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

let started = false;
let api: StorageApi | null = null;
let runner: TaskRunner | null = null;
/** 可以读写的本地服务（需要迁移时为 null，与没有服务一样处理） */
let probe: Promise<ServiceStatus | null> = Promise.resolve(null);
let mirror: Mirror | null = null;
let channel: BroadcastChannel | null = null;
const remoteRequests = new Map<string, { resolve: () => void; reject: (e: unknown) => void }>();

function setLocal(patch: Partial<StorageSyncState>) {
  useStorageStore.setState(patch);
}

function publish(patch: Partial<StorageSyncState>) {
  setLocal(patch);
  channel?.postMessage({ type: "state", state: patch } satisfies ChannelMessage);
}

function snapshotState(): StorageSyncState {
  const s = useStorageStore.getState();
  const out = {} as Record<string, unknown>;
  for (const k of Object.keys(initialStorageSyncState)) out[k] = s[k as keyof StorageSyncState];
  return out as unknown as StorageSyncState;
}

/** 从本地服务取回 db.files 中缺少的 PDF（阅读器打开、提取全文时调用） */
async function resolveMissingPdf(hash: string): Promise<Blob | null> {
  if (!(await probe) || !runner) return null;
  try {
    if (!(await runner.call("backfillPdf", hash))) return null;
    return (await db.files.get(hash))?.blob ?? null;
  } catch (e) {
    console.warn("[storage] reading PDF from data/pdfs failed", e);
    return null;
  }
}

function handleRequest(m: Extract<ChannelMessage, { type: "request" }>) {
  if (!mirror) return;
  const run =
    m.action === "flush" ? mirror.flush() : m.action === "markdown" ? mirror.regenerateMarkdown() : mirror.resolveConflict(m.action);
  run.then(
    () => channel?.postMessage({ type: "done", id: m.id } satisfies ChannelMessage),
    (e) => channel?.postMessage({ type: "done", id: m.id, error: describeError(e) } satisfies ChannelMessage),
  );
}

/** 应用启动时调用一次（重复调用无效） */
export function startStorageSync(): void {
  if (started || typeof window === "undefined" || typeof indexedDB === "undefined") return;
  started = true;
  api = createStorageApi();
  runner = createTaskRunner();
  // 启动时开发服务器可能正忙（预构建依赖）：失败时再试一次
  const raw = api.status(8000).then((s) => s ?? new Promise<ServiceStatus | null>((r) => setTimeout(() => r(api!.status(8000)), 1500)));
  probe = raw.then((s) => (s?.needsMigration ? null : s));
  setMissingPdfResolver(resolveMissingPdf);

  channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName()) : null;
  if (channel) {
    channel.onmessage = (ev: MessageEvent<ChannelMessage>) => {
      const m = ev.data;
      if (mirror) {
        if (m.type === "hello") channel!.postMessage({ type: "state", state: snapshotState() } satisfies ChannelMessage);
        else if (m.type === "request") handleRequest(m);
        return;
      }
      if (m.type === "state") {
        // 其他标签页还在探测时也可能收到；offline 由本标签页自己的探测结果决定
        setLocal(m.state);
      } else if (m.type === "done") {
        const r = remoteRequests.get(m.id);
        if (!r) return;
        remoteRequests.delete(m.id);
        if (m.error) r.reject(new Error(m.error));
        else r.resolve();
      }
    };
  }

  void raw.then((status) => {
    if (status?.needsMigration) {
      // 不选负责保存的标签页、不镜像：服务这时拒绝一切写入，数据留在 IndexedDB 里，迁移后刷新页面继续
      setLocal({ ...initialStorageSyncState, phase: "needs-migration", dataDir: status.dataDir, dataDirLabel: status.dataDirLabel });
      return;
    }
    if (!status) {
      setLocal({ ...initialStorageSyncState, phase: "offline" });
      return;
    }
    setLocal({ dataDir: status.dataDir, dataDirLabel: status.dataDirLabel, strayLegacyFiles: status.strayLegacyFiles ?? [] });
    const becomeLeader = async () => {
      // 接手时重新取一次状态：前一个负责的标签页可能刚写过
      const fresh = (await api!.status()) ?? status;
      mirror = new Mirror(runner!, api!, fresh, publish);
      await mirror.start();
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks?.request) {
      channel?.postMessage({ type: "hello" } satisfies ChannelMessage);
      locks
        .request(lockName(), async () => {
          await becomeLeader();
          // 持有锁直到标签页关闭，由下一个标签页接手
          return new Promise<void>(() => {});
        })
        .catch((e) => {
          console.warn("[storage] can't acquire tab lock; this tab will handle saving", e);
          void becomeLeader();
        });
    } else {
      void becomeLeader();
    }
  });

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__paperlensStorage = {
      useStorageStore,
      flush: flushStorage,
      whenIdle: () => mirror?.whenIdle() ?? Promise.resolve(),
      debug: () => mirror?.debug() ?? null,
      isLeader: () => !!mirror,
    };
  }
}

/** 本地服务的探测结果（null 表示没有服务） */
export function getServiceStatus(): Promise<ServiceStatus | null> {
  return probe;
}

export function getStorageApi(): StorageApi {
  api ??= createStorageApi();
  return api;
}

export function getStorageRunner(): TaskRunner {
  runner ??= createTaskRunner();
  return runner;
}

function requestLeader(action: Extract<ChannelMessage, { type: "request" }>["action"]): Promise<void> {
  if (mirror) {
    if (action === "flush") return mirror.flush();
    if (action === "markdown") return mirror.regenerateMarkdown();
    return mirror.resolveConflict(action);
  }
  if (!channel) return Promise.resolve();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    // 负责的标签页可能正好关闭：超时后放弃（接手的标签页会自己检查一遍）
    const timer = setTimeout(() => {
      remoteRequests.delete(id);
      reject(new Error(t.data.sync.ownerNoResponse));
    }, 120_000);
    remoteRequests.set(id, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    channel!.postMessage({ type: "request", id, action } satisfies ChannelMessage);
  });
}

/** 立即保存（不等防抖）；没有本地服务时立即返回；保存失败时以错误结束 */
export async function flushStorage(): Promise<void> {
  if (!(await probe)) return;
  await requestLeader("flush");
}

export async function regenerateMarkdown(): Promise<void> {
  if (!(await probe)) return;
  await requestLeader("markdown");
}

export async function resolveStorageConflict(choice: ConflictChoice): Promise<void> {
  await requestLeader(choice);
}
