// 侧栏弹窗：编辑论文信息、删除论文确认、删除领域确认、管理标签
import { htmlLang, t } from "@/i18n";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useLiveQuery } from "dexie-react-hooks";
import { useLibraryStore } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { getPaper } from "@/db/repo/papers";
import { deleteDomain, getDomainDeleteImpact } from "@/services/domainService";
import { domainPathNames, flattenTree } from "@/services/domainTree";
import {
  deletePaper,
  formatAuthorsInput,
  getPaperDeleteImpact,
  parseAuthorsInput,
  updatePaperMetadata,
} from "@/services/paperService";
import { normalizeTags, tagKey } from "@/lib/tags";
import type { Paper } from "@/types/models";
import { Shell } from "./DialogShell";
import { IconX } from "./icons";
import { useLibraryData } from "./libraryData";
import { ManageTagsDialog } from "./ManageTagsDialog";
import { TagInput, type TagInputHandle } from "./TagInput";
import { btnDanger, btnGhost, btnPrimary, cx, input } from "./ui";

export function LibraryDialogs() {
  const dialog = useLibraryStore((s) => s.dialog);
  const close = useLibraryStore((s) => s.closeDialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "editPaper":
      return <EditPaperDialog key={dialog.paperId} paperId={dialog.paperId} onClose={close} />;
    case "deletePaper":
      return <DeletePaperDialog key={dialog.paperId} paperId={dialog.paperId} onClose={close} />;
    case "deleteDomain":
      return <DeleteDomainDialog key={dialog.domainId} domainId={dialog.domainId} onClose={close} />;
    case "manageTags":
      return <ManageTagsDialog onClose={close} />;
  }
}

// ---------- 编辑论文信息 ----------

function EditPaperDialog({ paperId, onClose }: { paperId: string; onClose: () => void }) {
  const paper = useLiveQuery(() => getPaper(paperId).then((p) => p ?? null), [paperId]);
  useEffect(() => {
    if (paper === null) onClose(); // 论文已被删除
  }, [paper, onClose]);
  if (!paper) return null;
  return (
    <Shell title={t.library.editPaper.title} onClose={onClose} wide>
      <EditPaperForm paper={paper} onClose={onClose} />
    </Shell>
  );
}

function EditPaperForm({ paper, onClose }: { paper: Paper; onClose: () => void }) {
  const { tree, domainById, tags: allTags } = useLibraryData();
  const [title, setTitle] = useState(paper.title);
  const [authors, setAuthors] = useState(formatAuthorsInput(paper.authors));
  const [year, setYear] = useState(paper.year?.toString() ?? "");
  const [domainIds, setDomainIds] = useState(() => paper.domainIds.filter((id) => domainById.has(id)));
  // 打开时的标签：保存时只把与它相比的增删写回，不覆盖期间从别处（弹层、其他标签页）加上的标签
  const [initialTags] = useState(() => paper.tags ?? []);
  const [tags, setTags] = useState(initialTags);
  const tagInput = useRef<TagInputHandle>(null);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);

  const options = useMemo(
    () =>
      flattenTree(tree).map((n) => ({
        domain: n.domain,
        path: domainPathNames(domainById, n.domain.id),
      })),
    [tree, domainById],
  );
  const shown = filter.trim()
    ? options.filter((o) => o.path.join(" / ").toLowerCase().includes(filter.trim().toLowerCase()))
    : options;

  const yearText = year.trim();
  const yearError = yearText && !/^\d{4}$/.test(yearText) ? t.library.editPaper.yearInvalid : null;
  const titleError = !title.trim() ? t.library.editPaper.titleRequired : null;

  const toggle = (id: string) => setDomainIds((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (yearError || titleError || saving) return;
    setSaving(true);
    try {
      // 标签框里还没回车的文字也一起保存
      const finalTags = normalizeTags([...tags, ...(tagInput.current?.takeDraft() ?? [])]);
      await updatePaperMetadata(paper.id, {
        title,
        authors: parseAuthorsInput(authors),
        year: yearText ? Number(yearText) : null,
        domainIds,
        tagChanges: diffTags(initialTags, finalTags),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const label = "mb-1 block text-xs font-medium text-neutral-500";
  return (
    <form onSubmit={submit} className="space-y-3.5">
      <div>
        <label className={label} htmlFor="paper-title">
          {t.library.editPaper.titleLabel}
        </label>
        <textarea
          id="paper-title"
          value={title}
          rows={2}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          className={cx(input, "h-auto resize-none py-1.5 leading-snug")}
        />
        {titleError && <p className="mt-1 text-xs text-red-600">{titleError}</p>}
      </div>
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <div>
          <label className={label} htmlFor="paper-authors">
            {t.library.editPaper.authorsLabel} <span className="font-normal text-neutral-400">{t.library.editPaper.authorsHint}</span>
          </label>
          <input id="paper-authors" value={authors} onChange={(e) => setAuthors(e.target.value)} className={input} placeholder={t.library.editPaper.authorsPlaceholder} />
        </div>
        <div>
          <label className={label} htmlFor="paper-year">
            {t.library.editPaper.yearLabel}
          </label>
          <input
            id="paper-year"
            value={year}
            inputMode="numeric"
            onChange={(e) => setYear(e.target.value)}
            className={cx(input, "tabular-nums", yearError && "border-red-400 focus:border-red-400 focus:ring-red-100")}
            placeholder="2024"
          />
        </div>
      </div>
      {yearError && <p className="-mt-2 text-xs text-red-600">{yearError}</p>}

      <div>
        <label className={label} htmlFor="paper-tags">
          {t.library.editPaper.tagsLabel} <span className="font-normal text-neutral-400">{t.library.editPaper.tagsHint}</span>
        </label>
        <TagInput
          ref={tagInput}
          id="paper-tags"
          variant="form"
          tags={tags}
          allTags={allTags}
          onAdd={(xs) => setTags((cur) => normalizeTags([...cur, ...xs]))}
          onRemove={(tag) => setTags((cur) => cur.filter((x) => x !== tag))}
          placeholder={t.library.editPaper.tagsPlaceholder}
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className={cx(label, "mb-0")}>{t.library.editPaper.domainsLabel}</span>
          <span className="text-[11px] text-neutral-400">{t.library.editPaper.selectedCount(domainIds.length)}</span>
        </div>
        {domainIds.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {domainIds.map((id) => {
              const d = domainById.get(id);
              if (!d) return null;
              return (
                <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-neutral-100 py-0.5 pl-2 pr-1 text-[11.5px] text-neutral-700">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: d.color }} />
                  <span className="truncate">{domainPathNames(domainById, id).join(" / ")}</span>
                  <button type="button" onClick={() => toggle(id)} className="rounded-full p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700" aria-label={t.library.editPaper.removeDomain(d.name)}>
                    <IconX width={11} height={11} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {options.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-200 px-3 py-3 text-center text-xs text-neutral-400">{t.library.editPaper.noDomains}</p>
        ) : (
          <div className="rounded-md border border-neutral-200">
            {options.length > 8 && (
              <div className="border-b border-neutral-100 p-1.5">
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t.library.editPaper.filterDomains} className={cx(input, "h-7")} />
              </div>
            )}
            <div className="max-h-48 overflow-y-auto p-1" role="group" aria-label={t.library.editPaper.domainsLabel}>
              {shown.map(({ domain, path }) => (
                <label key={domain.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[13px] hover:bg-neutral-50">
                  <input
                    type="checkbox"
                    checked={domainIds.includes(domain.id)}
                    onChange={() => toggle(domain.id)}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: domain.color }} />
                  <span className="min-w-0 truncate">
                    {path.length > 1 && <span className="text-neutral-400">{path.slice(0, -1).join(" / ")} / </span>}
                    <span className="text-neutral-800">{path[path.length - 1]}</span>
                  </span>
                </label>
              ))}
              {shown.length === 0 && <p className="px-2 py-2 text-xs text-neutral-400">{t.library.editPaper.noMatchingDomains}</p>}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <span className="flex-1 text-[11.5px] text-neutral-400">
          {t.library.editPaper.footer(paper.pageCount, new Date(paper.addedAt).toLocaleDateString(htmlLang()))}
        </span>
        <button type="button" className={btnGhost} onClick={onClose}>
          {t.common.cancel}
        </button>
        <button type="submit" className={btnPrimary} disabled={!!yearError || !!titleError || saving}>
          {t.common.save}
        </button>
      </div>
    </form>
  );
}

/** 表单里的标签相对打开时的增删（按 tagKey 比较，只改大小写不算改动） */
function diffTags(before: string[], after: string[]): { add: string[]; remove: string[] } {
  const was = new Set(before.map(tagKey));
  const now = new Set(after.map(tagKey));
  return { add: after.filter((t) => !was.has(tagKey(t))), remove: before.filter((t) => !now.has(tagKey(t))) };
}

// ---------- 删除确认 ----------

function ConfirmFooter(props: { onCancel: () => void; onConfirm: () => Promise<void>; confirmLabel: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-5 flex justify-end gap-2">
      <Dialog.Close asChild>
        <button type="button" className={btnGhost} onClick={props.onCancel}>
          {t.common.cancel}
        </button>
      </Dialog.Close>
      <button
        type="button"
        className={btnDanger}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await props.onConfirm();
          } finally {
            setBusy(false);
          }
        }}
      >
        {props.confirmLabel}
      </button>
    </div>
  );
}

function DeletePaperDialog({ paperId, onClose }: { paperId: string; onClose: () => void }) {
  const paper = useLiveQuery(() => getPaper(paperId).then((p) => p ?? null), [paperId]);
  const impact = useLiveQuery(() => getPaperDeleteImpact(paperId), [paperId]);
  useEffect(() => {
    if (paper === null) onClose();
  }, [paper, onClose]);
  if (!paper) return null;

  const confirm = async () => {
    // 先关闭阅读器里打开的标签
    const reader = useReaderStore.getState();
    for (const pane of reader.panes) if (pane.tabs.includes(paperId)) reader.closeTab(pane.id, paperId);
    await deletePaper(paperId);
    onClose();
  };

  return (
    <Shell
      title={t.library.deletePaper.title}
      onClose={onClose}
      description={
        <>
          <p className="mb-2 font-medium text-neutral-800">{t.common.quote(paper.title)}</p>
          <p>{t.library.deletePaper.body(impact ? impact.annotationCount : null)}</p>
        </>
      }
    >
      <ConfirmFooter onCancel={onClose} onConfirm={confirm} confirmLabel={t.library.deletePaper.confirm} />
    </Shell>
  );
}

function DeleteDomainDialog({ domainId, onClose }: { domainId: string; onClose: () => void }) {
  const impact = useLiveQuery(() => getDomainDeleteImpact(domainId), [domainId]);
  useEffect(() => {
    if (impact === null) onClose();
  }, [impact, onClose]);
  if (!impact) return null;

  const confirm = async () => {
    const deleted = await deleteDomain(domainId);
    const store = useLibraryStore.getState();
    if (store.selection.kind === "domain" && deleted.includes(store.selection.id)) store.select({ kind: "all" });
    onClose();
  };

  return (
    <Shell
      title={t.library.deleteDomain.title(impact.domain.name)}
      onClose={onClose}
      description={
        <ul className="list-disc space-y-1 pl-5">
          {impact.descendantCount > 0 && <li>{t.library.deleteDomain.descendants(impact.descendantCount)}</li>}
          <li>
            {t.library.deleteDomain.papers(impact.paperCount)}
            <span className="text-neutral-400">{t.library.deleteDomain.papersNote}</span>
          </li>
          {impact.termCount > 0 && (
            <li>
              {t.library.deleteDomain.terms(impact.termCount)}
              <span className="text-neutral-400">{t.library.deleteDomain.termsNote}</span>
            </li>
          )}
        </ul>
      }
    >
      <ConfirmFooter onCancel={onClose} onConfirm={confirm} confirmLabel={t.library.deleteDomain.confirm} />
    </Shell>
  );
}
