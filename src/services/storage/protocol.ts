// 主线程与存储 Worker 之间的消息格式，以及错误的编码/还原（保留 StorageApiError、DataFormatError 的类型和字段）。
import { StorageApiError } from "./api";
import { DataFormatError } from "./format";
import type { TaskName } from "./tasks";

export interface TaskRequest {
  id: number;
  name: TaskName;
  arg: unknown;
  /** 页面的数据库名：Worker 核对自己打开的是同一个（Worker 按自己的名字确定项目，见 lib/project.ts） */
  dbName: string;
}

/** Worker 打开的数据库与页面不一致时的错误名：调用方据此改在主线程执行 */
export const WRONG_DB_ERROR = "WrongDatabaseError";

export interface EncodedError {
  name: string;
  message: string;
  status?: number;
  code?: string;
  data?: Record<string, unknown>;
}

export type TaskResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: EncodedError };

export function encodeError(e: unknown): EncodedError {
  if (e instanceof StorageApiError) return { name: e.name, message: e.message, status: e.status, code: e.code, data: e.data };
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: "Error", message: String(e) };
}

export function decodeError(e: EncodedError): Error {
  if (e.name === "StorageApiError") return new StorageApiError(e.status ?? 0, e.code ?? "http", e.message, e.data ?? {});
  if (e.name === "DataFormatError") return new DataFormatError(e.message);
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}
