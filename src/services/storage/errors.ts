// 本地服务（server/）的错误 → 界面文案。服务端返回 { error: <代码>, message: <中文原文>, ...附加字段 }，
// 前端按代码取 t.data.errors.server[代码]；不认识的代码退回服务端原文，没有原文时显示 HTTP 状态。
// 在 Worker 里也能用（Worker 的 t 由 Worker 名里的语言决定）。
import { t } from "@/i18n";
import type { ServerErrorDetail } from "@/i18n/locales/zh/data";

type Entry = string | ((d: ServerErrorDetail) => string);

export function localServiceErrorText(code: string, status: number, serverMessage?: string, data: Record<string, unknown> = {}): string {
  const table = t.data.errors.server as Record<string, Entry>;
  if (Object.prototype.hasOwnProperty.call(table, code)) {
    const entry = table[code];
    return typeof entry === "function" ? entry({ message: serverMessage, data }) : entry;
  }
  return serverMessage ?? t.data.errors.httpStatus(status);
}

/** 本地服务的错误响应体 → 界面文案 */
export function localServiceErrorFromBody(status: number, body: Record<string, unknown>): string {
  const code = typeof body.error === "string" ? body.error : "http";
  const message = typeof body.message === "string" ? body.message : undefined;
  return localServiceErrorText(code, status, message, body);
}
