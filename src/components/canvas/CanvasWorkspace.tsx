// 画布视图（按需加载的 chunk）：顶栏 + 左侧素材面板 + React Flow 画布
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ReactFlowProvider } from "@xyflow/react";
import { useCanvasStore } from "@/app/stores/canvas";
import { listBoardsByRecent } from "@/services/canvasService";
import { BoardCanvas } from "./BoardCanvas";
import { BoardToolbar, NewBoardDialog } from "./BoardToolbar";
import { CanvasSidebar } from "./CanvasSidebar";
import type { BoardBridge } from "./context";
import { IconCanvas, IconPlus, btnPrimary } from "./ui";

export default function CanvasWorkspace() {
  const activeId = useCanvasStore((s) => s.activeBoardId);
  // 画布列表与当前画布在同一次查询里读取：刚新建的画布切过去时一定能找到
  const state = useLiveQuery(async () => {
    const boards = await listBoardsByRecent();
    return { forId: activeId, boards, board: boards.find((b) => b.id === activeId) ?? boards[0] ?? null };
  }, [activeId]);
  const bridgeRef = useRef<BoardBridge | null>(null);
  // 当前画布不存在（被删除、首次打开）时退回最近修改的画布。只认针对当前 activeId 的查询结果，
  // 切换画布后旧查询的结果还没更新时不能把 activeId 改回去
  const fresh = state?.forId === activeId;
  const fallbackId = fresh && state.board && state.board.id !== activeId ? state.board.id : null;
  useEffect(() => {
    if (fallbackId) useCanvasStore.getState().setActiveBoard(fallbackId);
  }, [fallbackId]);

  // 新查询返回前继续显示上一块画布，避免闪白
  if (!state) return <div className="flex-1 bg-neutral-50" />;
  const { boards, board } = state;
  if (!board) return <NoBoards />;

  return (
    <ReactFlowProvider key={board.id}>
      <div className="flex min-h-0 flex-1 flex-col bg-white" data-canvas-workspace={board.id}>
        <BoardToolbar board={board} boards={boards} />
        <div className="flex min-h-0 flex-1">
          <CanvasSidebar board={board} bridgeRef={bridgeRef} />
          <BoardCanvas board={board} bridgeRef={bridgeRef} />
        </div>
      </div>
    </ReactFlowProvider>
  );
}

function NoBoards() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-neutral-50 text-center" data-canvas-empty>
      <IconCanvas width={36} height={36} className="text-neutral-300" />
      <div className="text-[15px] font-medium text-neutral-700">还没有画布</div>
      <p className="max-w-sm text-[13px] leading-relaxed text-neutral-500">
        读完后在画布上整理批注：把批注、术语和论文拖进来，用带关系的连线连成网络。同一批笔记可以按不同主题整理成多块画布。
      </p>
      <button type="button" className={btnPrimary} onClick={() => setOpen(true)} data-create-first-board>
        <IconPlus width={14} height={14} /> 新建画布
      </button>
      {open && <NewBoardDialog boards={[]} onClose={() => setOpen(false)} />}
    </div>
  );
}
