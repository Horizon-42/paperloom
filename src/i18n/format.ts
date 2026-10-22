// 与语言有关的格式化：相对时间、日期时间。文字部分来自 t.common.time。
import { t } from "./index";

/** "刚刚"、"3 分钟前"、"2 小时前"、"10月20日 14:05"（英文："just now"、"3 min ago"…） */
export function relativeTime(at: number, now = Date.now()): string {
  const tm = t.common.time;
  const s = Math.max(0, now - at) / 1000;
  if (s < 45) return tm.justNow;
  if (s < 3600) return tm.minutesAgo(Math.max(1, Math.round(s / 60)));
  if (s < 86_400) return tm.hoursAgo(Math.round(s / 3600));
  const d = new Date(at);
  return tm.dateTime(d, d.getFullYear() !== new Date(now).getFullYear());
}

/** ISO 时间 → "2026-10-20 14:05"（与语言无关的数字格式）；无法解析时为"未知" */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t.common.unknown;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
