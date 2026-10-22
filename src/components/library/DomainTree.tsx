// 领域树：固定项（全部论文 / 未分类）+ 可嵌套领域；支持拖放调整层级、把论文拖入领域
import { t } from "@/i18n";
import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type DragEvent, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { useLibraryStore } from "@/app/stores/library";
import { DOMAIN_COLORS, createDomain, moveDomain, renameDomain, setDomainColor } from "@/services/domainService";
import { computeDomainMove, flattenTree, type DomainDrop, type DomainNode, type DropPosition } from "@/services/domainTree";
import { addPaperToDomain } from "@/services/paperService";
import type { Domain } from "@/types/models";
import { DOMAIN_MIME, PAPER_MIME, hasType } from "./dnd";
import { IconCheck, IconChevronRight, IconInbox, IconLibrary, IconMore, IconPlus } from "./icons";
import { useLibraryData } from "./libraryData";
import { cx, iconBtn, menuContent, menuItem, menuItemDanger, menuSeparator } from "./ui";

const INDENT = 14;

interface DropHint {
  targetId: string | null; // null = 顶层末尾的放置区
  position: DropPosition;
}

/** 新建领域并进入重命名状态 */
async function createAndRename(parentId: string | null) {
  const store = useLibraryStore.getState();
  if (parentId) store.setExpanded(parentId, true);
  const d = await createDomain({ parentId });
  store.setRenamingDomain(d.id);
}

export function DomainTree() {
  const { tree, domains, counts, papers, unfiledCount, loaded } = useLibraryData();
  const selection = useLibraryStore((s) => s.selection);
  const expanded = useLibraryStore((s) => s.expanded);
  const renamingId = useLibraryStore((s) => s.renamingDomainId);
  const draggingDomainId = useLibraryStore((s) => s.draggingDomainId);
  const select = useLibraryStore((s) => s.select);

  const rows = useMemo(() => flattenTree(tree, (id) => !!expanded[id]), [tree, expanded]);
  const [hint, setHint] = useState<DropHint | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const expandTimer = useRef<{ id: string; timer: number } | null>(null);

  // 拖动结束（包括拖到窗口外取消）时清除提示
  useEffect(() => {
    const clear = () => {
      setHint(null);
      useLibraryStore.getState().setDraggingDomain(null);
      if (expandTimer.current) window.clearTimeout(expandTimer.current.timer);
      expandTimer.current = null;
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  useEffect(() => {
    if (!flashId) return;
    const timer = window.setTimeout(() => setFlashId(null), 900);
    return () => window.clearTimeout(timer);
  }, [flashId]);

  const setHintIfChanged = (h: DropHint | null) =>
    setHint((cur) => (cur?.targetId === h?.targetId && cur?.position === h?.position ? cur : h));

  /** 拖着悬停在折叠的领域上一会儿后自动展开 */
  const scheduleExpand = (node: DomainNode) => {
    const id = node.domain.id;
    if (!node.children.length || expanded[id]) return;
    if (expandTimer.current?.id === id) return;
    if (expandTimer.current) window.clearTimeout(expandTimer.current.timer);
    expandTimer.current = { id, timer: window.setTimeout(() => useLibraryStore.getState().setExpanded(id, true), 700) };
  };

  /** 根据指针位置算出放置方式；不合法时返回 null */
  const resolveDomainDrop = (e: DragEvent, node: DomainNode): { position: DropPosition; drop: DomainDrop } | null => {
    const dragId = useLibraryStore.getState().draggingDomainId;
    if (!dragId) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const position: DropPosition = y < 0.3 ? "before" : y > 0.7 ? "after" : "inside";
    let drop: DomainDrop = { targetId: node.domain.id, position };
    // 展开节点的下沿在视觉上是"第一个子领域之前"
    if (position === "after" && expanded[node.domain.id] && node.children.length) {
      drop = { targetId: node.children[0].domain.id, position: "before" };
    }
    return computeDomainMove(domains, dragId, drop) === null ? null : { position, drop };
  };

  const onRowDragOver = (e: DragEvent, node: DomainNode) => {
    if (hasType(e, PAPER_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setHintIfChanged({ targetId: node.domain.id, position: "inside" });
      scheduleExpand(node);
      return;
    }
    if (!hasType(e, DOMAIN_MIME)) return;
    const r = resolveDomainDrop(e, node);
    if (!r) {
      setHintIfChanged(null);
      return; // 不 preventDefault → 浏览器显示禁止放置
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHintIfChanged({ targetId: node.domain.id, position: r.position });
    if (r.position === "inside") scheduleExpand(node);
  };

  const onRowDragLeave = (e: DragEvent, node: DomainNode) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setHint((cur) => (cur?.targetId === node.domain.id ? null : cur));
  };

  const onRowDrop = (e: DragEvent, node: DomainNode) => {
    const id = node.domain.id;
    if (hasType(e, PAPER_MIME)) {
      e.preventDefault();
      const paperId = e.dataTransfer.getData(PAPER_MIME);
      if (paperId) void addPaperToDomain(paperId, id).then(() => setFlashId(id));
    } else if (hasType(e, DOMAIN_MIME)) {
      const r = resolveDomainDrop(e, node);
      const dragId = useLibraryStore.getState().draggingDomainId;
      if (!r || !dragId) return;
      e.preventDefault();
      void moveDomain(dragId, r.drop).then((ok) => {
        if (ok && r.drop.position === "inside") useLibraryStore.getState().setExpanded(id, true);
      });
    }
    setHint(null);
  };

  // 行组件用 memo；处理函数通过 ref 取最新闭包，保持引用稳定，论文写入时只有计数变化的行重新渲染
  const latest = useRef({ onDragOver: onRowDragOver, onDragLeave: onRowDragLeave, onDrop: onRowDrop });
  latest.current = { onDragOver: onRowDragOver, onDragLeave: onRowDragLeave, onDrop: onRowDrop };
  const rowHandlers = useMemo<RowHandlers>(
    () => ({
      onDragOver: (e, node) => latest.current.onDragOver(e, node),
      onDragLeave: (e, node) => latest.current.onDragLeave(e, node),
      onDrop: (e, node) => latest.current.onDrop(e, node),
    }),
    [],
  );

  const onRootZoneDragOver = (e: DragEvent) => {
    const dragId = useLibraryStore.getState().draggingDomainId;
    if (!hasType(e, DOMAIN_MIME) || !dragId) return;
    if (computeDomainMove(domains, dragId, { targetId: null, position: "inside" }) === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHintIfChanged({ targetId: null, position: "inside" });
  };

  const onRootZoneDrop = (e: DragEvent) => {
    const dragId = useLibraryStore.getState().draggingDomainId;
    if (!hasType(e, DOMAIN_MIME) || !dragId) return;
    e.preventDefault();
    void moveDomain(dragId, { targetId: null, position: "inside" });
    setHint(null);
  };

  return (
    <nav className="flex max-h-[45%] min-h-[132px] shrink-0 flex-col" aria-label={t.library.domains.navLabel}>
      <div className="space-y-px px-2 pt-2">
        <FixedItem
          icon={<IconLibrary width={15} height={15} />}
          label={t.library.domains.all}
          count={papers.length}
          selected={selection.kind === "all"}
          onClick={() => select({ kind: "all" })}
        />
        <FixedItem
          icon={<IconInbox width={15} height={15} />}
          label={t.library.domains.unfiled}
          count={unfiledCount}
          selected={selection.kind === "unfiled"}
          onClick={() => select({ kind: "unfiled" })}
        />
      </div>

      <div className="mt-2 flex items-center justify-between px-4">
        <span className="text-[11px] font-medium tracking-wide text-neutral-400">{t.library.domains.heading}</span>
        <button type="button" className={iconBtn} title={t.library.domains.newDomain} aria-label={t.library.domains.newDomain} onClick={() => void createAndRename(null)}>
          <IconPlus width={14} height={14} />
        </button>
      </div>

      {/* pt-1：给第一行上方的插入线留位置，避免被滚动容器裁掉 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1" role="tree" aria-label={t.library.domains.treeLabel}>
        {loaded && rows.length === 0 && (
          <p className="px-2 py-1.5 text-xs leading-relaxed text-neutral-400">
            {t.library.domains.empty}
          </p>
        )}
        {rows.map((node) => (
          <DomainRow
            key={node.domain.id}
            node={node}
            count={counts.get(node.domain.id) ?? 0}
            selected={selection.kind === "domain" && selection.id === node.domain.id}
            expanded={!!expanded[node.domain.id]}
            renaming={renamingId === node.domain.id}
            hint={hint?.targetId === node.domain.id ? hint.position : null}
            flash={flashId === node.domain.id}
            handlers={rowHandlers}
          />
        ))}
        {draggingDomainId && (
          <div
            onDragOver={onRootZoneDragOver}
            onDragLeave={() => setHint((cur) => (cur?.targetId === null ? null : cur))}
            onDrop={onRootZoneDrop}
            className={cx(
              "mt-1 rounded-md border border-dashed px-2 py-1.5 text-center text-[11px]",
              hint?.targetId === null ? "border-blue-400 bg-blue-50 text-blue-600" : "border-neutral-300 text-neutral-400",
            )}
          >
            {t.library.domains.dropToRoot}
          </div>
        )}
      </div>
    </nav>
  );
}

function FixedItem(props: { icon: ReactNode; label: string; count: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.selected}
      className={cx(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]",
        props.selected ? "bg-blue-50 font-medium text-blue-900" : "text-neutral-700 hover:bg-neutral-100",
      )}
    >
      <span className={props.selected ? "text-blue-600" : "text-neutral-400"}>{props.icon}</span>
      <span className="flex-1 truncate">{props.label}</span>
      <span className="text-[11px] tabular-nums text-neutral-400">{props.count}</span>
    </button>
  );
}

interface DomainRowProps {
  node: DomainNode;
  count: number;
  selected: boolean;
  expanded: boolean;
  renaming: boolean;
  hint: DropPosition | null;
  flash: boolean;
  handlers: RowHandlers;
}

interface RowHandlers {
  onDragOver: (e: DragEvent, node: DomainNode) => void;
  onDragLeave: (e: DragEvent, node: DomainNode) => void;
  onDrop: (e: DragEvent, node: DomainNode) => void;
}

const DomainRow = memo(function DomainRow({ node, count, selected, expanded, renaming, hint, flash, handlers }: DomainRowProps) {
  const { domain, depth } = node;
  const hasChildren = node.children.length > 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const store = useLibraryStore.getState;
  const indent = 4 + depth * INDENT;
  // 展开节点的"之后"提示线画在子领域的缩进处
  const afterIndent = hasChildren && expanded ? indent + INDENT : indent;

  return (
    <ContextMenu.Root onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger asChild>
        <div
          role="treeitem"
          aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-level={depth + 1}
          data-domain-id={domain.id}
          tabIndex={0}
          draggable={!renaming}
          onDragStart={(e) => {
            e.dataTransfer.setData(DOMAIN_MIME, domain.id);
            e.dataTransfer.setData("text/plain", domain.name);
            e.dataTransfer.effectAllowed = "move";
            store().setDraggingDomain(domain.id);
          }}
          onDragEnd={() => store().setDraggingDomain(null)}
          onDragOver={(e) => handlers.onDragOver(e, node)}
          onDragLeave={(e) => handlers.onDragLeave(e, node)}
          onDrop={(e) => handlers.onDrop(e, node)}
          onClick={() => store().select({ kind: "domain", id: domain.id })}
          onKeyDown={(e) => {
            if (renaming || e.target !== e.currentTarget) return;
            if (e.key === "Enter") store().select({ kind: "domain", id: domain.id });
            else if (e.key === "F2") store().setRenamingDomain(domain.id);
            else if (e.key === "ArrowRight" && hasChildren) store().setExpanded(domain.id, true);
            else if (e.key === "ArrowLeft" && hasChildren) store().setExpanded(domain.id, false);
          }}
          style={{ paddingLeft: indent }}
          className={cx(
            "group relative flex h-7 cursor-default select-none items-center gap-1 rounded-md pr-1 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-300",
            hint === "inside"
              ? "bg-blue-50 ring-2 ring-blue-400"
              : flash
                ? "bg-emerald-50"
                : selected
                  ? "bg-blue-50 font-medium text-blue-900"
                  : "text-neutral-700 hover:bg-neutral-100",
          )}
        >
          {hint === "before" && <DropLine className="-top-px" left={indent + 18} />}
          {hint === "after" && <DropLine className="-bottom-px" left={afterIndent + 18} />}

          <button
            type="button"
            tabIndex={-1}
            aria-label={expanded ? t.library.domains.collapse : t.library.domains.expand}
            onClick={(e) => {
              e.stopPropagation();
              store().toggleExpanded(domain.id);
            }}
            className={cx(
              "flex h-5 w-4 shrink-0 items-center justify-center text-neutral-400 hover:text-neutral-700",
              !hasChildren && "invisible",
            )}
          >
            <IconChevronRight width={13} height={13} className={cx("transition-transform", expanded && "rotate-90")} />
          </button>

          <ColorDot domain={domain} />

          {renaming ? (
            <RenameInput domain={domain} />
          ) : (
            <span
              className="min-w-0 flex-1 truncate"
              title={domain.name}
              onDoubleClick={(e) => {
                e.stopPropagation();
                store().setRenamingDomain(domain.id);
              }}
            >
              {domain.name}
            </span>
          )}

          {!renaming && (
            <>
              <span className={cx("px-1 text-[11px] tabular-nums text-neutral-400", menuOpen ? "hidden" : "group-hover:hidden")}>
                {count || ""}
              </span>
              <div className={cx("items-center", menuOpen ? "flex" : "hidden group-hover:flex")}>
                <button
                  type="button"
                  tabIndex={-1}
                  className={iconBtn}
                  title={t.library.domains.newSubdomain}
                  aria-label={t.library.domains.newSubdomain}
                  onClick={(e) => {
                    e.stopPropagation();
                    void createAndRename(domain.id);
                  }}
                >
                  <IconPlus width={13} height={13} />
                </button>
                <DropdownMenu.Root onOpenChange={setMenuOpen}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      tabIndex={-1}
                      className={iconBtn}
                      title={t.library.domains.more}
                      aria-label={t.library.domains.actions}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <IconMore width={14} height={14} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      sideOffset={4}
                      className={menuContent}
                      onCloseAutoFocus={(e) => e.preventDefault()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DomainMenuItems parts={DROPDOWN_PARTS} domain={domain} />
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuContent} onCloseAutoFocus={(e) => e.preventDefault()}>
          <DomainMenuItems parts={CONTEXT_PARTS} domain={domain} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});

function DropLine({ className, left }: { className: string; left: number }) {
  return (
    <div className={cx("pointer-events-none absolute right-1 z-10 h-0.5 rounded-full bg-blue-500", className)} style={{ left }}>
      <div className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full border-2 border-blue-500 bg-white" />
    </div>
  );
}

function ColorDot({ domain }: { domain: Domain }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          tabIndex={-1}
          title={t.library.domains.changeColor}
          aria-label={t.library.domains.changeColor}
          onClick={(e) => e.stopPropagation()}
          className="flex h-5 w-4 shrink-0 items-center justify-center"
        >
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: domain.color }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          onClick={(e) => e.stopPropagation()}
          className="z-50 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg shadow-neutral-900/10"
        >
          <div className="grid grid-cols-6 gap-1.5">
            {DOMAIN_COLORS.map((c) => (
              <Popover.Close asChild key={c.value}>
                <button
                  type="button"
                  title={t.library.domains.colors[c.key]}
                  aria-label={t.library.domains.colors[c.key]}
                  onClick={() => void setDomainColor(domain.id, c.value)}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-white ring-offset-1 hover:ring-2 hover:ring-neutral-300"
                  style={{ backgroundColor: c.value }}
                >
                  {c.value === domain.color && <IconCheck width={12} height={12} strokeWidth={3} />}
                </button>
              </Popover.Close>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RenameInput({ domain }: { domain: Domain }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    // 等菜单关闭、焦点归位之后再聚焦
    const timer = window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
      ref.current?.scrollIntoView({ block: "nearest" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && ref.current) void renameDomain(domain.id, ref.current.value);
    useLibraryStore.getState().setRenamingDomain(null);
  };

  return (
    <input
      ref={ref}
      defaultValue={domain.name}
      aria-label={t.library.domains.nameLabel}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded border border-blue-400 bg-white px-1.5 text-[13px] font-normal text-neutral-800 outline-none ring-2 ring-blue-100"
    />
  );
}

// ---- 领域菜单：右键菜单和"更多"下拉菜单共用同一组菜单项 ----

interface ItemProps {
  className?: string;
  children?: ReactNode;
  onSelect?: (e: Event) => void;
}
interface MenuParts {
  Item: ComponentType<ItemProps>;
  Separator: ComponentType<{ className?: string }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; children?: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children?: ReactNode; sideOffset?: number }>;
  Portal: ComponentType<{ children?: ReactNode }>;
}

const CONTEXT_PARTS: MenuParts = {
  Item: ContextMenu.Item,
  Separator: ContextMenu.Separator,
  Sub: ContextMenu.Sub,
  SubTrigger: ContextMenu.SubTrigger,
  SubContent: ContextMenu.SubContent,
  Portal: ContextMenu.Portal,
};
const DROPDOWN_PARTS: MenuParts = {
  Item: DropdownMenu.Item,
  Separator: DropdownMenu.Separator,
  Sub: DropdownMenu.Sub,
  SubTrigger: DropdownMenu.SubTrigger,
  SubContent: DropdownMenu.SubContent,
  Portal: DropdownMenu.Portal,
};

function DomainMenuItems({ parts: M, domain }: { parts: MenuParts; domain: Domain }) {
  const store = useLibraryStore.getState;
  return (
    <>
      <M.Item className={menuItem} onSelect={() => void createAndRename(domain.id)}>
        {t.library.domains.newSubdomain}
      </M.Item>
      <M.Item className={menuItem} onSelect={() => store().setRenamingDomain(domain.id)}>
        {t.common.rename}
      </M.Item>
      <M.Sub>
        <M.SubTrigger className={cx(menuItem, "justify-between data-[state=open]:bg-neutral-100")}>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: domain.color }} />
            {t.library.domains.color}
          </span>
          <IconChevronRight width={13} height={13} className="text-neutral-400" />
        </M.SubTrigger>
        <M.Portal>
          <M.SubContent className={cx(menuContent, "min-w-[120px]")} sideOffset={4}>
            {DOMAIN_COLORS.map((c) => (
              <M.Item key={c.value} className={menuItem} onSelect={() => void setDomainColor(domain.id, c.value)}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.value }} />
                <span className="flex-1">{t.library.domains.colors[c.key]}</span>
                {c.value === domain.color && <IconCheck width={13} height={13} className="text-neutral-500" />}
              </M.Item>
            ))}
          </M.SubContent>
        </M.Portal>
      </M.Sub>
      <M.Separator className={menuSeparator} />
      <M.Item className={menuItemDanger} onSelect={() => store().openDialog({ kind: "deleteDomain", domainId: domain.id })}>
        {t.library.domains.deleteDomain}
      </M.Item>
    </>
  );
}
