// 存储 Worker：在 Worker 里打开 Dexie，执行 tasks.ts 中的整库读写，避免序列化、哈希、解析占用主线程。
// 协议见 runner.ts 的 TaskRequest / TaskResponse；任务可以并发（Dexie 自己处理事务）。
// 项目由 Worker 名确定（runner.ts 创建时传入），db 和接口前缀都跟着它；每个请求再核对一次数据库名。
import { db } from "@/db/schema";
import { createStorageApi } from "./api";
import { encodeError, WRONG_DB_ERROR, type TaskRequest, type TaskResponse } from "./protocol";
import { storageTasks, type TaskContext } from "./tasks";

interface WorkerScope {
  onmessage: ((ev: MessageEvent<TaskRequest>) => void) | null;
  postMessage(msg: TaskResponse): void;
}
const scope = self as unknown as WorkerScope;
const ctx: TaskContext = { db, api: createStorageApi() };

scope.onmessage = (ev) => {
  const { id, name, arg, dbName } = ev.data;
  if (dbName !== db.name) {
    scope.postMessage({ id, ok: false, error: { name: WRONG_DB_ERROR, message: `存储 Worker 打开的数据库（${db.name}）与页面（${dbName}）不一致` } });
    return;
  }
  const task = storageTasks[name] as (c: TaskContext, a: unknown) => Promise<unknown>;
  task(ctx, arg).then(
    (result) => scope.postMessage({ id, ok: true, result }),
    (e: unknown) => scope.postMessage({ id, ok: false, error: encodeError(e) }),
  );
};
