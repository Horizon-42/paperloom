// 术语下划线耗时记录（开发模式），供 e2e 性能检查读取：window.__paperlensTermPerf
export interface TermPerfRecord {
  paperId: string;
  page: number;
  /** initial：本页首次画出；update：术语或设置变化后重画；zoom：缩放后只重算屏幕坐标 */
  kind: string;
  /** 本页全部命中数 / 按显示设置画出的命中数 / 下划线段数 */
  matches: number;
  shown: number;
  segments: number;
  matchMs: number;
  rectMs: number;
  /** 从开始匹配到下划线写入 DOM（layout effect）的耗时 */
  totalMs: number;
  /** 是否用字形映射定位（否则是文本层 DOM 兜底） */
  glyphs: boolean;
  /** 匹配器里的术语数 */
  terms: number;
}

const MAX = 1000;

export function recordTermPerf(r: TermPerfRecord) {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as { __paperlensTermPerf?: TermPerfRecord[] };
  const list = (w.__paperlensTermPerf ??= []);
  list.push(r);
  if (list.length > MAX) list.splice(0, list.length - MAX);
}
