// 论文列表共用一个右键菜单：在容器上监听 contextmenu，按 data-paper-id 找到目标论文；
// 领域树里的论文行还带 data-parent-domain-id（所在的领域，「未分类」里为空），菜单据此提供「从「X」移除」。
// 比每行一个 Radix ContextMenu 轻得多（列表虚拟化后行会频繁挂载/卸载）。
import { t } from "@/i18n";
import { useRef, useState, type ReactElement } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { flattenTree } from "@/services/domainTree";
import { addPaperToDomain, movePaperOutOfDomains, restorePaperDomains } from "@/services/paperService";
import { IconCheck, IconChevronRight } from "./icons";
import { useLibraryData } from "./libraryData";
import { cx, menuContent, menuItem, menuItemDanger, menuSeparator } from "./ui";

/** 右键菜单指向的论文行 */
export interface PaperMenuTarget {
  paperId: string;
  /** 领域树里所在的领域；「未分类」里为 null；平铺列表、搜索结果里为 undefined */
  parentId: string | null | undefined;
}

interface Props {
  /** 子元素必须是能接收 ref 和事件属性的单个元素（如 VirtualList 的滚动容器） */
  children: (menuTarget: PaperMenuTarget | null) => ReactElement;
}

/** 「从「X」移除」：只移出这一行所在的领域，可撤销 */
async function removeFromDomain(paperId: string, domainId: string, name: string) {
  const before = await movePaperOutOfDomains(paperId, [domainId]);
  if (before) useAnnotationStore.getState().showToast(t.library.movePaper.removedFrom(name), { undo: () => restorePaperDomains(paperId, before) });
}

export function PaperContextMenu({ children }: Props) {
  const { paperById, domainById, tree } = useLibraryData();
  const [target, setTarget] = useState<PaperMenuTarget | null>(null);
  const paper = target ? paperById.get(target.paperId) : undefined;
  const parent = target?.parentId ? domainById.get(target.parentId) : undefined;
  const store = useLibraryStore.getState;
  // 「标签…」：等菜单关闭、不再把焦点还给原处之后再打开标签编辑，否则弹层刚拿到焦点就被抢走而关闭
  const pendingTags = useRef<PaperMenuTarget | null>(null);

  return (
    <ContextMenu.Root onOpenChange={(open) => !open && setTarget(null)}>
      <ContextMenu.Trigger
        asChild
        onContextMenu={(e) => {
          const row = (e.target as Element).closest?.("[data-paper-id]");
          const id = row?.getAttribute("data-paper-id");
          if (!row || !id) {
            e.preventDefault(); // 空白处、领域行上不弹论文菜单
            return;
          }
          pendingTags.current = null;
          const parentAttr = row.getAttribute("data-parent-domain-id");
          setTarget({ paperId: id, parentId: parentAttr === null ? undefined : parentAttr || null });
        }}
      >
        {children(target)}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        {paper && (
          <ContextMenu.Content
            className={menuContent}
            onCloseAutoFocus={(e) => {
              const row = pendingTags.current;
              if (!row) return;
              pendingTags.current = null;
              e.preventDefault();
              store().openTagEditor(row.paperId, { kind: "row", parentId: row.parentId });
            }}
          >
            <ContextMenu.Item className={menuItem} onSelect={() => useReaderStore.getState().openPaper(paper.id)}>
              {t.library.paperMenu.open}
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} onSelect={() => store().openDialog({ kind: "editPaper", paperId: paper.id })}>
              {t.library.paperMenu.editInfo}
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} onSelect={() => (pendingTags.current = target)}>
              {t.library.paperMenu.tags}
              <span className="ml-auto pl-6 text-[11px] text-neutral-400">T</span>
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} onSelect={() => useAnnotationStore.getState().openReplaceDialog(paper.id)}>
              {t.library.paperMenu.replacePdf}
            </ContextMenu.Item>
            {/* 添加到领域：保留原来的领域（拖到领域上是移动） */}
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={cx(menuItem, "justify-between data-[state=open]:bg-neutral-100")} data-add-to-domain>
                {t.library.paperMenu.addToDomain}
                <IconChevronRight width={13} height={13} className="text-neutral-400" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={cx(menuContent, "max-h-[60vh] min-w-[160px] max-w-[280px] overflow-y-auto")} sideOffset={4}>
                  {tree.length === 0 && (
                    <ContextMenu.Item className={menuItem} disabled>
                      {t.library.paperMenu.noDomains}
                    </ContextMenu.Item>
                  )}
                  {flattenTree(tree).map(({ domain, depth }) => {
                    const has = paper.domainIds.includes(domain.id);
                    return (
                      <ContextMenu.Item
                        key={domain.id}
                        className={cx(menuItem, "data-[disabled]:text-neutral-400")}
                        disabled={has}
                        onSelect={() => void addPaperToDomain(paper.id, domain.id)}
                        data-domain-id={domain.id}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2" style={{ paddingLeft: depth * 12 }}>
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: domain.color }} />
                          <span className="truncate">{domain.name}</span>
                        </span>
                        {has && <IconCheck width={13} height={13} className="shrink-0 text-neutral-500" />}
                      </ContextMenu.Item>
                    );
                  })}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            {parent && (
              <ContextMenu.Item className={menuItem} onSelect={() => void removeFromDomain(paper.id, parent.id, parent.name)} data-remove-from-domain>
                <span className="truncate">{t.library.paperMenu.removeFromDomain(parent.name)}</span>
              </ContextMenu.Item>
            )}
            <ContextMenu.Separator className={menuSeparator} />
            <ContextMenu.Item className={menuItemDanger} onSelect={() => store().openDialog({ kind: "deletePaper", paperId: paper.id })}>
              {t.library.paperMenu.deletePaper}
            </ContextMenu.Item>
          </ContextMenu.Content>
        )}
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
