// 页面渲染耗时记录（开发模式），供 e2e 和手工性能检查读取：window.__paperlensPerf
export interface PageRenderTiming {
  paperId: string;
  page: number;
  scale: number;
  /** initial：页面进入渲染范围后的首次渲染；rerender：缩放后的重绘（只计 canvas） */
  kind: "initial" | "rerender";
  /** 从进入渲染范围起算的完成时刻 */
  canvasMs: number;
  textMs: number;
  /** 字形映射本身的耗时（重放 + 对齐；命中缓存为 0） */
  glyphMs: number;
  /** 词级校正本身的耗时 */
  fixMs: number;
  /** canvas、文本层、字形映射、词级校正全部完成的耗时 */
  totalMs: number;
}

const MAX = 500;

export function recordPageRender(t: PageRenderTiming) {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as { __paperlensPerf?: PageRenderTiming[] };
  const list = (w.__paperlensPerf ??= []);
  list.push(t);
  if (list.length > MAX) list.splice(0, list.length - MAX);
}
