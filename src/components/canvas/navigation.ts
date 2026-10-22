// 从其他模块（术语弹窗、角注）跳到画布上的某个实体。不依赖 React Flow。
import { useAnnotationStore } from "@/app/stores/annotation";
import { useCanvasStore } from "@/app/stores/canvas";
import { DEFAULT_BOARD_NAME, boardsContaining, listBoardsByRecent } from "@/services/canvasService";
import type { Board, EntityRef } from "@/types/models";

/**
 * 打开放有该实体的画布并定位（多块时取最近修改的）。不在任何画布上时放到当前（或最近修改的）画布中央；
 * 一块画布都没有时提示。
 */
export async function openOnCanvas(ref: EntityRef): Promise<void> {
  const placed = await boardsContaining(ref);
  const st = useCanvasStore.getState();
  if (placed.length) {
    st.focusEntity(placed[0].id, ref);
    return;
  }
  const boards: Board[] = await listBoardsByRecent();
  const target = boards.find((b) => b.id === st.activeBoardId) ?? boards[0];
  if (!target) {
    useAnnotationStore.getState().showToast("还没有画布，请先在「画布」里新建一块");
    return;
  }
  st.focusEntity(target.id, ref, { place: true });
}

/** 下一个默认画布名："未命名画布"、"未命名画布 2"… */
export function nextBoardName(boards: readonly Pick<Board, "name">[], base = DEFAULT_BOARD_NAME): string {
  const names = new Set(boards.map((b) => b.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
