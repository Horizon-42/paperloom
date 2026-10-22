// PDF 页边角注上的画布标记（开发文档 9.2 第 5 步）：分别显示"在几块画布上"和"几条连线"，点击跳到画布并定位节点。
// 不依赖 React Flow，角注栏引入它不会加载画布代码。
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useLiveQuery } from "dexie-react-hooks";
import { useCanvasStore } from "@/app/stores/canvas";
import { reportError } from "@/components/annotation/actions";
import { boardsContaining, createBoard, listBoardsByRecent } from "@/services/canvasService";
import { listLinksFor } from "@/services/linkService";
import type { EntityRef } from "@/types/models";
import { nextBoardName } from "./navigation";
import { IconCanvas, IconLink, IconPlus, cx, menuContent, menuItem, menuSeparator } from "./ui";

const badge =
  "inline-flex h-[18px] shrink-0 items-center gap-1 rounded bg-violet-50 px-1 text-[11px] tabular-nums text-violet-700 hover:bg-violet-100";

/**
 * 角注上的画布标记：在几块画布上、有几条连线（各自为 0 时不显示那一半，都为 0 时不显示）。
 * 点击：只在一块画布上时直接过去并定位；多块时选择；不在画布上时选一块画布放进去。
 */
export function AnnotationLinkBadge({ annotationId }: { annotationId: string }) {
  const info = useLiveQuery(async () => {
    const ref: EntityRef = { kind: "annotation", id: annotationId };
    const [links, placed] = await Promise.all([listLinksFor(ref), boardsContaining(ref)]);
    return { links: links.length, placed };
  }, [annotationId]);
  if (!info || (!info.links && !info.placed.length)) return null;

  const ref: EntityRef = { kind: "annotation", id: annotationId };
  const label = [info.placed.length ? `在 ${info.placed.length} 块画布上` : "未放到画布上", info.links ? `${info.links} 条连线` : "没有连线"].join(" · ");
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const focus = (boardId: string, place = false) => useCanvasStore.getState().focusEntity(boardId, ref, { place });
  const content = (
    <>
      {info.placed.length > 0 && (
        <span className="inline-flex items-center gap-0.5" data-badge-boards={info.placed.length}>
          <IconCanvas width={11} height={11} />
          {info.placed.length}
        </span>
      )}
      {info.links > 0 && (
        <span className="inline-flex items-center gap-0.5" data-badge-links={info.links}>
          <IconLink width={11} height={11} />
          {info.links}
        </span>
      )}
    </>
  );

  if (info.placed.length === 1) {
    const b = info.placed[0];
    return (
      <button
        type="button"
        className={badge}
        title={`${label} · 点击在画布「${b.name}」中查看`}
        aria-label={`${label}，在画布中查看`}
        data-canvas-badge
        onClick={(e) => {
          e.stopPropagation();
          focus(b.id);
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={badge} title={label} aria-label={`${label}，选择画布`} data-canvas-badge onClick={stop}>
          {content}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={cx(menuContent, "max-h-[50vh] w-60 overflow-y-auto")} align="start" sideOffset={4} onClick={stop}>
          {info.placed.length > 0 ? (
            <>
              <DropdownMenu.Label className="px-2 py-1 text-[11px] text-neutral-400">在画布中查看（最近修改的在前）</DropdownMenu.Label>
              {info.placed.map((b) => (
                <DropdownMenu.Item key={b.id} className={menuItem} onSelect={() => focus(b.id)} data-badge-board={b.id}>
                  <span className="truncate">{b.name}</span>
                </DropdownMenu.Item>
              ))}
            </>
          ) : (
            <>
              <DropdownMenu.Label className="px-2 py-1 text-[11px] leading-snug text-neutral-400">
                有 {info.links} 条连线，但这条批注还没放到画布上。放到：
              </DropdownMenu.Label>
              <PlaceTargets onPick={(id) => focus(id, true)} />
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** 菜单打开时才读取画布列表（角注栏常驻，避免每张卡片都订阅 boards 表） */
function PlaceTargets({ onPick }: { onPick: (boardId: string) => void }) {
  const boards = useLiveQuery(listBoardsByRecent, []);
  return (
    <>
      {boards?.map((b) => (
        <DropdownMenu.Item key={b.id} className={menuItem} onSelect={() => onPick(b.id)} data-badge-board={b.id}>
          <span className="truncate">{b.name}</span>
        </DropdownMenu.Item>
      ))}
      {!!boards?.length && <DropdownMenu.Separator className={menuSeparator} />}
      <DropdownMenu.Item
        className={menuItem}
        onSelect={() => {
          createBoard(nextBoardName(boards ?? []))
            .then((b) => onPick(b.id))
            .catch(reportError("新建画布失败"));
        }}
        data-badge-new-board
      >
        <IconPlus width={13} height={13} /> 新建画布并放入
      </DropdownMenu.Item>
    </>
  );
}
