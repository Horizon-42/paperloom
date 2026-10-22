// 术语表右栏：术语详情、笔记、出现在哪些论文（按领域分组，点击跳到第一次出现的页）
import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useLiveQuery } from "dexie-react-hooks";
import { useGlossaryStore } from "@/app/stores/glossary";
import { useIndexerStore } from "@/app/stores/indexer";
import { useTermUiStore } from "@/app/stores/termUi";
import { MarkdownView } from "@/components/common/MarkdownView";
import { btnDanger, btnGhost, btnOutline, cx, dialogContent, dialogOverlay, dialogTitle } from "@/components/library/ui";
import { openPaperAtTerm } from "@/components/term/interaction";
import { getOutdatedPaperIds, listOccurrencesForTerm } from "@/db/repo/occurrences";
import { listPapers } from "@/db/repo/papers";
import { MATCH_VERSION } from "@/engine/types";
import { htmlLang, t } from "@/i18n";
import { Trans } from "@/i18n/Trans";
import { deleteTerm } from "@/services/termService";
import type { Domain, Paper, Term } from "@/types/models";
import { formatPages, groupOccurrencesByDomain, scopeSummary } from "./model";
import { EntityDeleteImpact } from "@/components/canvas/DeleteImpact";

interface Props {
  term: Term | undefined;
  domains: Domain[];
  domainById: ReadonlyMap<string, Domain>;
}

export function TermDetail({ term, domains, domainById }: Props) {
  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-neutral-200 bg-white" aria-label={t.term.glossary.detail.ariaLabel}>
      {term ? (
        <TermDetailBody key={term.id} term={term} domains={domains} domainById={domainById} />
      ) : (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-neutral-400">{t.term.glossary.detail.placeholder}</div>
      )}
    </aside>
  );
}

function TermDetailBody({ term, domains, domainById }: { term: Term; domains: Domain[]; domainById: ReadonlyMap<string, Domain> }) {
  const [confirming, setConfirming] = useState(false);
  const scope = scopeSummary(term, domainById);
  const tx = t.term.glossary.detail;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="sticky top-0 z-[1] border-b border-neutral-100 bg-white/95 px-5 pb-3 pt-4 backdrop-blur">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 break-words text-[17px] font-semibold leading-snug text-neutral-900" data-testid="term-detail-name">
            {term.name}
          </h2>
          <button type="button" className={cx(btnOutline, "h-7 px-2.5")} onClick={() => useTermUiStore.getState().openTermEditor({ termId: term.id })}>
            {t.common.edit}
          </button>
          <button type="button" className={cx(btnGhost, "h-7 px-2.5 text-red-600 hover:bg-red-50")} onClick={() => setConfirming(true)}>
            {t.common.delete}
          </button>
        </div>
        {term.aliases.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1" aria-label={tx.aliases}>
            {term.aliases.map((a) => (
              <span key={a} className="rounded bg-neutral-100 px-1.5 py-0.5 text-[12px] text-neutral-700">
                {a}
              </span>
            ))}
          </div>
        )}
      </header>

      <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-2 px-5 py-3 text-[12.5px]">
        <dt className="text-neutral-400">{tx.matchMode}</dt>
        <dd className="text-neutral-700">{t.term.matchModes[term.matchMode].detail}</dd>
        <dt className="text-neutral-400">{tx.scope}</dt>
        <dd className="text-neutral-700" data-testid="term-detail-scope">
          {scope.kind === "global" && tx.scopeGlobal}
          {scope.kind === "none" && <span className="text-amber-700">{tx.scopeNone}</span>}
          {scope.kind === "domains" && (
            <div className="flex flex-wrap gap-1">
              {scope.tags.map((tag) => (
                <span key={tag.id} className="inline-flex items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 text-[12px]">
                  <span className="h-2 w-2 rounded-full" style={{ background: tag.color }} aria-hidden />
                  {tag.path}
                </span>
              ))}
            </div>
          )}
        </dd>
        <dt className="text-neutral-400">{tx.updated}</dt>
        <dd className="tabular-nums text-neutral-700">{new Date(term.updatedAt).toLocaleString(htmlLang())}</dd>
      </dl>

      <section className="border-t border-neutral-100 px-5 py-3" aria-label={tx.note}>
        <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-neutral-400">{tx.note}</h3>
        <MarkdownView source={term.note} emptyText={t.term.noNote} className="text-[13.5px]" />
      </section>

      <OccurrenceSection term={term} domains={domains} />

      <DeleteDialog term={term} open={confirming} onOpenChange={setConfirming} />
    </div>
  );
}

/** 术语的出现记录，以及其中结果来自旧版规则的论文（扫描戳过期） */
async function loadTermOccurrences(termId: string) {
  const occs = await listOccurrencesForTerm(termId);
  const outdated = await getOutdatedPaperIds(occs.map((o) => o.paperId));
  return { occs, outdated };
}

function OccurrenceSection({ term, domains }: { term: Term; domains: Domain[] }) {
  const data = useLiveQuery(() => loadTermOccurrences(term.id), [term.id]);
  const papers = useLiveQuery(listPapers, []);
  const indexing = useIndexerStore((s) => s.running);
  const paperById = useMemo(() => new Map<string, Paper>((papers ?? []).map((p) => [p.id, p])), [papers]);
  // 规则版本变化后，旧结果在新结果写入前照常显示，标为"待更新"
  const grouped = useMemo(
    () =>
      groupOccurrencesByDomain(data?.occs ?? [], paperById, domains, (o) => o.engineVersion !== MATCH_VERSION || !!data?.outdated.has(o.paperId)),
    [data, paperById, domains],
  );
  const loaded = data !== undefined && papers !== undefined;
  const tx = t.term.glossary.detail;

  return (
    <section className="border-t border-neutral-100 px-5 pb-6 pt-3" aria-label={tx.occurrences} data-testid="term-occurrences">
      <h3 className="mb-2 flex items-baseline gap-2 text-[11px] font-medium tracking-wide text-neutral-400">
        {tx.appearsIn}
        {loaded && (
          <span className="font-normal normal-case tracking-normal text-neutral-500" data-testid="term-occurrence-summary">
            {tx.summary(grouped.paperCount, grouped.total)}
          </span>
        )}
        {(indexing || grouped.updating > 0) && (
          <span
            className="ml-auto font-normal tracking-normal text-blue-500"
            data-testid="term-occurrence-updating"
            title={grouped.updating > 0 ? tx.updatingTitle(grouped.updating) : undefined}
          >
            {grouped.updating > 0 ? tx.updatingCount(grouped.updating) : tx.indexing}
          </span>
        )}
      </h3>
      {loaded && grouped.paperCount === 0 && (
        <p className="text-[12.5px] leading-relaxed text-neutral-400">
          {term.scope.kind === "domains" ? tx.noneInDomains : tx.noneInLibrary}
        </p>
      )}
      <div className="space-y-3">
        {grouped.groups.map((g) => (
          <div key={g.key || "unfiled"} role="group" aria-label={g.label}>
            <div className="mb-0.5 flex items-center gap-1.5 text-[12px] font-medium text-neutral-600">
              {g.color ? <span className="h-2 w-2 rounded-full" style={{ background: g.color }} aria-hidden /> : <span className="h-2 w-2 rounded-full border border-neutral-300" aria-hidden />}
              <span className="truncate">{g.label}</span>
              <span className="ml-auto font-normal tabular-nums text-neutral-400">{tx.times(g.count)}</span>
            </div>
            <ul>
              {g.papers.map(({ paper, pages, count, updating }) => (
                <li key={paper.id}>
                  <button
                    type="button"
                    data-paper-id={paper.id}
                    title={tx.jumpToFirst(pages[0])}
                    onClick={() => openPaperAtTerm(paper.id, pages[0] ?? 1, term.id)}
                    className="group flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-neutral-100"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] leading-snug text-neutral-800 group-hover:text-blue-700">{paper.title}</span>
                      <span className="block truncate text-[11.5px] text-neutral-400">
                        {tx.pages(formatPages(pages))}
                        {updating && <span className="ml-1.5 text-blue-500" data-testid="occurrence-updating">{tx.outdated}</span>}
                      </span>
                    </span>
                    <span className={cx("shrink-0 text-[12px] tabular-nums", updating ? "text-neutral-400" : "text-neutral-500")}>{tx.times(count)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function DeleteDialog({ term, open, onOpenChange }: { term: Term; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await deleteTerm(term.id);
      const s = useGlossaryStore.getState();
      if (s.selectedTermId === term.id) s.select(null);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  const tx = t.term.glossary.detail;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={dialogContent}>
          <Dialog.Title className={dialogTitle}>{tx.deleteTitle(term.name)}</Dialog.Title>
          <Dialog.Description className="mt-2 text-[13px] leading-relaxed text-neutral-600">
            <Trans text={tx.deleteBody} values={{ impact: <EntityDeleteImpact entity={{ kind: "term", id: term.id }} /> }} />
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className={btnOutline}>
                {t.common.cancel}
              </button>
            </Dialog.Close>
            <button type="button" className={btnDanger} disabled={busy} onClick={() => void confirm()}>
              {tx.deleteConfirm}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
