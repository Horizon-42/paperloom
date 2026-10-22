// 术语弹窗里的"相关笔记"（开发文档 9.5）：读取 links 表中与该术语相连的连线，可新增、删除。
// 连线是全局的：删除后所有画布上的这条连线也一起消失，所以删除带"撤销"提示（按原 id 恢复）。
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useReaderStore } from "@/app/stores/reader";
import { useTermUiStore } from "@/app/stores/termUi";
import { openOnCanvas } from "@/components/canvas/navigation";
import {
  ENTITY_KIND_LABELS,
  RELATIONS,
  RELATION_LABELS,
  createLink,
  deleteLinks,
  listLinksFor,
  restoreLinks,
  otherEnd,
  refKey,
  resolveEntities,
  sameRef,
  searchEntities,
  type EntitySummary,
} from "@/services/linkService";
import type { EntityRef, LinkRelation } from "@/types/models";
import { IconPlus, IconX, btnGhost, btnPrimary, cx, iconBtn, input, linkBtn, sectionTitle } from "./ui";

/** 删除连线（全局），显示带撤销的提示 */
async function removeLink(id: string) {
  const toast = useAnnotationStore.getState().showToast;
  try {
    const snap = await deleteLinks([id]);
    if (!snap.length) return;
    toast("已删除连线（所有画布和「相关笔记」中都已移除）", {
      undo: async () => {
        if (!(await restoreLinks(snap))) toast("无法恢复：连线的另一端已被删除，或已有相同的连线");
      },
    });
  } catch (e) {
    console.error("删除连线失败", e);
    toast(`删除连线失败：${e instanceof Error ? e.message : String(e)}`, { kind: "error" });
  }
}

/** 打开连线另一端：批注跳到原文，论文打开，术语在弹窗里切换过去，自由笔记到画布上定位 */
export function openEntity(s: EntitySummary, onOpenTerm: (termId: string) => void) {
  if (s.missing) return;
  const { ref } = s;
  if (ref.kind === "term") onOpenTerm(ref.id);
  else if (ref.kind === "annotation" && s.paperId && s.page) {
    useTermUiStore.getState().closePopover();
    useReaderStore.getState().jumpTo({ paperId: s.paperId, page: s.page, pdfPoint: s.pdfPoint, annotationId: ref.id });
  } else if (ref.kind === "paper") {
    useTermUiStore.getState().closePopover();
    useReaderStore.getState().openPaper(ref.id);
  } else if (ref.kind === "note") {
    useTermUiStore.getState().closePopover();
    void openOnCanvas(ref);
  }
}

export function RelatedLinks({ self, editable, onOpenTerm }: { self: EntityRef; editable: boolean; onOpenTerm: (termId: string) => void }) {
  const rows = useLiveQuery(async () => {
    const links = await listLinksFor(self);
    const ends = links.map((l) => otherEnd(l, self));
    const resolved = await resolveEntities(ends);
    return links.map((link, i) => ({ link, other: resolved.get(refKey(ends[i]))!, outgoing: sameRef(link.from, self) }));
  }, [self.kind, self.id]);
  const [adding, setAdding] = useState(false);

  if (!rows) return null;
  if (!rows.length && !editable) return null;
  return (
    <section className="border-t border-neutral-100 px-3 py-2" data-term-related>
      <div className="flex items-center">
        <div className={cx(sectionTitle, "mb-0 flex-1")}>相关笔记</div>
        {editable && !adding && (
          <button type="button" className={cx(iconBtn, "h-5 w-5")} title="添加连线" aria-label="添加连线" onClick={() => setAdding(true)}>
            <IconPlus width={13} height={13} />
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {rows.map(({ link, other, outgoing }) => (
            <li key={link.id} className="group flex items-start gap-1.5" data-link-id={link.id}>
              <span
                className="mt-px shrink-0 rounded bg-violet-50 px-1 text-[11px] leading-[18px] text-violet-700"
                title={outgoing ? "本术语 → 对方" : "对方 → 本术语"}
              >
                {outgoing ? "→" : "←"} {link.relation === "custom" ? link.label || RELATION_LABELS.custom : RELATION_LABELS[link.relation]}
              </span>
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className={cx(linkBtn, "block max-w-full text-[13px]", other.missing && "pointer-events-none text-neutral-400 no-underline")}
                  onClick={() => openEntity(other, onOpenTerm)}
                  title={other.title}
                >
                  <span className="mr-1 text-[11px] text-neutral-400">{ENTITY_KIND_LABELS[other.ref.kind]}</span>
                  {other.title}
                </button>
                {(other.subtitle || other.excerpt || (link.relation !== "custom" && link.label)) && (
                  <div className="truncate text-[11px] text-neutral-400">
                    {[link.relation !== "custom" ? link.label : null, other.subtitle, other.excerpt].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              {editable && (
                <button
                  type="button"
                  className={cx(iconBtn, "h-5 w-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                  title="删除连线（所有画布中也会删除，可撤销）"
                  aria-label="删除连线"
                  onClick={() => void removeLink(link.id)}
                >
                  <IconX width={12} height={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!rows.length && !adding && <div className="text-[12px] text-neutral-400">还没有连线</div>}
      {adding && <AddLinkForm self={self} onDone={() => setAdding(false)} />}
    </section>
  );
}

function AddLinkForm({ self, onDone }: { self: EntityRef; onDone: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<EntitySummary[]>([]);
  const [target, setTarget] = useState<EntitySummary | null>(null);
  const [relation, setRelation] = useState<LinkRelation>("supports");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void searchEntities(q, { exclude: [self] }).then((r) => !cancelled && setResults(r));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, self.kind, self.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!target) return;
    if (relation === "custom" && !label.trim()) {
      setError("自定义关系需要填写文字");
      return;
    }
    try {
      await createLink({ from: self, to: target.ref, relation, label });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-neutral-50/60 p-2" data-link-form>
      {target ? (
        <div className="flex items-center gap-1 text-[12px]">
          <span className="text-neutral-400">{ENTITY_KIND_LABELS[target.ref.kind]}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-neutral-800">{target.title}</span>
          <button type="button" className={cx(iconBtn, "h-5 w-5")} aria-label="重新选择" onClick={() => setTarget(null)}>
            <IconX width={12} height={12} />
          </button>
        </div>
      ) : (
        <>
          <input
            className={cx(input, "h-7 text-[12px]")}
            placeholder="搜索术语、批注、论文或笔记…"
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (q) setQ("");
                else onDone();
              } else if (e.key === "Enter" && results[0]) setTarget(results[0]);
            }}
            data-link-search
          />
          {results.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded border border-neutral-200 bg-white py-0.5">
              {results.map((r) => (
                <li key={refKey(r.ref)}>
                  <button
                    type="button"
                    className="flex w-full items-baseline gap-1.5 px-2 py-1 text-left text-[12px] hover:bg-neutral-100"
                    onClick={() => setTarget(r)}
                    data-link-result={refKey(r.ref)}
                  >
                    <span className="shrink-0 text-[11px] text-neutral-400">{ENTITY_KIND_LABELS[r.ref.kind]}</span>
                    <span className="min-w-0 truncate text-neutral-800">{r.title}</span>
                    {r.subtitle && <span className="min-w-0 shrink truncate text-[11px] text-neutral-400">{r.subtitle}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {q.trim() && !results.length && <div className="px-1 text-[11px] text-neutral-400">没有匹配的条目</div>}
        </>
      )}
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="关系">
        {RELATIONS.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={relation === r}
            className={cx(
              "rounded border px-1.5 py-px text-[11px]",
              relation === r ? "border-violet-300 bg-violet-50 text-violet-700" : "border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50",
            )}
            onClick={() => setRelation(r)}
          >
            {RELATION_LABELS[r]}
          </button>
        ))}
      </div>
      <input
        className={cx(input, "h-7 text-[12px]")}
        placeholder={relation === "custom" ? "关系文字（必填）" : "备注（可选）"}
        value={label}
        onChange={(e) => {
          setLabel(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      {error && <div className="text-[11px] text-red-600">{error}</div>}
      <div className="flex justify-end gap-1">
        <button type="button" className={cx(btnGhost, "h-6 px-2 text-[12px]")} onClick={onDone}>
          取消
        </button>
        <button type="button" className={cx(btnPrimary, "h-6 px-2 text-[12px]")} disabled={!target} onClick={() => void submit()}>
          添加连线
        </button>
      </div>
    </div>
  );
}
