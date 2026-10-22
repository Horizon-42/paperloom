// 从其他模块（术语弹窗、角注）跳到画布上的某个实体。不依赖 React Flow。
import { useAnnotationStore } from "@/app/stores/annotation";
import { useCanvasStore } from "@/app/stores/canvas";
import { t } from "@/i18n";
import { boardsContaining, defaultBoardName, listBoardsByRecent } from "@/services/canvasService";
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
    useAnnotationStore.getState().showToast(t.canvas.noBoardsToast);
    return;
  }
  st.focusEntity(target.id, ref, { place: true });
}

/**
 * 下一个默认画布名（当前界面语言）："未命名画布"、"未命名画布 2"…；英文为 "Untitled canvas"、"Untitled canvas 2"…
 * 只和当前语言的默认名比较：切换语言前建的画布名字是数据，不影响新名字的序号。
 */
export function nextBoardName(boards: readonly Pick<Board, "name">[], base = defaultBoardName()): string {
  const names = new Set(boards.map((b) => b.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    const name = t.canvas.numberedBoardName(base, i);
    if (!names.has(name)) return name;
  }
}
