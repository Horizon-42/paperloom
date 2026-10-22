// 论文列表共用一个右键菜单：在容器上监听 contextmenu，按 data-paper-id 找到目标论文。
// 比每行一个 Radix ContextMenu 轻得多（列表虚拟化后行会频繁挂载/卸载）。
import { useRef, useState, type ReactElement } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { removePaperFromDomains } from "@/services/paperService";
import { useLibraryData } from "./libraryData";
import { menuContent, menuItem, menuItemDanger, menuSeparator } from "./ui";

/** 当前选中的领域（用于"从当前领域移除"） */
export interface CurrentDomain {
  id: string;
  name: string;
  subtreeIds: string[];
}

interface Props {
  currentDomain: CurrentDomain | null;
  /** 子元素必须是能接收 ref 和事件属性的单个元素（如 VirtualList 的滚动容器） */
  children: (menuTargetId: string | null) => ReactElement;
}

export function PaperContextMenu({ currentDomain, children }: Props) {
  const { paperById } = useLibraryData();
  const [targetId, setTargetId] = useState<string | null>(null);
  const paper = targetId ? paperById.get(targetId) : undefined;
  const inCurrent = !!paper && !!currentDomain && paper.domainIds.some((id) => currentDomain.subtreeIds.includes(id));
  const store = useLibraryStore.getState;
  // 「标签…」：等菜单关闭、不再把焦点还给原处之后再打开标签编辑，否则弹层刚拿到焦点就被抢走而关闭
  const pendingTags = useRef<string | null>(null);

  return (
    <ContextMenu.Root onOpenChange={(open) => !open && setTargetId(null)}>
      <ContextMenu.Trigger
        asChild
        onContextMenu={(e) => {
          const id = (e.target as Element).closest?.("[data-paper-id]")?.getAttribute("data-paper-id");
          if (!id) {
            e.preventDefault(); // 空白处不弹菜单
            return;
          }
          pendingTags.current = null;
          setTargetId(id);
        }}
      >
        {children(targetId)}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        {paper && (
          <ContextMenu.Content
            className={menuContent}
            onCloseAutoFocus={(e) => {
              const id = pendingTags.current;
              if (!id) return;
              pendingTags.current = null;
              e.preventDefault();
              store().openTagEditor(id, { kind: "row" });
            }}
          >
            <ContextMenu.Item className={menuItem} onSelect={() => useReaderStore.getState().openPaper(paper.id)}>
              打开
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} onSelect={() => store().openDialog({ kind: "editPaper", paperId: paper.id })}>
              编辑信息…
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} onSelect={() => (pendingTags.current = paper.id)}>
              标签…
              <span className="ml-auto pl-6 text-[11px] text-neutral-400">T</span>
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} onSelect={() => useAnnotationStore.getState().openReplaceDialog(paper.id)}>
              替换 PDF 文件…
            </ContextMenu.Item>
            {currentDomain && (
              <ContextMenu.Item
                className={menuItem}
                disabled={!inCurrent}
                onSelect={() => void removePaperFromDomains(paper.id, currentDomain.subtreeIds)}
              >
                <span className="truncate">从「{currentDomain.name}」移除</span>
              </ContextMenu.Item>
            )}
            <ContextMenu.Separator className={menuSeparator} />
            <ContextMenu.Item className={menuItemDanger} onSelect={() => store().openDialog({ kind: "deletePaper", paperId: paper.id })}>
              删除论文…
            </ContextMenu.Item>
          </ContextMenu.Content>
        )}
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
