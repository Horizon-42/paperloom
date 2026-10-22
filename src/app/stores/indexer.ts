import { create } from "zustand";

export type IndexerPhase = "extract" | "match";

export interface IndexerFailure {
  paperId: string;
  message: string;
  /** 已安排稍后自动重试（提取超时） */
  autoRetry?: boolean;
}

/** 最近一次完成的扫描任务 */
export interface IndexerRunInfo {
  papers: number;
  scanned: number;
  skipped: number;
  pages: number;
  termCount: number;
  /** 算出的 occurrences 行数；实际写入、删除的行数 */
  rows: number;
  written: number;
  deleted: number;
  orphans: number;
  /** 构建自动机、匹配、整个任务（Worker 内）的耗时 */
  buildMs: number;
  matchMs: number;
  ms: number;
  at: number;
}

/** 后台索引进度（只读界面状态，由 services/indexer.ts 写入） */
export interface IndexerState {
  running: boolean;
  phase: IndexerPhase | null;
  /** 当前阶段的进度：extract 为论文篇数，match 为本次任务检查的论文数 */
  done: number;
  total: number;
  /** 正在提取全文的论文 */
  currentPaperId: string | null;
  /** 无法提取全文（损坏、缺文件等）而被跳过的论文 */
  failures: IndexerFailure[];
  lastRun: IndexerRunInfo | null;
}

export const initialIndexerState: IndexerState = {
  running: false,
  phase: null,
  done: 0,
  total: 0,
  currentPaperId: null,
  failures: [],
  lastRun: null,
};

export const useIndexerStore = create<IndexerState>()(() => ({ ...initialIndexerState }));
