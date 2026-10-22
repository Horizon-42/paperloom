// 每块画布上次的平移与缩放：只是这个浏览器里的查看状态，存 localStorage，不写数据库
// （写 boards 表会让存储模块把每次平移都当成数据变化去重写镜像文件）。读写失败（隐私模式等）时静默忽略。
import type { Board } from "@/types/models";

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

const key = (boardId: string) => `paperlens.canvas.viewport.${boardId}`;

const valid = (v: unknown): v is ViewportState => {
  const o = v as ViewportState | null;
  return !!o && [o.x, o.y, o.zoom].every((n) => typeof n === "number" && Number.isFinite(n)) && o.zoom > 0;
};

export function loadViewport(boardId: string): ViewportState | null {
  try {
    const raw = localStorage.getItem(key(boardId));
    const v: unknown = raw ? JSON.parse(raw) : null;
    return valid(v) ? { x: v.x, y: v.y, zoom: v.zoom } : null;
  } catch {
    return null;
  }
}

export function saveViewport(boardId: string, v: ViewportState): void {
  if (!valid(v)) return;
  try {
    localStorage.setItem(key(boardId), JSON.stringify({ x: v.x, y: v.y, zoom: v.zoom }));
  } catch {
    // 存不下就算了，下次打开时适配全部节点
  }
}

export function forgetViewport(boardId: string): void {
  try {
    localStorage.removeItem(key(boardId));
  } catch {
    // 忽略
  }
}

/** 打开画布时用的视口：本浏览器记住的 > 旧数据里 Board.viewport（不再写入） > null（适配全部节点） */
export function initialViewport(board: Pick<Board, "id" | "viewport">): ViewportState | null {
  return loadViewport(board.id) ?? (valid(board.viewport) ? board.viewport : null);
}
