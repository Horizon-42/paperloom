import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexerState } from "@/app/stores/indexer";
import { ExtractTimeoutError, IndexScheduler, type MatchJob, type SchedulerDeps } from "@/services/indexer";
import type { IndexJobRequest, IndexJobResult } from "@/workers/indexCore";

/** 可控的假 Worker：每个任务挂起，由测试决定何时完成 */
class FakeRunner {
  jobs: { req: IndexJobRequest; resolve: (r: IndexJobResult) => void; cancelled: boolean; progress: (d: number, t: number) => void }[] = [];
  /** 每篇论文是否缺全文；缺省都有全文 */
  missing = new Map<string, string>();
  /** 缺 PDF 文件的论文（Worker 报告 missingFile） */
  noFile = new Set<string>();
  auto = false;

  /** 接下来这么多个任务直接失败（模拟 Worker 报错） */
  failNext = 0;

  run = (req: IndexJobRequest, progress: (d: number, t: number) => void): MatchJob => {
    if (this.failNext > 0) {
      this.failNext--;
      this.jobs.push({ req, resolve: () => {}, cancelled: false, progress });
      return { promise: Promise.reject(new Error("worker crashed")), cancel: () => {} };
    }
    let resolve!: (r: IndexJobResult) => void;
    const promise = new Promise<IndexJobResult>((r) => (resolve = r));
    const job = { req, resolve, cancelled: false, progress };
    this.jobs.push(job);
    if (this.auto) queueMicrotask(() => this.finish(job));
    return { promise, cancel: () => (job.cancelled = true) };
  };

  result(req: IndexJobRequest, cancelled = false): IndexJobResult {
    const ids = req.paperIds ?? [...this.missing.keys()];
    return {
      cancelled,
      needsText: cancelled
        ? []
        : ids
            .filter((id) => this.missing.has(id))
            .map((id) => ({ paperId: id, fileHash: this.missing.get(id)!, ...(this.noFile.has(id) ? { missingFile: true } : {}) })),
      errors: [],
      stats: { papers: ids.length, scanned: 0, skipped: 0, pages: 0, termCount: 0, rows: 0, written: 0, deleted: 0, orphans: 0, buildMs: 0, matchMs: 0, ms: 1 },
    };
  }

  finish(job = this.jobs[this.jobs.length - 1]) {
    job.resolve(this.result(job.req, job.cancelled));
  }

  reqs() {
    return this.jobs.map((j) => (j.req.paperIds === null ? "all" : [...j.req.paperIds].sort().join(",")));
  }
}

function setup(over: Partial<SchedulerDeps> = {}) {
  const runner = new FakeRunner();
  const extracted: string[] = [];
  const states: Partial<IndexerState>[] = [];
  let priority: string[] = [];
  const extractImpl = vi.fn(async (id: string) => {
    extracted.push(id);
    runner.missing.delete(id);
  });
  const s = new IndexScheduler({
    runMatch: runner.run,
    extract: extractImpl,
    idle: () => Promise.resolve(),
    priority: () => priority,
    onState: (p) => states.push(p),
    debounceMs: 400,
    maxWaitMs: 2000,
    warn: () => {},
    ...over,
  });
  return { s, runner, extracted, states, extractImpl, setPriority: (p: string[]) => (priority = p) };
}

/** 让挂起的 promise 链跑完 */
const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("IndexScheduler", () => {
  it("防抖：连续请求合并成一次任务", async () => {
    const { s, runner } = setup();
    s.request(["a"]);
    vi.advanceTimersByTime(300);
    s.request(["b"]);
    s.request(["a", "c"]);
    vi.advanceTimersByTime(399);
    expect(runner.jobs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(runner.reqs()).toEqual(["a,b,c"]);
  });

  it("全库请求吸收单篇请求；空数组忽略", async () => {
    const { s, runner } = setup();
    s.request([]);
    vi.advanceTimersByTime(1000);
    expect(runner.jobs).toHaveLength(0);
    s.request(["a"]);
    s.request();
    s.request(["b"]);
    vi.advanceTimersByTime(400);
    expect(runner.reqs()).toEqual(["all"]);
  });

  it("持续有请求时最多推迟 maxWait", async () => {
    const { s, runner } = setup();
    for (let t = 0; t < 2000; t += 200) {
      s.request([`p${t}`]);
      vi.advanceTimersByTime(200);
    }
    expect(runner.jobs).toHaveLength(1);
  });

  it("运行中来的单篇请求排队，当前任务结束后执行，不丢失", async () => {
    const { s, runner } = setup();
    s.request(["a"]);
    vi.advanceTimersByTime(400);
    expect(runner.reqs()).toEqual(["a"]);
    s.request(["b"]);
    vi.advanceTimersByTime(400);
    s.request(["c"]);
    vi.advanceTimersByTime(400);
    expect(runner.jobs).toHaveLength(1);
    expect(runner.jobs[0].cancelled).toBe(false);
    runner.finish();
    await tick();
    expect(runner.reqs()).toEqual(["a", "b,c"]);
  });

  it("运行中来了全库请求：取消当前任务，与之合并后重跑", async () => {
    const { s, runner } = setup();
    s.request(["a"]);
    vi.advanceTimersByTime(400);
    s.request();
    vi.advanceTimersByTime(400);
    expect(runner.jobs[0].cancelled).toBe(true);
    runner.finish(runner.jobs[0]);
    await tick();
    expect(runner.reqs()).toEqual(["a", "all"]);
  });

  it("被取消的单篇任务合并回队列", async () => {
    const { s, runner } = setup();
    s.request(["a", "b"]);
    vi.advanceTimersByTime(400);
    // 外部取消（例如 stop 之外的原因）：结果标记 cancelled，请求应重新排队
    runner.jobs[0].cancelled = true;
    s.request(["c"]);
    vi.advanceTimersByTime(400);
    runner.finish(runner.jobs[0]);
    await tick();
    expect(runner.reqs()).toEqual(["a,b", "a,b,c"]);
  });

  it("缺全文的论文逐篇提取（打开的论文优先），提取后再匹配", async () => {
    const { s, runner, extracted, setPriority } = setup();
    runner.auto = true;
    runner.missing.set("a", "ha").set("b", "hb").set("c", "hc");
    setPriority(["c"]);
    s.request(["a", "b", "c"]);
    vi.advanceTimersByTime(400);
    await s.whenIdle();
    expect(extracted).toEqual(["c", "a", "b"]);
    expect(runner.reqs()).toEqual(["a,b,c", "c", "a", "b"]);
  });

  it("提取失败的论文记录下来并跳过，不阻塞其他论文；换文件后重试", async () => {
    const { s, runner, extracted, states } = setup({
      extract: async (id) => {
        extracted.push(id);
        if (id === "bad") throw Object.assign(new Error("x"), { name: "InvalidPDFException" });
        runner.missing.delete(id);
      },
    });
    runner.auto = true;
    runner.missing.set("bad", "h1").set("ok", "h2");
    s.request(["bad", "ok"]);
    vi.advanceTimersByTime(400);
    await s.whenIdle();
    expect(extracted).toEqual(["bad", "ok"]);
    const failures = states.filter((p) => p.failures).at(-1)?.failures;
    expect(failures).toEqual([{ paperId: "bad", message: "文件已损坏或不是有效的 PDF" }]);

    // 同一文件再次报告缺全文：不再提取
    s.request(["bad"]);
    vi.advanceTimersByTime(400);
    await s.whenIdle();
    expect(extracted).toEqual(["bad", "ok"]);

    // 换了文件：重试
    runner.missing.set("bad", "h3");
    s.request(["bad"]);
    vi.advanceTimersByTime(400);
    await s.whenIdle();
    expect(extracted).toEqual(["bad", "ok", "bad"]);
  });

  it("提取成功但全文仍不可用时，重试有限次后记为失败", async () => {
    const { s, runner, extracted, states } = setup({
      extract: async (id) => {
        extracted.push(id); // 不清除 missing：模拟提取结果一直无效
      },
      maxExtractAttempts: 2,
    });
    runner.auto = true;
    runner.missing.set("p", "h");
    s.request(["p"]);
    vi.advanceTimersByTime(400);
    await s.whenIdle();
    expect(extracted).toEqual(["p", "p"]);
    expect(states.filter((x) => x.failures).at(-1)?.failures).toEqual([{ paperId: "p", message: "提取后全文仍不可用" }]);
  });

  it("forget：已删除的论文不再提取", async () => {
    let release!: () => void;
    const { s, runner, extracted } = setup({ idle: () => new Promise<void>((r) => (release = r)) });
    runner.auto = true;
    runner.missing.set("a", "ha").set("b", "hb");
    s.request(["a", "b"]);
    vi.advanceTimersByTime(400);
    await tick(50);
    // 正在等空闲准备提取 a；此时 b 被删除
    s.forget(["b"]);
    release();
    await tick();
    release();
    await s.whenIdle();
    expect(extracted).toEqual(["a"]);
  });

  it("进度状态：match 阶段转发 Worker 进度，结束后复位", async () => {
    const { s, runner, states } = setup();
    s.request();
    vi.advanceTimersByTime(400);
    runner.jobs[0].progress(3, 10);
    expect(states.at(-1)).toMatchObject({ running: true, phase: "match", done: 3, total: 10 });
    runner.finish();
    await s.whenIdle();
    expect(states.some((p) => p.lastRun)).toBe(true);
    expect(states.at(-1)).toMatchObject({ running: false, phase: null });
  });

  it("stop 后不再接受请求", async () => {
    const { s, runner } = setup();
    s.stop();
    s.request();
    vi.advanceTimersByTime(1000);
    expect(runner.jobs).toHaveLength(0);
  });
});

describe("IndexScheduler：缺少 PDF 文件", () => {
  it("Worker 报告 missingFile 时直接记为失败，不尝试提取", async () => {
    const { s, runner, extracted, states } = setup();
    runner.auto = true;
    runner.missing.set("a", "ha").set("b", "hb");
    runner.noFile.add("a").add("b");
    s.request(["a", "b"]);
    vi.advanceTimersByTime(400);
    await s.whenIdle();
    expect(extracted).toEqual([]);
    const withFailures = states.filter((x) => x.failures);
    expect(withFailures).toHaveLength(1);
    expect(withFailures[0].failures!.map((f) => f.paperId)).toEqual(["a", "b"]);
  });
});

describe("IndexScheduler：失败重试", () => {
  it("扫描任务失败后按退避间隔重新排队（#12）", async () => {
    const { s, runner } = setup({ jobRetryDelaysMs: [1000, 5000] });
    runner.auto = true;
    runner.failNext = 2;
    s.request(["a"]);
    vi.advanceTimersByTime(400);
    await tick();
    expect(runner.reqs()).toEqual(["a"]);
    vi.advanceTimersByTime(999);
    await tick();
    expect(runner.jobs).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await tick();
    expect(runner.reqs()).toEqual(["a", "a"]); // 1 s 后第一次重试，又失败
    // 等待第二次重试（5 s）期间来的新请求照常执行，不受影响
    s.request(["b"]);
    vi.advanceTimersByTime(400);
    await tick();
    expect(runner.reqs()).toEqual(["a", "a", "b"]);
    vi.advanceTimersByTime(4599);
    await tick();
    expect(runner.jobs).toHaveLength(3);
    vi.advanceTimersByTime(1);
    await s.whenIdle();
    expect(runner.reqs()).toEqual(["a", "a", "b", "a"]); // 第二次重试成功
  });

  it("重试次数用完就放弃这次请求，计数在成功后清零", async () => {
    const { s, runner } = setup({ jobRetryDelaysMs: [100] });
    runner.auto = true;
    runner.failNext = 2;
    s.request(["a"]);
    vi.advanceTimersByTime(400);
    await tick();
    vi.advanceTimersByTime(100);
    await s.whenIdle();
    expect(runner.reqs()).toEqual(["a", "a"]);
    vi.advanceTimersByTime(10_000);
    expect(runner.jobs).toHaveLength(2);
    // 下一次请求重新计数
    runner.failNext = 1;
    s.request(["c"]);
    vi.advanceTimersByTime(400);
    await tick();
    vi.advanceTimersByTime(100);
    await s.whenIdle();
    expect(runner.reqs()).toEqual(["a", "a", "c", "c"]);
  });

  it("retryFailed：清掉失败记录并立即重新提取（#13）", async () => {
    let fail = true;
    const { s, runner, extracted, states } = setup({
      extract: async (id) => {
        extracted.push(id);
        if (fail) throw new Error("boom");
        runner.missing.delete(id);
      },
    });
    runner.auto = true;
    runner.missing.set("p", "h");
    s.request(["p"]);
    vi.advanceTimersByTime(400);
    await s.whenIdle();
    expect(states.filter((x) => x.failures).at(-1)?.failures).toEqual([{ paperId: "p", message: "boom" }]);

    fail = false;
    s.retryFailed();
    await s.whenIdle();
    expect(extracted).toEqual(["p", "p"]);
    expect(states.filter((x) => x.failures).at(-1)?.failures).toEqual([]);
    s.retryFailed(["not-failed"]); // 不在失败列表里的忽略
    await s.whenIdle();
    expect(extracted).toHaveLength(2);
  });

  it("提取超时：稍后自动重试一次，再超时就不再自动重试", async () => {
    const { s, runner, extracted, states } = setup({
      extract: async (id) => {
        extracted.push(id);
        throw new ExtractTimeoutError("提取全文超时");
      },
      timeoutRetryDelayMs: 60_000,
    });
    runner.auto = true;
    runner.missing.set("p", "h");
    s.request(["p"]);
    vi.advanceTimersByTime(400);
    await s.whenIdle();
    expect(states.filter((x) => x.failures).at(-1)?.failures).toEqual([
      { paperId: "p", message: "提取全文超时，稍后自动重试", autoRetry: true },
    ]);
    vi.advanceTimersByTime(60_000);
    await s.whenIdle();
    expect(extracted).toEqual(["p", "p"]);
    expect(states.filter((x) => x.failures).at(-1)?.failures).toEqual([{ paperId: "p", message: "提取全文超时" }]);
    vi.advanceTimersByTime(120_000);
    await s.whenIdle();
    expect(extracted).toHaveLength(2);
  });
});
