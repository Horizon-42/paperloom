/** "刚刚"、"3 分钟前"、"2 小时前"、"10月20日 14:05" */
export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, now - at) / 1000;
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`;
  if (s < 86_400) return `${Math.round(s / 3600)} 小时前`;
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${sameYear ? "" : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "未知";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
