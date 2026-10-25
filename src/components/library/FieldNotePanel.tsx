// 右侧的笔记面板（D18）：编辑领域笔记，停靠在主区域右边、不挡住阅读器和画布。
// 自动保存（停止输入后片刻、切换笔记或关闭时立即保存）；可切换为预览。
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useLibraryStore } from "@/app/stores/library";
import { MarkdownEditor } from "@/components/common/MarkdownEditor";
import { MarkdownView } from "@/components/common/MarkdownView";
import { listDomains } from "@/db/repo/domains";
import { getNote } from "@/db/repo/notes";
import { domainPathNames } from "@/services/domainTree";
import { setNoteText } from "@/services/noteService";
import type { Note } from "@/types/models";
import { IconNote, IconX } from "./icons";
import { deleteFieldNote } from "./TreeNoteRow";
import { cx, iconBtn } from "./ui";

const SAVE_DELAY_MS = 500;

export function FieldNotePanel() {
  const id = useLibraryStore((s) => s.openNoteId);
  // 结果带上查询的 id：换了笔记后、新查询返回前，useLiveQuery 还会给出上一次的结果
  const res = useLiveQuery(async () => (id ? { id, note: (await getNote(id)) ?? null } : undefined), [id]);
  const note = res && res.id === id ? res.note : undefined;
  // 笔记被删除（在画布上、其他标签页里）：关闭
  useEffect(() => {
    if (id && note === null) useLibraryStore.getState().openNote(null);
  }, [id, note]);
  if (!id || !note) return null;
  return <Panel key={note.id} note={note} />;
}

function Panel({ note }: { note: Note }) {
  // 面板在侧栏之外，不在 LibraryDataProvider 里：自己读领域
  const domains = useLiveQuery(listDomains, []);
  const domainById = new Map((domains ?? []).map((d) => [d.id, d]));
  const domain = note.domainId ? domainById.get(note.domainId) : undefined;
  const path = domain ? domainPathNames(domainById, domain.id).join(" / ") : "";
  const [draft, setDraft] = useState(note.text);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<"saved" | "saving">("saved");
  const timer = useRef<number>();
  const pending = useRef<string | null>(null);
  const tx = t.library.fieldNotes;

  const flush = () => {
    window.clearTimeout(timer.current);
    const text = pending.current;
    if (text === null) return;
    pending.current = null;
    void setNoteText(note.id, text).finally(() => setStatus(pending.current === null ? "saved" : "saving"));
  };
  // 关闭面板、切换到别的笔记时立即保存
  useEffect(() => () => flush(), []);
  // 别处（画布、其他标签页）改了内容，而这里没有未保存的输入：跟着更新
  useEffect(() => {
    if (pending.current === null) setDraft(note.text);
  }, [note.text]);

  const onChange = (text: string) => {
    setDraft(text);
    pending.current = text;
    setStatus("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };
  const close = () => {
    flush();
    useLibraryStore.getState().openNote(null);
  };

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-neutral-200 bg-white" aria-label={tx.panelLabel} data-note-panel={note.id}>
      <header className="flex items-start gap-2 border-b border-neutral-100 px-3 pb-2 pt-3">
        <IconNote width={16} height={16} className="mt-0.5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-neutral-800">{tx.panelTitle}</div>
          {domain && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-neutral-500" title={path}>
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: domain.color }} />
              <span className="truncate">{path}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-neutral-100 p-0.5" role="group">
          {([false, true] as const).map((p) => (
            <button
              key={String(p)}
              type="button"
              aria-pressed={preview === p}
              onClick={() => setPreview(p)}
              className={cx("h-6 rounded px-2 text-[12px]", preview === p ? "bg-white font-medium text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800")}
            >
              {p ? tx.preview : tx.edit}
            </button>
          ))}
        </div>
        <button type="button" className={cx(iconBtn, "h-7 w-7")} title={tx.closeTitle} aria-label={t.common.close} onClick={close}>
          <IconX width={15} height={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden p-3">
        {preview ? (
          <div className="h-full overflow-y-auto px-1">
            <MarkdownView source={draft} emptyText={tx.empty} className="text-[14px]" />
          </div>
        ) : (
          <MarkdownEditor value={draft} onChange={onChange} onCancel={close} placeholder={tx.placeholder} autoFocus fill className="h-full" />
        )}
      </div>
      <footer className="flex items-center gap-2 border-t border-neutral-100 px-3 py-2 text-[11.5px] text-neutral-400">
        <span className="flex-1" data-note-status={status}>
          {status === "saving" ? tx.saving : tx.saved}
        </span>
        <button type="button" className="rounded px-1.5 py-0.5 text-red-600 hover:bg-red-50" onClick={() => void deleteFieldNote(note.id)}>
          {tx.delete}
        </button>
      </footer>
    </aside>
  );
}
