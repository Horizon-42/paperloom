// 后台索引 Worker（开发文档 5.3）：在 Worker 里打开 Dexie，扫描论文全文，写 occurrences。
// 协议见 indexCore.ts 的 IndexerRequestMessage / IndexerResponseMessage；任务串行执行。
// 打开哪个项目的数据库由 Worker 名决定（services/indexer.ts 创建时传入），每个任务再核对一次数据库名。
import { db } from "@/db/schema";
import { runIndexJob, type IndexerRequestMessage, type IndexerResponseMessage } from "./indexCore";

interface WorkerScope {
  onmessage: ((ev: MessageEvent<IndexerRequestMessage>) => void) | null;
  postMessage(msg: IndexerResponseMessage): void;
}
const scope = self as unknown as WorkerScope;

const PROGRESS_INTERVAL_MS = 100;
const cancelled = new Set<number>();
let chain: Promise<void> = Promise.resolve();

async function run(jobId: number, req: Extract<IndexerRequestMessage, { type: "run" }>["req"]) {
  if (cancelled.has(jobId)) {
    cancelled.delete(jobId);
    scope.postMessage({ type: "result", jobId, result: { cancelled: true, needsText: [], errors: [], stats: emptyStats() } });
    return;
  }
  let lastPost = 0;
  try {
    const result = await runIndexJob(req, {
      isCancelled: () => cancelled.has(jobId),
      onProgress: (done, total) => {
        const t = performance.now();
        if (done === 0 || done === total || t - lastPost >= PROGRESS_INTERVAL_MS) {
          lastPost = t;
          scope.postMessage({ type: "progress", jobId, done, total });
        }
      },
    });
    scope.postMessage({ type: "result", jobId, result });
  } catch (e) {
    scope.postMessage({ type: "error", jobId, message: e instanceof Error ? e.message : String(e) });
  } finally {
    cancelled.delete(jobId);
  }
}

function emptyStats() {
  return { papers: 0, scanned: 0, skipped: 0, pages: 0, termCount: 0, rows: 0, written: 0, deleted: 0, orphans: 0, buildMs: 0, matchMs: 0, ms: 0 };
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "cancel") {
    cancelled.add(msg.jobId);
    return;
  }
  if (msg.type !== "run") return;
  if (msg.dbName !== db.name) {
    scope.postMessage({ type: "wrong-db", jobId: msg.jobId, message: `索引 Worker 打开的数据库（${db.name}）与页面（${msg.dbName}）不一致` });
    return;
  }
  chain = chain.then(() => run(msg.jobId, msg.req));
};
