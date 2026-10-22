// 画布导出：读取数据库快照后交给 jsonCanvas 的纯函数
import { loadCanvasExportData } from "@/services/canvasService";
import type { ExtraFile } from "@/services/storage/extraFiles";
import { markdownFileNames } from "@/services/storage/markdown";
import { canvasFileNames, serializeJsonCanvas, toJsonCanvas } from "./jsonCanvas";

/** 全部画布 → data/canvas/<画布名>.canvas（由存储模块在保存时调用） */
export async function produceCanvasFiles(): Promise<ExtraFile[]> {
  const data = await loadCanvasExportData();
  const names = canvasFileNames(data.boards);
  const md = data.library && markdownFileNames(data.library.papers, data.library.terms);
  return data.boards.map((b) => ({ name: names.get(b.id)!, content: serializeJsonCanvas(toJsonCanvas(b.id, data, md)) }));
}

/** 单块画布的 .canvas 文件（文件名只按自身名称清理，不与其他画布去重） */
export async function exportBoardFile(boardId: string): Promise<ExtraFile | null> {
  const data = await loadCanvasExportData([boardId]);
  const board = data.boards[0];
  if (!board) return null;
  const name = canvasFileNames([board]).get(board.id)!;
  const md = data.library && markdownFileNames(data.library.papers, data.library.terms);
  return { name, content: serializeJsonCanvas(toJsonCanvas(board.id, data, md)) };
}

export function downloadTextFile(file: ExtraFile, type = "application/json") {
  const url = URL.createObjectURL(new Blob([file.content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
