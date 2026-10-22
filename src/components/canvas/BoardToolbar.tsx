// 画布顶栏：切换/新建画布、重命名、关联领域、适配视图、导出 .canvas、删除画布
import { useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useLiveQuery } from "dexie-react-hooks";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore } from "@/app/stores/canvas";
import { reportError } from "@/components/annotation/actions";
import { db } from "@/db/schema";
import { createBoard, renameBoard, setBoardDomains } from "@/services/canvasService";
import { buildDomainTree, flattenTree } from "@/services/domainTree";
import type { Board } from "@/types/models";
import { BoardNameDialog, DeleteBoardDialog } from "./dialogs";
import { downloadTextFile, exportBoardFile } from "./exportCanvas";
import { nextBoardName } from "./navigation";
import {
  IconCanvas,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconFit,
  IconFolder,
  IconMore,
  IconPen,
  IconPlus,
  IconTrash,
  cx,
  menuContent,
  menuItem,
  menuItemDanger,
  menuSeparator,
} from "./ui";

const toolBtn = "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900";

export function NewBoardDialog({ boards, onClose }: { boards: Board[]; onClose: () => void }) {
  return (
    <BoardNameDialog
      title="新建画布"
      initial={nextBoardName(boards)}
      confirmText="新建"
      onSubmit={async (name) => {
        const b = await createBoard(name);
        useCanvasStore.getState().openBoard(b.id);
      }}
      onClose={onClose}
    />
  );
}

export function BoardToolbar({ board, boards }: { board: Board; boards: Board[] }) {
  const rf = useReactFlow();
  const [dialog, setDialog] = useState<null | "new" | "rename" | "delete">(null);
  const nodeCount = useLiveQuery(() => db.boardNodes.where("boardId").equals(board.id).count(), [board.id]);
  const domains = useLiveQuery(() => db.domains.toArray(), []);
  const domainOptions = useMemo(() => flattenTree(buildDomainTree(domains ?? [])), [domains]);
  const domainNames = board.domainIds.flatMap((id) => domains?.find((d) => d.id === id)?.name ?? []);

  const exportFile = async () => {
    try {
      const f = await exportBoardFile(board.id);
      if (f) downloadTextFile(f);
    } catch (e) {
      reportError("导出失败")(e);
    }
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-neutral-200 bg-white px-3" data-board-toolbar>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[14px] font-semibold text-neutral-900 hover:bg-neutral-100"
            title="切换画布"
            data-board-picker
          >
            <IconCanvas width={15} height={15} className="shrink-0 text-neutral-500" />
            <span className="max-w-[280px] truncate" data-board-name>
              {board.name}
            </span>
            <IconChevronDown width={14} height={14} className="shrink-0 text-neutral-400" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={cx(menuContent, "max-h-[60vh] w-64 overflow-y-auto")} align="start" sideOffset={4}>
            <DropdownMenu.Label className="px-2 py-1 text-[11px] text-neutral-400">画布（最近修改的在前）</DropdownMenu.Label>
            {boards.map((b) => (
              <DropdownMenu.Item key={b.id} className={menuItem} onSelect={() => useCanvasStore.getState().openBoard(b.id)} data-board-item={b.id}>
                <span className="w-3.5 shrink-0">{b.id === board.id && <IconCheck width={14} height={14} />}</span>
                <span className="truncate">{b.name}</span>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className={menuSeparator} />
            <DropdownMenu.Item className={menuItem} onSelect={() => setDialog("new")} data-new-board>
              <IconPlus width={14} height={14} /> 新建画布…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <button type="button" className={toolBtn} title="重命名画布" aria-label="重命名画布" onClick={() => setDialog("rename")}>
        <IconPen width={13} height={13} />
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={cx(toolBtn, "min-w-0")} title="关联领域：收件箱默认按这些领域筛选" data-board-domains>
            <IconFolder width={13} height={13} className="shrink-0" />
            <span className="max-w-[220px] truncate">{domainNames.length ? domainNames.join("、") : "关联领域"}</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={cx(menuContent, "max-h-[60vh] w-60 overflow-y-auto")} align="start" sideOffset={4}>
            <DropdownMenu.Label className="px-2 py-1 text-[11px] text-neutral-400">这块画布关联的领域</DropdownMenu.Label>
            {domainOptions.map((n) => {
              const on = board.domainIds.includes(n.domain.id);
              return (
                <DropdownMenu.CheckboxItem
                  key={n.domain.id}
                  className={menuItem}
                  style={{ paddingLeft: 8 + n.depth * 12 }}
                  checked={on}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(c) => {
                    const next = c ? [...board.domainIds, n.domain.id] : board.domainIds.filter((d) => d !== n.domain.id);
                    setBoardDomains(board.id, next).catch(reportError("保存失败"));
                  }}
                >
                  <span className="w-3.5 shrink-0">
                    <DropdownMenu.ItemIndicator>
                      <IconCheck width={14} height={14} />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="truncate">{n.domain.name}</span>
                </DropdownMenu.CheckboxItem>
              );
            })}
            {!domainOptions.length && <div className="px-2 py-1.5 text-[12px] text-neutral-400">还没有领域</div>}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {nodeCount !== undefined && <span className="ml-1 shrink-0 text-[12px] tabular-nums text-neutral-400">{nodeCount} 个节点</span>}
      <span className="flex-1" />

      <button type="button" className={toolBtn} title="显示全部节点" data-fit-view onClick={() => void rf.fitView({ padding: 0.2, duration: 300, maxZoom: 1 })}>
        <IconFit width={14} height={14} /> 全部
      </button>
      <button type="button" className={toolBtn} title="导出为 Obsidian 可打开的 JSON Canvas 文件" onClick={() => void exportFile()} data-export-canvas>
        <IconDownload width={14} height={14} /> 导出 .canvas
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={toolBtn} aria-label="更多操作" title="更多操作" data-board-more>
            <IconMore width={15} height={15} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={menuContent} align="end" sideOffset={4}>
            <DropdownMenu.Item className={menuItem} onSelect={() => setDialog("new")}>
              <IconPlus width={14} height={14} /> 新建画布…
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={() => setDialog("rename")}>
              <IconPen width={14} height={14} /> 重命名…
            </DropdownMenu.Item>
            <DropdownMenu.Separator className={menuSeparator} />
            <DropdownMenu.Item className={menuItemDanger} onSelect={() => setDialog("delete")} data-delete-board>
              <IconTrash width={14} height={14} /> 删除画布…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {dialog === "new" && <NewBoardDialog boards={boards} onClose={() => setDialog(null)} />}
      {dialog === "rename" && (
        <BoardNameDialog title="重命名画布" initial={board.name} confirmText="保存" onSubmit={(name) => renameBoard(board.id, name)} onClose={() => setDialog(null)} />
      )}
      {dialog === "delete" && <DeleteBoardDialog boardId={board.id} onClose={() => setDialog(null)} />}
    </div>
  );
}
