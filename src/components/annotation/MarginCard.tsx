// 角注卡片：颜色、笔记（点击编辑，⌘Enter / 失焦保存，Esc 取消）、术语名、删除
import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useLiveQuery } from "dexie-react-hooks";
import { useAnnotationStore } from "@/app/stores/annotation";
import type { PaneId } from "@/app/stores/reader";
import { useTermUiStore } from "@/app/stores/termUi";
import { MarkdownEditor } from "@/components/common/MarkdownEditor";
import { MarkdownView } from "@/components/common/MarkdownView";
import { AnnotationLinkBadge } from "@/components/canvas/LinkBadge";
import { db } from "@/db/schema";
import { setAnnotationColor, setAnnotationNote } from "@/services/annotationService";
import type { Annotation } from "@/types/models";
import { cleanNote, deleteWithUndo, registerDraft, reportError } from "./actions";
import { HIGHLIGHT_COLORS, colorLabel, strongColor } from "./colors";
import { IconPen, IconTagSmall, IconTrash } from "./icons";

export interface MarginCardProps {
  ann: Annotation;
  paneId: PaneId;
  top: number;
  left: number;
  width: number;
  selected: boolean;
  editing: boolean;
  flashing: boolean;
  onHeight: (id: string, height: number) => void;
}

const iconBtn =
  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700";

export const MarginCard = memo(function MarginCard(props: MarginCardProps) {
  const { ann, paneId, top, left, width, selected, editing, flashing, onHeight } = props;
  const ref = useRef<HTMLDivElement>(null);
  const id = ann.id;

  useLayoutEffect(() => {
    const el = ref.current!;
    onHeight(id, el.offsetHeight);
    const ro = new ResizeObserver(() => onHeight(id, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onHeight]);

  const sel = { paneId, paperId: ann.paperId, id };
  const store = useAnnotationStore.getState;
  const startEdit = (e: MouseEvent) => {
    // 点笔记里的链接不进入编辑
    if ((e.target as Element).closest("a")) return;
    e.stopPropagation();
    store().edit(sel);
  };

  return (
    <div
      ref={ref}
      className="pl-card pointer-events-auto absolute rounded-md border bg-white text-[12.5px] leading-snug text-neutral-700"
      style={{
        top,
        left,
        width,
        borderColor: selected ? strongColor(ann.color, 30) : "rgb(229 229 229)",
        boxShadow: selected ? "0 2px 8px rgb(0 0 0 / 0.12)" : "0 1px 2px rgb(0 0 0 / 0.06)",
        zIndex: selected ? 2 : 1,
      }}
      data-margin-card={id}
      data-selected={selected || undefined}
      data-flash={flashing || undefined}
      onMouseEnter={() => store().setHover(paneId, id)}
      onMouseLeave={() => store().setHover(paneId, null)}
      onClick={() => !editing && store().select(sel)}
    >
      <div className="absolute inset-y-0 left-0 w-[3px] rounded-l-md" style={{ background: strongColor(ann.color, 15) }} />
      <div className="flex items-center gap-1 pl-2.5 pr-1.5 pt-1">
        <ColorPicker color={ann.color} onPick={(c) => setAnnotationColor(id, c).catch(reportError("更改颜色失败"))} />
        {ann.termId && <TermBadge termId={ann.termId} />}
        <AnnotationLinkBadge annotationId={id} />
        {ann.anchorStatus === "relocated" && (
          <span className="shrink-0 text-[10.5px] text-amber-600" title="换过 PDF 文件后按原文重新定位">
            已重新定位
          </span>
        )}
        <span className="flex-1" />
        {!editing && (
          <button type="button" className={iconBtn} aria-label="编辑笔记" title="编辑笔记" onClick={startEdit}>
            <IconPen />
          </button>
        )}
        <button
          type="button"
          className={`${iconBtn} hover:!text-red-600`}
          aria-label="删除批注"
          title="删除批注"
          onClick={(e) => {
            e.stopPropagation();
            void deleteWithUndo(id);
          }}
        >
          <IconTrash />
        </button>
      </div>
      <div className="pb-2 pl-2.5 pr-2 pt-0.5">
        {editing ? (
          <NoteEditor ann={ann} />
        ) : ann.note.trim() ? (
          <div className={selected ? "" : "max-h-[11.5em] overflow-hidden"} onClick={startEdit} data-note>
            <MarkdownView source={ann.note} className="text-[12.5px]" />
          </div>
        ) : (
          <button type="button" className="text-[12px] text-neutral-400 hover:text-neutral-600" onClick={startEdit}>
            添加笔记…
          </button>
        )}
      </div>
    </div>
  );
});

function NoteEditor({ ann }: { ann: Annotation }) {
  const [draft, setDraft] = useState(ann.note);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const done = useRef(false);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) saveNote(ann.id, draftRef.current);
    useAnnotationStore.getState().stopEditing();
  };

  // 登记草稿（删除时先保存）；未经保存/取消就卸载（如选中了别的批注）时也保存草稿
  useEffect(() => {
    done.current = false;
    const unregister = registerDraft(ann.id, () => draftRef.current);
    return () => {
      unregister();
      if (done.current) return;
      done.current = true;
      saveNote(ann.id, draftRef.current);
    };
  }, [ann.id]);

  const wrapRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={wrapRef}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        // 推迟判断：编辑器重建（StrictMode 重挂载、聚焦元素被移除时 Chrome 也会发 blur）后焦点会回到编辑器里；
        // 切到别的窗口时 activeElement 不变，也不算失焦
        setTimeout(() => {
          const wrap = wrapRef.current;
          if (wrap && !wrap.contains(document.activeElement)) finish(true);
        }, 0);
      }}
      data-note-editor
    >
      <MarkdownEditor
        value={draft}
        onChange={setDraft}
        onSubmit={() => finish(true)}
        onCancel={() => finish(false)}
        placeholder="写笔记（支持 Markdown 和 $公式$）"
        autoFocus
      />
      <div className="mt-1 text-[10.5px] text-neutral-400">⌘Enter 保存 · Esc 取消</div>
    </div>
  );
}

function saveNote(id: string, text: string) {
  setAnnotationNote(id, cleanNote(text)).catch(reportError("保存笔记失败"));
}

function ColorPicker({ color, onPick }: { color: string; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-neutral-100"
          aria-label={`颜色：${colorLabel(color)}，点击更改`}
          title="更改颜色"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="h-3 w-3 rounded-full border" style={{ background: color, borderColor: strongColor(color, 25) }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 flex gap-1 rounded-md border border-neutral-200 bg-white p-1.5 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-label={c.label}
              title={c.label}
              data-color={c.value}
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-100"
              onClick={() => {
                onPick(c.value);
                setOpen(false);
              }}
            >
              <span
                className="h-4 w-4 rounded-full border"
                style={{
                  background: c.value,
                  borderColor: strongColor(c.value, 25),
                  boxShadow: c.value === color ? `0 0 0 2px white, 0 0 0 3.5px ${strongColor(c.value, 40)}` : undefined,
                }}
              />
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function TermBadge({ termId }: { termId: string }) {
  const term = useLiveQuery(() => db.terms.get(termId), [termId]);
  if (!term) return null;
  return (
    <button
      type="button"
      className="inline-flex min-w-0 items-center gap-0.5 rounded bg-amber-50 px-1 py-px text-[11px] text-amber-800 hover:bg-amber-100"
      title="打开术语"
      data-term-badge={termId}
      onClick={(e) => {
        e.stopPropagation();
        useTermUiStore.getState().openTermEditor({ termId });
      }}
    >
      <IconTagSmall width={11} height={11} className="shrink-0" />
      <span className="truncate">{term.name}</span>
    </button>
  );
}
