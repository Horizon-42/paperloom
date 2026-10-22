// 调用存储任务：默认交给 storage.worker.ts；Worker 不可用或出错时退回主线程执行同样的代码。
import { workerKind } from "@/i18n";
import { db } from "@/db/schema";
import { workerName } from "@/lib/project";
import { createStorageApi } from "./api";
import { decodeError, WRONG_DB_ERROR, type TaskRequest, type TaskResponse } from "./protocol";
import { storageTasks, type TaskArg, type TaskContext, type TaskName, type TaskResult } from "./tasks";

export interface TaskRunner {
  call<K extends TaskName>(name: K, ...arg: TaskArg<K> extends undefined ? [] : [TaskArg<K>]): Promise<TaskResult<K>>;
  usesWorker(): boolean;
  terminate(): void;
}

interface Pending {
  name: TaskName;
  arg: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export function createTaskRunner(opts: { worker?: boolean } = {}): TaskRunner {
  let worker: Worker | null = null;
  let broken = opts.worker === false || typeof Worker === "undefined";
  let seq = 0;
  const pending = new Map<number, Pending>();
  let inlineCtx: TaskContext | null = null;

  const runInline = (p: Pending) => {
    inlineCtx ??= { db, api: createStorageApi() };
    const task = storageTasks[p.name] as (c: TaskContext, a: unknown) => Promise<unknown>;
    task(inlineCtx, p.arg).then(p.resolve, p.reject);
  };

  /** Worker 坏了：以后都在主线程执行，未完成的任务也改在主线程重跑 */
  const fallBack = () => {
    broken = true;
    worker?.terminate();
    worker = null;
    const left = [...pending.values()];
    pending.clear();
    left.forEach(runInline);
  };

  const ensureWorker = (): Worker | null => {
    if (broken) return null;
    if (worker) return worker;
    try {
      // Worker 读不到页面 URL：项目放在 Worker 名里（lib/project.ts）
      worker = new Worker(new URL("./storage.worker.ts", import.meta.url), { type: "module", name: workerName(workerKind("paperlens-storage")) });
    } catch (e) {
      console.warn("[storage] 无法创建 Worker，改在主线程执行", e);
      broken = true;
      return null;
    }
    worker.onmessage = (ev: MessageEvent<TaskResponse>) => {
      const m = ev.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (!m.ok && m.error.name === WRONG_DB_ERROR) {
        // 不应发生：Worker 打开了别的项目的数据库。不让它碰任何数据，改在主线程执行
        console.warn("[storage]", m.error.message, "，改在主线程执行");
        fallBack();
        return;
      }
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(decodeError(m.error));
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      console.warn("[storage] Worker 出错，改在主线程执行", ev.message);
      fallBack();
    };
    return worker;
  };

  return {
    call(name, ...rest) {
      const arg = rest[0];
      return new Promise((resolve, reject) => {
        const p: Pending = { name, arg, resolve: resolve as (v: unknown) => void, reject };
        const w = ensureWorker();
        if (!w) {
          runInline(p);
          return;
        }
        const id = ++seq;
        pending.set(id, p);
        w.postMessage({ id, name, arg, dbName: db.name } satisfies TaskRequest);
      });
    },
    usesWorker: () => !broken,
    terminate() {
      worker?.terminate();
      worker = null;
      for (const p of pending.values()) p.reject(new Error("storage runner stopped"));
      pending.clear();
    },
  };
}
