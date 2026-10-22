// 画布节点：批注、术语、论文、自由笔记，以及引用已被删除时的占位节点。
// 节点只存引用，内容来自数据库实时查询；在这里编辑批注笔记会立即同步到 PDF 页边角注，反之亦然。
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useLiveQuery } from "dexie-react-hooks";
import { Handle, NodeResizer, Position, useConnection, useStore, type NodeProps } from "@xyflow/react";
import { useCanvasStore } from "@/app/stores/canvas";
import { useReaderStore } from "@/app/stores/reader";
import { useTermUiStore } from "@/app/stores/termUi";
import { cleanNote, jumpToAnnotation, reportError } from "@/components/annotation/actions";
import { strongColor } from "@/components/annotation/colors";
import { MarkdownEditor } from "@/components/common/MarkdownEditor";
import { setAnnotationNote } from "@/services/annotationService";
import { MIN_NODE_SIZE } from "@/services/canvasService";
import { ENTITY_KIND_LABELS, refKey, resolveEntities, sameRef } from "@/services/linkService";
import { setNoteText } from "@/services/noteService";
import { useCanvasActions } from "./context";
import type { EntityRef } from "@/types/models";
import type { CanvasFlowNode, EntityView } from "./flow";
import { clip, relationText } from "./model";
import { NodeMarkdown } from "./NodeMarkdown";
import { IconJump, IconLink, IconPen, IconPlus, IconTrash, IconX, cx, nodeBtn } from "./ui";

/** 缩放低于此值时节点只显示纯文本（看不清字，渲染 Markdown 也没有意义） */
export const LOW_DETAIL_ZOOM = 0.45;

export const useLowDetail = () => useStore((s) => s.transform[2] < LOW_DETAIL_ZOOM);

type Props = NodeProps<CanvasFlowNode>;
type ViewOf<K extends EntityView["kind"]> = Extract<EntityView, { kind: K }>;

const SIDES = [
  ["t", Position.Top],
  ["r", Position.Right],
  ["b", Position.Bottom],
  ["l", Position.Left],
] as const;

/** 节点底色与边框（Tailwind 4 的默认边框色是 currentColor，必须显式指定） */
const TONES = {
  plain: "border-neutral-200 bg-white",
  term: "border-amber-200 bg-amber-50",
  paper: "border-blue-200 bg-white",
  note: "border-yellow-200 bg-yellow-50",
  missing: "border-dashed border-neutral-300 bg-neutral-50",
};

function Frame({ props, tone = "plain", children }: { props: Props; tone?: keyof typeof TONES; children: ReactNode }) {
  const { id, data, selected } = props;
  const actions = useCanvasActions();
  const connecting = useConnection((c) => c.inProgress);
  const flash = useCanvasStore((s) => s.flashNodeId === id);
  return (
    <div
      className={cx("pl-cnode group relative h-full w-full rounded-lg border text-neutral-700 shadow-sm", TONES[tone])}
      style={selected ? { boxShadow: "0 0 0 2px rgb(59 130 246 / 0.55), 0 4px 14px rgb(0 0 0 / 0.08)" } : undefined}
      data-canvas-node={id}
      data-ref={refKey(data.ref)}
      data-selected={selected || undefined}
      data-flash={flash || undefined}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_NODE_SIZE.w}
        minHeight={MIN_NODE_SIZE.h}
        color="#3b82f6"
        onResizeEnd={(_, p) => actions.resizeNode(id, { x: p.x, y: p.y, w: p.width, h: p.height })}
      />
      {SIDES.map(([hid, pos]) => (
        <Handle key={hid} id={hid} type="source" position={pos} className="pl-chandle" />
      ))}
      {connecting && <Handle id="drop" type="target" position={Position.Top} className="pl-cdrop" isConnectableStart={false} />}
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg">{children}</div>
      {data.external > 0 && <ExternalLinks nodeId={id} self={data.ref} count={data.external} />}
    </div>
  );
}

/** 节点角上的"还有 k 条连线"：另一端不在这块画布上，点开列出，可一键放进来 */
function ExternalLinks({ nodeId, self, count }: { nodeId: string; self: EntityRef; count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="nodrag nopan absolute -bottom-2.5 right-2 z-10 inline-flex h-5 items-center gap-0.5 rounded-full border border-violet-200 bg-white px-1.5 text-[10.5px] text-violet-700 shadow-sm hover:bg-violet-50"
          title={`还有 ${count} 条连线的另一端不在这块画布上`}
          aria-label={`还有 ${count} 条连线不在本画布上`}
          data-external-links={count}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <IconLink width={10} height={10} />+{count}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="nokey z-50 w-[300px] rounded-lg border border-neutral-200 bg-white p-2 text-[12.5px] shadow-xl"
          data-external-popover
        >
          <ExternalList nodeId={nodeId} self={self} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ExternalList({ nodeId, self }: { nodeId: string; self: EntityRef }) {
  const actions = useCanvasActions();
  const list = actions.externalOf(nodeId);
  const key = list.map((x) => refKey(x.other)).join("|");
  const resolved = useLiveQuery(() => resolveEntities(list.map((x) => x.other)), [key]);
  return (
    <>
      <div className="px-1 pb-1 text-[11px] text-neutral-400">另一端不在这块画布上的连线</div>
      <ul className="max-h-64 space-y-0.5 overflow-y-auto">
        {list.map(({ link, other }) => {
          const r = resolved?.get(refKey(other));
          const outgoing = sameRef(link.from, self);
          return (
            <li key={link.id} className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-neutral-50" data-external-item={refKey(other)}>
              <span className="shrink-0 rounded bg-violet-50 px-1 text-[10.5px] text-violet-700">
                {outgoing ? "→" : "←"} {relationText(link)}
              </span>
              <span className="shrink-0 text-[10.5px] text-neutral-400">{ENTITY_KIND_LABELS[other.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-700" title={r?.title}>
                {r?.title ?? "…"}
              </span>
              {r && !r.missing && (
                <button type="button" className={nodeBtn} title="放到这块画布上" aria-label="放到画布" onClick={() => actions.placeNear(nodeId, other)}>
                  <IconPlus width={12} height={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Header({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-0.5 pl-3 pr-1 pt-0.5 text-[10.5px] text-neutral-400">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-data-[selected]:opacity-100">{children}</div>
    </div>
  );
}

function NodeButton({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cx(nodeBtn, danger && "hover:!text-red-600")}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </button>
  );
}

function RemoveButton({ id }: { id: string }) {
  const actions = useCanvasActions();
  return (
    <NodeButton label="移出画布" onClick={() => actions.removeNodes([id])}>
      <IconX width={13} height={13} />
    </NodeButton>
  );
}

/** 节点正文：选中时可滚动（滚轮不缩放画布），未选中时超出部分隐藏 */
function Body({ selected, className, children }: { selected: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cx("min-h-0 flex-1 px-3", selected ? "nowheel overflow-y-auto" : "overflow-hidden", className)} data-node-body>
      {children}
    </div>
  );
}

/** 节点内的 Markdown 编辑器：⌘Enter / 失焦保存，Esc 取消；未经保存/取消就卸载时也保存草稿 */
function NodeEditor({ initial, placeholder, onSave }: { initial: string; placeholder: string; onSave: (text: string) => void }) {
  const [draft, setDraft] = useState(initial);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const done = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) saveRef.current(draftRef.current);
    useCanvasStore.getState().setEditingNode(null);
  };

  useEffect(() => {
    done.current = false;
    return () => {
      if (done.current) return;
      done.current = true;
      saveRef.current(draftRef.current);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="nodrag nopan nowheel cursor-text py-1"
      data-node-editor
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={() => {
        // 推迟判断：焦点移到编辑器内部的其他元素时不算失焦
        setTimeout(() => {
          const wrap = wrapRef.current;
          if (wrap && !wrap.contains(document.activeElement)) finish(true);
        }, 0);
      }}
    >
      <MarkdownEditor value={draft} onChange={setDraft} onSubmit={() => finish(true)} onCancel={() => finish(false)} placeholder={placeholder} autoFocus />
      <div className="mt-0.5 text-[10px] text-neutral-400">⌘Enter 保存 · Esc 取消</div>
    </div>
  );
}

const useEditing = (id: string) => useCanvasStore((s) => s.editingNodeId === id);
const startEdit = (id: string) => useCanvasStore.getState().setEditingNode(id);

// ---------- 批注 ----------

export const AnnotationNode = memo(function AnnotationNode(props: Props) {
  const { id, selected } = props;
  const view = props.data.view as ViewOf<"annotation">;
  const a = view.annotation;
  const editing = useEditing(id);
  const low = useLowDetail();
  return (
    <Frame props={props}>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1 rounded-l-lg" style={{ background: strongColor(a.color, 12) }} />
      <Header
        label={
          <>
            {a.termId ? "批注 · 术语出处" : "批注"}
            {a.anchorStatus === "orphaned" && (
              <span className="ml-1 rounded bg-amber-50 px-1 text-amber-700" title="换过 PDF 文件后找不到原文，跳转只能到原来的页" data-orphaned>
                未定位
              </span>
            )}
          </>
        }
      >
        {!editing && (
          <NodeButton label="编辑笔记" onClick={() => startEdit(id)}>
            <IconPen width={13} height={13} />
          </NodeButton>
        )}
        <NodeButton label="跳到原文" onClick={() => jumpToAnnotation(a)}>
          <IconJump width={13} height={13} />
        </NodeButton>
        <RemoveButton id={id} />
      </Header>
      <Body selected={selected}>
        <div className="mb-1 border-l-2 pl-2 text-[12px] italic leading-snug text-neutral-600" style={{ borderColor: strongColor(a.color, 20) }} data-quote>
          {clip(a.quote.exact || "（无原文）", low ? 120 : 600)}
        </div>
        {editing ? (
          <NodeEditor initial={a.note} placeholder="写笔记（支持 Markdown 和 $公式$）" onSave={(t) => setAnnotationNote(a.id, cleanNote(t)).catch(reportError("保存笔记失败"))} />
        ) : a.note.trim() ? (
          <div data-note>
            <NodeMarkdown source={a.note} lowDetail={low} />
          </div>
        ) : (
          !low && (
            <button type="button" className="nodrag text-[12px] text-neutral-400 hover:text-neutral-600" onClick={() => startEdit(id)} onDoubleClick={(e) => e.stopPropagation()}>
              添加笔记…
            </button>
          )
        )}
      </Body>
      <div className="shrink-0 truncate px-3 pb-1.5 pt-0.5 text-[10.5px] text-neutral-400" title={view.paperTitle} data-source>
        {view.paperTitle ?? "未知论文"} · 第 {a.page} 页
      </div>
    </Frame>
  );
});

// ---------- 术语 ----------

export const TermNode = memo(function TermNode(props: Props) {
  const { id, selected } = props;
  const t = (props.data.view as ViewOf<"term">).term;
  const low = useLowDetail();
  return (
    <Frame props={props} tone="term">
      <Header label="术语">
        <NodeButton label="编辑术语" onClick={() => useTermUiStore.getState().openTermEditor({ termId: t.id })}>
          <IconPen width={13} height={13} />
        </NodeButton>
        <RemoveButton id={id} />
      </Header>
      <div className="shrink-0 px-3">
        <div className="truncate text-[14px] font-semibold leading-tight text-neutral-900" title={t.name} data-term-name>
          {t.name}
        </div>
        {t.aliases.length > 0 && <div className="truncate text-[11px] text-neutral-500">{t.aliases.join("、")}</div>}
      </div>
      <Body selected={selected} className="pb-2 pt-1">
        {t.note.trim() ? <NodeMarkdown source={t.note} lowDetail={low} /> : !low && <div className="text-[12px] text-neutral-300">暂无笔记</div>}
      </Body>
    </Frame>
  );
});

// ---------- 论文 ----------

export const PaperNode = memo(function PaperNode(props: Props) {
  const { id } = props;
  const actions = useCanvasActions();
  const p = (props.data.view as ViewOf<"paper">).paper;
  const meta = [p.authors.slice(0, 3).join(", ") + (p.authors.length > 3 ? " 等" : ""), p.year].filter(Boolean).join(" · ");
  return (
    <Frame props={props} tone="paper">
      <div className="pointer-events-none absolute inset-y-0 left-0 w-1 rounded-l-lg bg-blue-400" />
      <Header label="论文">
        <NodeButton label="放入这篇论文的全部批注" onClick={() => actions.addPaperAnnotations(id, p.id)}>
          <IconPlus width={13} height={13} />
        </NodeButton>
        <NodeButton label="打开论文" onClick={() => useReaderStore.getState().openPaper(p.id)}>
          <IconJump width={13} height={13} />
        </NodeButton>
        <RemoveButton id={id} />
      </Header>
      <div className="min-h-0 flex-1 overflow-hidden px-3 pb-2">
        <div className="line-clamp-3 text-[13px] font-medium leading-snug text-neutral-900" title={p.title} data-paper-title>
          {p.title}
        </div>
        {meta && <div className="mt-0.5 truncate text-[11px] text-neutral-500">{meta}</div>}
      </div>
    </Frame>
  );
});

// ---------- 自由笔记 ----------

export const NoteNode = memo(function NoteNode(props: Props) {
  const { id, selected } = props;
  const n = (props.data.view as ViewOf<"note">).note;
  const editing = useEditing(id);
  const low = useLowDetail();
  const actions = useCanvasActions();
  return (
    <Frame props={props} tone="note">
      <Header label="笔记">
        {!editing && (
          <NodeButton label="编辑笔记" onClick={() => startEdit(id)}>
            <IconPen width={13} height={13} />
          </NodeButton>
        )}
        <NodeButton label="删除笔记" danger onClick={() => actions.deleteNote(n.id)}>
          <IconTrash width={13} height={13} />
        </NodeButton>
        <RemoveButton id={id} />
      </Header>
      <Body selected={selected} className="pb-2">
        {editing ? (
          <NodeEditor initial={n.text} placeholder="写点什么（支持 Markdown 和 $公式$）" onSave={(t) => setNoteText(n.id, cleanNote(t)).catch(reportError("保存笔记失败"))} />
        ) : n.text.trim() ? (
          <div data-note>
            <NodeMarkdown source={n.text} lowDetail={low} />
          </div>
        ) : (
          !low && (
            <button type="button" className="nodrag text-[12px] text-neutral-400 hover:text-neutral-600" onClick={() => startEdit(id)} onDoubleClick={(e) => e.stopPropagation()}>
              写点什么…
            </button>
          )
        )}
      </Body>
    </Frame>
  );
});

// ---------- 已删除 ----------

export const MissingNode = memo(function MissingNode(props: Props) {
  const actions = useCanvasActions();
  return (
    <Frame props={props} tone="missing">
      <div className="flex h-full items-center gap-2 px-3 text-[12px] text-neutral-400" data-missing>
        <span className="min-w-0 flex-1 truncate">已删除的{ENTITY_KIND_LABELS[props.data.ref.kind]}</span>
        <button
          type="button"
          className="nodrag shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-neutral-500 hover:bg-neutral-200/70"
          onClick={(e) => {
            e.stopPropagation();
            actions.removeNodes([props.id]);
          }}
        >
          移出画布
        </button>
      </div>
    </Frame>
  );
});

export const nodeTypes = {
  annotation: AnnotationNode,
  term: TermNode,
  paper: PaperNode,
  note: NoteNode,
  missing: MissingNode,
};
