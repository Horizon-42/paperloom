// 后台索引调度（开发文档 5.3）：订阅论文、术语、领域的变化，安排扫描；缺全文的论文先在主线程提取。
//
// 流程：请求先防抖合并 → 交给 Worker 匹配（扫描戳一致的论文直接跳过）→ Worker 报告缺全文的论文 →
// 主线程空闲时逐篇 ensurePageTexts（打开中的论文优先）→ 提取完的论文再交给 Worker 匹配。
// 匹配任务运行中来了全库请求（术语或领域树变了）就取消当前任务、合并后重跑；其他请求排队等当前任务结束。
// 多个标签页同时打开时用 navigator.locks 选出一个标签页做索引，其余只读结果（进度经 BroadcastChannel 同步）；
// 锁和频道按项目区分，不同项目的标签页互不影响。
import { workerKind } from "@/i18n";
import { liveQuery } from "dexie";
import { db } from "@/db/schema";
import { projectScoped, workerName } from "@/lib/project";
import { initialIndexerState, useIndexerStore, type IndexerFailure, type IndexerState } from "@/app/stores/indexer";
import { useReaderStore } from "@/app/stores/reader";
import { ensurePageTexts } from "@/services/pageTextService";
import {
  domainTreeKey,
  paperIndexSignature,
  runIndexJob,
  termsMatchKey,
  type IndexJobRequest,
  type IndexJobResult,
  type IndexerRequestMessage,
  type IndexerResponseMessage,
} from "@/workers/indexCore";

// ---------------------------------------------------------------------------
// 调度器（不依赖 Worker、数据库和 DOM，便于单元测试）
// ---------------------------------------------------------------------------

export interface MatchJob {
  promise: Promise<IndexJobResult>;
  cancel(): void;
}

export interface SchedulerDeps {
  runMatch(req: IndexJobRequest, onProgress: (done: number, total: number) => void): MatchJob;
  /** 提取并缓存一篇论文的全文；失败时抛出 */
  extract(paperId: string): Promise<unknown>;
  /** 等主线程空闲（每篇论文提取前调用） */
  idle(): Promise<void>;
  /** 优先处理的论文（阅读器里打开的），越靠前越优先 */
  priority(): string[];
  onState(patch: Partial<IndexerState>): void;
  debounceMs?: number;
  /** 持续有请求时，最多推迟这么久就执行 */
  maxWaitMs?: number;
  /** 同一文件提取成功后仍报告缺全文，最多再试几次 */
  maxExtractAttempts?: number;
  /** 扫描任务失败（Worker 报错等）后的重试间隔；用完即放弃这次请求 */
  jobRetryDelaysMs?: number[];
  /** 提取超时后隔多久自动重试一次 */
  timeoutRetryDelayMs?: number;
  warn?: (...args: unknown[]) => void;
}

/** 提取全文超时（只自动重试一次） */
export class ExtractTimeoutError extends Error {
  override name = "ExtractTimeoutError";
}

interface Pending {
  all: boolean;
  ids: Set<string>;
}

function merge(a: Pending | null, b: Pending | null): Pending | null {
  if (!a) return b;
  if (!b) return a;
  if (a.all || b.all) return { all: true, ids: new Set() };
  return { all: false, ids: new Set([...a.ids, ...b.ids]) };
}

export class IndexScheduler {
  private pending: Pending | null = null; // 防抖中
  private pendingSince = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued: Pending | null = null; // 已防抖、等待执行
  private running = false;
  private current: { req: Pending; job: MatchJob } | null = null;
  /** 待提取全文：paperId → 报告时的 fileHash（Map 保持报告顺序） */
  private extractQueue = new Map<string, string>();
  private extractDone = 0;
  private failed = new Map<string, { fileHash: string; message: string; autoRetry?: boolean }>();
  /** 已自动重试过的超时（paperId + fileHash） */
  private timeoutRetried = new Set<string>();
  private autoRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** 连续失败的扫描任务数，决定退避间隔 */
  private jobFailures = 0;
  private retryReq: Pending | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 本次会话中已成功提取过的文件及次数，防止反复提取 */
  private extractedAttempts = new Map<string, number>();
  private stopped = false;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly deps: SchedulerDeps) {}

  /** 请求扫描；paperIds 缺省或为 null 表示全库，空数组忽略 */
  request(paperIds?: string[] | null): void {
    if (this.stopped || (paperIds && paperIds.length === 0)) return;
    const req: Pending = paperIds ? { all: false, ids: new Set(paperIds) } : { all: true, ids: new Set() };
    const now = Date.now();
    if (!this.pending) this.pendingSince = now;
    this.pending = merge(this.pending, req);
    const debounce = this.deps.debounceMs ?? 400;
    const maxWait = this.deps.maxWaitMs ?? 2000;
    const wait = Math.max(0, Math.min(debounce, this.pendingSince + maxWait - now));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** 立即执行防抖中的请求 */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending || this.stopped) return;
    this.queued = merge(this.queued, this.pending);
    this.pending = null;
    // 全库请求说明术语或领域树变了：正在跑的任务结果已过时，取消后与新请求合并重跑
    if (this.current && this.queued?.all) this.current.job.cancel();
    void this.pump();
  }

  /** 论文被删除：从提取队列和失败列表中移除 */
  forget(paperIds: string[]): void {
    let changed = false;
    for (const id of paperIds) {
      this.extractQueue.delete(id);
      this.clearAttempts(id);
      changed = this.failed.delete(id) || changed;
    }
    if (changed) this.emitFailures();
  }

  /** 重试提取失败的论文（缺省全部）：清掉失败记录，立即重新检查 */
  retryFailed(paperIds?: string[]): void {
    if (this.stopped) return;
    const ids = (paperIds ?? [...this.failed.keys()]).filter((id) => this.failed.has(id));
    if (!ids.length) return;
    for (const id of ids) {
      this.failed.delete(id);
      this.clearAttempts(id);
    }
    this.emitFailures();
    this.queued = merge(this.queued, { all: false, ids: new Set(ids) });
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.autoRetryTimers.forEach(clearTimeout);
    this.autoRetryTimers.clear();
    this.timer = this.retryTimer = null;
    this.current?.job.cancel();
    this.notifyIdle(true);
  }

  /** 没有防抖中、排队中或运行中的工作时 resolve（测试与 e2e 用） */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  debugState() {
    return {
      running: this.running,
      pending: this.pending && (this.pending.all ? "all" : [...this.pending.ids]),
      queued: this.queued && (this.queued.all ? "all" : [...this.queued.ids]),
      current: this.current && (this.current.req.all ? "all" : [...this.current.req.ids]),
      retry: this.retryReq && (this.retryReq.all ? "all" : [...this.retryReq.ids]),
      extractQueue: [...this.extractQueue.keys()],
      failed: [...this.failed.keys()],
    };
  }

  /** 自动重试超时的计时不算在内（可能要等一分钟） */
  private isIdle(): boolean {
    return !this.running && !this.pending && !this.queued && !this.timer && !this.retryTimer && this.extractQueue.size === 0;
  }

  private clearAttempts(paperId: string) {
    const prefix = `${paperId}\u0000`;
    for (const k of [...this.extractedAttempts.keys()]) if (k.startsWith(prefix)) this.extractedAttempts.delete(k);
  }

  /** 扫描任务失败：按退避间隔重新排队，次数用完就放弃（下次数据变化会再触发） */
  private retryJobLater(req: Pending) {
    const delays = this.deps.jobRetryDelaysMs ?? [1000, 5000, 20000];
    const attempt = this.jobFailures++;
    if (attempt >= delays.length) {
      (this.deps.warn ?? console.warn)("[indexer] 扫描任务多次失败，放弃这次请求");
      this.jobFailures = 0;
      return;
    }
    this.retryReq = merge(this.retryReq, req);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.queued = merge(this.queued, this.retryReq);
      this.retryReq = null;
      void this.pump();
    }, delays[attempt]);
  }

  private notifyIdle(force = false) {
    if (!force && !this.isIdle()) return;
    const ws = this.idleWaiters;
    this.idleWaiters = [];
    ws.forEach((w) => w());
  }

  private emitFailures() {
    const failures: IndexerFailure[] = [...this.failed].map(([paperId, f]) => ({
      paperId,
      message: f.message,
      ...(f.autoRetry ? { autoRetry: true } : {}),
    }));
    this.deps.onState({ failures });
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped) {
        if (this.queued) await this.runQueued();
        else if (this.extractQueue.size) await this.extractNext();
        else break;
      }
    } finally {
      this.running = false;
      this.extractDone = 0;
      this.deps.onState({ running: false, phase: null, done: 0, total: 0, currentPaperId: null });
      this.notifyIdle();
    }
  }

  private async runQueued(): Promise<void> {
    const req = this.queued!;
    this.queued = null;
    // 逐篇提取期间，提取完的单篇论文的匹配很快，不切换进度显示，避免闪烁
    const quiet = !req.all && req.ids.size <= 3 && this.extractQueue.size > 0;
    if (!quiet) this.deps.onState({ running: true, phase: "match", done: 0, total: req.all ? 0 : req.ids.size, currentPaperId: null });
    const job = this.deps.runMatch({ paperIds: req.all ? null : [...req.ids], priority: this.deps.priority() }, (done, total) => {
      if (!quiet) this.deps.onState({ running: true, phase: "match", done, total });
    });
    this.current = { req, job };
    let res: IndexJobResult | null = null;
    try {
      res = await job.promise;
    } catch (e) {
      (this.deps.warn ?? console.warn)("[indexer] 扫描任务失败", e);
    } finally {
      this.current = null;
    }
    if (!res) {
      if (!this.stopped) this.retryJobLater(req);
      return;
    }
    this.jobFailures = 0;
    if (res.cancelled) {
      this.queued = merge(req, this.queued);
      return;
    }
    const maxAttempts = this.deps.maxExtractAttempts ?? 2;
    let failuresChanged = false;
    for (const n of res.needsText) {
      const f = this.failed.get(n.paperId);
      if (f && f.fileHash === n.fileHash) continue;
      const key = `${n.paperId}\u0000${n.fileHash}`;
      if (n.missingFile || (this.extractedAttempts.get(key) ?? 0) >= maxAttempts) {
        this.failed.set(n.paperId, { fileHash: n.fileHash, message: n.missingFile ? "缺少 PDF 文件" : "提取后全文仍不可用" });
        failuresChanged = true;
        continue;
      }
      this.extractQueue.set(n.paperId, n.fileHash);
    }
    if (failuresChanged) this.emitFailures();
    if (res.errors.length) (this.deps.warn ?? console.warn)("[indexer] 部分论文扫描出错", res.errors);
    this.deps.onState({ lastRun: { ...res.stats, at: Date.now() } });
  }

  private pickExtract(): string {
    for (const id of this.deps.priority()) if (this.extractQueue.has(id)) return id;
    return this.extractQueue.keys().next().value!;
  }

  private async extractNext(): Promise<void> {
    const id = this.pickExtract();
    const fileHash = this.extractQueue.get(id)!;
    this.deps.onState({
      running: true,
      phase: "extract",
      done: this.extractDone,
      total: this.extractDone + this.extractQueue.size,
      currentPaperId: id,
    });
    await this.deps.idle();
    if (this.stopped) return;
    // 等待空闲期间论文可能被删除
    if (!this.extractQueue.has(id)) return;
    this.extractQueue.delete(id);
    try {
      await this.deps.extract(id);
      const key = `${id}\u0000${fileHash}`;
      this.extractedAttempts.set(key, (this.extractedAttempts.get(key) ?? 0) + 1);
      if (this.failed.delete(id)) this.emitFailures();
      this.queued = merge(this.queued, { all: false, ids: new Set([id]) });
    } catch (e) {
      const key = `${id}\u0000${fileHash}`;
      if (e instanceof ExtractTimeoutError && !this.timeoutRetried.has(key)) {
        // 超时可能只是当时太忙（大文件、阅读器占着 pdf.js），稍后自动再试一次
        this.timeoutRetried.add(key);
        this.failed.set(id, { fileHash, message: "提取全文超时，稍后自动重试", autoRetry: true });
        const t = setTimeout(() => {
          this.autoRetryTimers.delete(t);
          this.retryFailed([id]);
        }, this.deps.timeoutRetryDelayMs ?? 60_000);
        this.autoRetryTimers.add(t);
      } else {
        this.failed.set(id, { fileHash, message: describeExtractError(e) });
      }
      this.emitFailures();
    }
    this.extractDone++;
  }
}

function describeExtractError(e: unknown): string {
  if (e instanceof ExtractTimeoutError) return "提取全文超时";
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "PasswordException") return "PDF 已加密";
  if (name === "InvalidPDFException") return "文件已损坏或不是有效的 PDF";
  const msg = e instanceof Error ? e.message : String(e);
  return msg || "未知错误";
}

// ---------------------------------------------------------------------------
// 运行环境：Worker 客户端、空闲等待、变化订阅
// ---------------------------------------------------------------------------

interface ClientJob {
  req: IndexJobRequest;
  onProgress: (done: number, total: number) => void;
  resolve: (r: IndexJobResult) => void;
  reject: (e: unknown) => void;
  cancelled: boolean;
}

/** Worker 不可用（或加载失败）时退回主线程执行同样的扫描 */
function createMatchRunner() {
  let worker: Worker | null = null;
  let broken = typeof Worker === "undefined";
  let seq = 0;
  const jobs = new Map<number, ClientJob>();

  const runInThread = (job: ClientJob) => {
    runIndexJob(job.req, { isCancelled: () => job.cancelled, onProgress: job.onProgress }).then(job.resolve, job.reject);
  };

  /** Worker 坏了：以后都在主线程扫描，未完成的任务也改在主线程重跑 */
  const fallBack = () => {
    broken = true;
    worker?.terminate();
    worker = null;
    const left = [...jobs.values()];
    jobs.clear();
    left.forEach(runInThread);
  };

  const ensureWorker = (): Worker | null => {
    if (broken) return null;
    if (worker) return worker;
    try {
      // Worker 读不到页面 URL：项目放在 Worker 名里（lib/project.ts）
      worker = new Worker(new URL("../workers/indexer.worker.ts", import.meta.url), { type: "module", name: workerName(workerKind("paperlens-indexer")) });
    } catch (e) {
      console.warn("[indexer] 无法创建 Worker，改在主线程扫描", e);
      broken = true;
      return null;
    }
    worker.onmessage = (ev: MessageEvent<IndexerResponseMessage>) => {
      const m = ev.data;
      const job = jobs.get(m.jobId);
      if (!job) return;
      if (m.type === "progress") {
        job.onProgress(m.done, m.total);
        return;
      }
      if (m.type === "wrong-db") {
        console.warn("[indexer]", m.message, "，改在主线程扫描");
        fallBack();
        return;
      }
      jobs.delete(m.jobId);
      if (m.type === "result") job.resolve(m.result);
      else job.reject(new Error(m.message));
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      console.warn("[indexer] Worker 出错，改在主线程扫描", ev.message);
      fallBack();
    };
    return worker;
  };

  const run = (req: IndexJobRequest, onProgress: (done: number, total: number) => void): MatchJob => {
    const jobId = ++seq;
    let resolve!: (r: IndexJobResult) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<IndexJobResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: ClientJob = { req, onProgress, resolve, reject, cancelled: false };
    const w = ensureWorker();
    if (w) {
      jobs.set(jobId, job);
      w.postMessage({ type: "run", jobId, req, dbName: db.name } satisfies IndexerRequestMessage);
    } else {
      runInThread(job);
    }
    return {
      promise,
      cancel: () => {
        job.cancelled = true;
        if (jobs.has(jobId)) worker?.postMessage({ type: "cancel", jobId } satisfies IndexerRequestMessage);
      },
    };
  };

  const terminate = () => {
    worker?.terminate();
    worker = null;
    for (const j of jobs.values()) j.reject(new Error("indexer stopped"));
    jobs.clear();
  };

  return { run, terminate, usesWorker: () => !broken };
}

function waitIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 1500 });
    else setTimeout(resolve, 30);
  });
}

/** 阅读器里打开的论文：聚焦分栏的当前标签 > 其他分栏的当前标签 > 其余标签 */
function openPaperIds(): string[] {
  const { panes, focusedPane } = useReaderStore.getState();
  const out: string[] = [];
  const push = (id: string | null | undefined) => {
    if (id && !out.includes(id)) out.push(id);
  };
  push(panes.find((p) => p.id === focusedPane)?.activePaperId);
  for (const p of panes) push(p.activePaperId);
  for (const p of panes) p.tabs.forEach(push);
  return out;
}

const EXTRACT_TIMEOUT_MS = 180_000;

function extractWithTimeout(paperId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ExtractTimeoutError("提取全文超时")), EXTRACT_TIMEOUT_MS);
    ensurePageTexts(paperId).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 订阅影响扫描结果的数据变化。每个订阅的第一次结果只作基线（启动时另有一次全库自检） */
function watchChanges(scheduler: IndexScheduler): () => void {
  const warn = (what: string) => (e: unknown) => console.warn(`[indexer] 订阅${what}失败`, e);

  let paperSigs: Map<string, string> | null = null;
  const papers = liveQuery(() => db.papers.toArray()).subscribe({
    next: (list) => {
      const next = new Map(list.map((p) => [p.id, paperIndexSignature(p)]));
      if (paperSigs) {
        const changed: string[] = [];
        for (const [id, sig] of next) if (paperSigs.get(id) !== sig) changed.push(id);
        const removed = [...paperSigs.keys()].filter((id) => !next.has(id));
        if (removed.length) scheduler.forget(removed);
        // 删除的论文也排一次：任务开头会发现术语统计的行数对不上并重建
        if (changed.length || removed.length) scheduler.request([...changed, ...removed]);
      }
      paperSigs = next;
    },
    error: warn("论文"),
  });

  let termsKey: string | null = null;
  const terms = liveQuery(() => db.terms.toArray()).subscribe({
    next: (list) => {
      const k = termsMatchKey(list);
      if (termsKey !== null && k !== termsKey) scheduler.request();
      termsKey = k;
    },
    error: warn("术语"),
  });

  let treeKey: string | null = null;
  const domains = liveQuery(() => db.domains.toArray()).subscribe({
    next: (list) => {
      const k = domainTreeKey(list);
      if (treeKey !== null && k !== treeKey) scheduler.request();
      treeKey = k;
    },
    error: warn("领域"),
  });

  return () => {
    papers.unsubscribe();
    terms.unsubscribe();
    domains.unsubscribe();
  };
}

// ---------------------------------------------------------------------------
// 对外接口（startIndexer / scheduleIndex 的签名是契约）
// ---------------------------------------------------------------------------

const STARTUP_DELAY_MS = 600;
const STARTUP_IDLE_TIMEOUT_MS = 2000;
/** 锁和频道按项目区分：不同项目的标签页各自选出负责索引的标签页 */
const lockName = () => projectScoped("paperlens-indexer");
const channelName = () => projectScoped("paperlens-indexer");

/** 标签页之间的消息：负责索引的标签页广播进度；其他标签页转发请求 */
type ChannelMessage =
  | { type: "state"; patch: Partial<IndexerState> }
  | { type: "hello" }
  | { type: "schedule"; paperIds: string[] | null }
  | { type: "retry"; paperIds?: string[] };

interface Instance {
  /** 本标签页是否负责索引 */
  leader: boolean;
  scheduler: IndexScheduler | null;
  usesWorker: () => boolean;
  post: (m: ChannelMessage) => void;
  stop: () => void;
}

let instance: Instance | null = null;

function snapshotState(): Partial<IndexerState> {
  const { running, phase, done, total, currentPaperId, failures, lastRun } = useIndexerStore.getState();
  return { running, phase, done, total, currentPaperId, failures, lastRun };
}

/**
 * 应用启动时调用一次：订阅论文与术语的变化，自动安排扫描。
 * 多个标签页时只有拿到锁的那个做索引；它关闭后锁自动释放，由下一个标签页接手。
 */
export function startIndexer(): void {
  if (instance || typeof window === "undefined" || typeof indexedDB === "undefined") return;
  // 性能对比用：VITE_PAPERLENS_NO_INDEXER=1 npx vite 启动时不运行后台索引
  if (import.meta.env.VITE_PAPERLENS_NO_INDEXER) return;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName()) : null;
  let stopped = false;
  let releaseLock: (() => void) | null = null;
  let leaderStop: (() => void) | null = null;
  let usesWorker = () => false;

  const inst: Instance = {
    leader: false,
    scheduler: null,
    usesWorker: () => usesWorker(),
    post: (m) => channel?.postMessage(m),
    stop: () => {
      stopped = true;
      leaderStop?.();
      releaseLock?.();
      channel?.close();
    },
  };

  if (channel) {
    channel.onmessage = (ev: MessageEvent<ChannelMessage>) => {
      const m = ev.data;
      if (inst.leader) {
        if (m.type === "hello") channel.postMessage({ type: "state", patch: snapshotState() } satisfies ChannelMessage);
        else if (m.type === "schedule") inst.scheduler?.request(m.paperIds);
        else if (m.type === "retry") inst.scheduler?.retryFailed(m.paperIds);
      } else if (m.type === "state") {
        useIndexerStore.setState(m.patch);
      }
    };
  }

  const becomeLeader = () => {
    if (stopped) return;
    inst.leader = true;
    useIndexerStore.setState({ ...initialIndexerState });
    const runner = createMatchRunner();
    usesWorker = runner.usesWorker;
    const scheduler = new IndexScheduler({
      runMatch: runner.run,
      extract: extractWithTimeout,
      idle: waitIdle,
      priority: openPaperIds,
      onState: (patch) => {
        useIndexerStore.setState(patch);
        channel?.postMessage({ type: "state", patch } satisfies ChannelMessage);
      },
    });
    inst.scheduler = scheduler;
    let unwatch: (() => void) | null = null;
    // 订阅和启动自检都要读整张表，推迟到首屏渲染之后的空闲时间，不和侧栏、阅读器抢启动时间。
    // 推迟期间的变化不会丢：自检本身就是一次全库检查
    const begin = () => {
      if (stopped) return;
      unwatch = watchChanges(scheduler);
      // 启动自检：扫描戳不一致、规则版本过期或缺全文的论文都会被重新处理
      scheduler.request();
    };
    setTimeout(() => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(begin, { timeout: STARTUP_IDLE_TIMEOUT_MS });
      else begin();
    }, STARTUP_DELAY_MS);
    leaderStop = () => {
      unwatch?.();
      scheduler.stop();
      runner.terminate();
    };
  };

  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    // 先向现任索引标签页要一份进度（若有）
    inst.post({ type: "hello" });
    locks
      .request(lockName(), () => {
        becomeLeader();
        // 持有锁直到 stop 或标签页关闭
        return new Promise<void>((resolve) => (releaseLock = resolve));
      })
      .catch((e) => {
        console.warn("[indexer] 无法获取标签页锁，由本标签页索引", e);
        becomeLeader();
      });
  } else {
    becomeLeader();
  }
  instance = inst;
}

/** 安排后台重建 occurrences（带防抖）。paperIds 缺省表示全库 */
export function scheduleIndex(opts?: { paperIds?: string[] }): void {
  if (!instance) return;
  const paperIds = opts?.paperIds ?? null;
  if (instance.leader) instance.scheduler?.request(paperIds);
  else instance.post({ type: "schedule", paperIds });
}

/** 重试提取失败的论文（缺省全部） */
export function retryFailedExtractions(paperIds?: string[]): void {
  if (!instance) return;
  if (instance.leader) instance.scheduler?.retryFailed(paperIds);
  else instance.post({ type: "retry", paperIds });
}

/** 等待当前所有索引工作完成（e2e 与调试用；未启动或不负责索引时立即 resolve） */
export function whenIndexerIdle(): Promise<void> {
  return instance?.scheduler?.whenIdle() ?? Promise.resolve();
}

/** 调试信息：是否负责索引、队列、是否在 Worker 中运行 */
export function getIndexerDebug() {
  if (!instance) return null;
  if (!instance.leader || !instance.scheduler) return { leader: false as const };
  return { leader: true as const, ...instance.scheduler.debugState(), usesWorker: instance.usesWorker() };
}

/** 停止索引并释放标签页锁（测试用） */
export function stopIndexer(): void {
  instance?.stop();
  instance = null;
}
