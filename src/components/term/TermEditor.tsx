// 术语编辑器（F3.1、F3.4）：由 termUi.editor 驱动的 Radix Dialog，新建或编辑术语。
// 实时预览表面形式；与已有术语共享表面形式且作用范围重叠时给出冲突提示（仍可保存）。
// 从选区创建时：名称预填选中文字；像缩写时建议移到别名；识别 "Long Short-Term Memory (LSTM)" 式定义。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useLiveQuery } from "dexie-react-hooks";
import { useTermUiStore, type TermEditorRequest } from "@/app/stores/termUi";
import { MarkdownEditor } from "@/components/common/MarkdownEditor";
import { db } from "@/db/schema";
import { getTerm, listTerms } from "@/db/repo/terms";
import { surfaceForms } from "@/engine/matcher";
import type { TermLike } from "@/engine/types";
import { buildDomainTree, flattenTree } from "@/services/domainTree";
import { cleanAliases, cleanTermText, createTerm, deleteTerm, updateTerm } from "@/services/termService";
import type { MatchMode, Term, TermScope } from "@/types/models";
import { buildFormIndex, findConflicts, paperDomainClosures } from "./logic/conflicts";
import { weakForms } from "./logic/forms";
import { looksLikeAbbreviation, suggestFromSelection, type DefinitionSuggestion } from "./logic/definition";
import { getPageEntry } from "./pages";
import { useTermRuntime } from "./runtime";
import { IconX, btnDanger, btnGhost, btnOutline, btnPrimary, chip, cx, dialogOverlay, dialogTitle, input } from "./ui";
import { EntityDeleteImpact } from "@/components/canvas/DeleteImpact";

export function TermEditorDialog() {
  const req = useTermUiStore((s) => s.editor);
  const close = useTermUiStore((s) => s.closeTermEditor);
  if (!req) return null;
  return <EditorLoader key={req.termId ?? `new:${req.initialName ?? ""}:${req.source?.quote.exact ?? ""}`} req={req} onClose={close} />;
}

function EditorLoader({ req, onClose }: { req: TermEditorRequest; onClose: () => void }) {
  const term = useLiveQuery(() => (req.termId ? getTerm(req.termId).then((t) => t ?? null) : Promise.resolve(null)), [req.termId]);
  // 编辑中的术语在别处被删除
  useEffect(() => {
    if (req.termId && term === null) onClose();
  }, [req.termId, term, onClose]);
  if (req.termId && !term) return null;
  return <EditorDialog req={req} term={term ?? null} onClose={onClose} />;
}

const MODES: { value: MatchMode; label: string; hint: string }[] = [
  { value: "auto", label: "自动", hint: "全大写的形式（如 ATM、LSTM）区分大小写，其余不区分。可避免把普通单词 atm 当成缩写" },
  { value: "caseSensitive", label: "区分大小写", hint: "所有形式都必须大小写完全一致" },
  { value: "caseInsensitive", label: "不区分大小写", hint: "所有形式都忽略大小写" },
];

/** 选区前后更长的上下文：选区所在页已渲染时从页面全文里取，否则只有 quote 的前后 32 字 */
function selectionContext(req: TermEditorRequest): { before: string; after: string; pageText: string } {
  const src = req.source;
  if (!src) return { before: "", after: "", pageText: "" };
  const { prefix, exact, suffix } = src.quote;
  const entry = getPageEntry("left", src.paperId, src.page) ?? getPageEntry("right", src.paperId, src.page);
  const text = entry?.ctx.text?.normalized.text ?? "";
  const at = text ? text.indexOf(prefix + exact + suffix) : -1;
  if (at < 0) return { before: prefix, after: suffix, pageText: text };
  const s = at + prefix.length;
  return { before: text.slice(Math.max(0, s - 200), s), after: text.slice(s + exact.length, s + exact.length + 200), pageText: text };
}

function EditorDialog({ req, term, onClose }: { req: TermEditorRequest; term: Term | null; onClose: () => void }) {
  const initialName = cleanTermText(term?.name ?? req.initialName ?? req.source?.quote.exact ?? "");
  const [name, setName] = useState(initialName);
  const [aliases, setAliases] = useState<string[]>(term?.aliases ?? []);
  const [aliasDraft, setAliasDraft] = useState("");
  const [matchMode, setMatchMode] = useState<MatchMode>(term?.matchMode ?? "auto");
  const [scope, setScope] = useState<TermScope>(term?.scope ?? { kind: "global" });
  const [note, setNote] = useState(term?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const nameRef = useRef<HTMLInputElement>(null);

  const rt = useTermRuntime();
  const allTerms = useLiveQuery(listTerms, []);
  const domains = useLiveQuery(() => db.domains.toArray(), []);
  const tree = useMemo(() => flattenTree(buildDomainTree(domains ?? [])), [domains]);
  const domainParent = useMemo(() => new Map((domains ?? []).map((d) => [d.id, d.parentId])), [domains]);
  // 论文所属领域：领域互不相干但有论文同时属于两边时也算冲突
  const paperDomains = useLiveQuery(async () => (await db.papers.toArray()).map((p) => p.domainIds), []);

  // ---- 表面形式、冲突 ----
  const pendingAlias = cleanTermText(aliasDraft);
  const effAliases = useMemo(
    () => cleanAliases(pendingAlias ? [...aliases, pendingAlias] : aliases, cleanTermText(name)),
    [aliases, pendingAlias, name],
  );
  const draft: TermLike = useMemo(
    () => ({ id: term?.id ?? "\u0000draft", name: cleanTermText(name), aliases: effAliases, matchMode, scope }),
    [term?.id, name, effAliases, matchMode, scope],
  );
  const forms = useMemo(() => surfaceForms(draft), [draft]);
  const index = useMemo(() => buildFormIndex(allTerms ?? []), [allTerms]);
  const termsById = useMemo(() => new Map((allTerms ?? []).map((t) => [t.id, t])), [allTerms]);
  const parentMap = domainParent.size ? domainParent : rt.domainParent;
  const closures = useMemo(() => paperDomainClosures(paperDomains ?? [], parentMap), [paperDomains, parentMap]);
  const conflicts = useMemo(
    () => (draft.name ? findConflicts(draft, index, termsById, parentMap, closures) : []),
    [draft, index, termsById, parentMap, closures],
  );
  const weak = useMemo(() => weakForms(forms), [forms]);

  // ---- 从选区创建时的建议（只在打开时算一次） ----
  const [ctxInfo] = useState(() => selectionContext(req));
  const definition = useMemo<DefinitionSuggestion | null>(
    () => (term || !req.source ? null : suggestFromSelection(initialName, ctxInfo.before, ctxInfo.after, ctxInfo.pageText)),
    [term, req.source, initialName, ctxInfo],
  );
  const nameNow = cleanTermText(name);
  const showDefinition =
    !!definition && !dismissed.has("def") && !(nameNow === definition.name && definition.aliases.every((a) => effAliases.includes(a)));
  const showAbbrev = !term && !showDefinition && !dismissed.has("abbr") && looksLikeAbbreviation(nameNow) && !effAliases.includes(nameNow);

  const addAlias = (raw: string) => {
    const parts = raw.split(/[,，;；]/).map(cleanTermText).filter(Boolean);
    if (!parts.length) return;
    setAliases((xs) => cleanAliases([...xs, ...parts], cleanTermText(name)));
    setAliasDraft("");
  };
  const onAliasKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === "," || e.key === "，") && !e.nativeEvent.isComposing) {
      if (!aliasDraft.trim()) return;
      e.preventDefault();
      addAlias(aliasDraft);
    } else if (e.key === "Backspace" && !aliasDraft && aliases.length) {
      setAliases((xs) => xs.slice(0, -1));
    }
  };

  const toggleDomain = (id: string) => {
    setScope((s) => {
      const ids = s.kind === "domains" ? s.domainIds : [];
      return { kind: "domains", domainIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] };
    });
  };

  const save = async () => {
    if (saving) return;
    const clean = cleanTermText(name);
    if (!clean) {
      setError("请填写术语名称");
      nameRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input = { name: clean, aliases: effAliases, matchMode, scope, note };
      if (term) await updateTerm(term.id, input);
      else await createTerm(input, req.source);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!term) return;
    setSaving(true);
    try {
      await deleteTerm(term.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const selectedIds = scope.kind === "domains" ? scope.domainIds : [];
  const knownIds = new Set((domains ?? []).map((d) => d.id));
  const missingIds = selectedIds.filter((id) => domains && !knownIds.has(id));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(88vh,760px)] w-[min(94vw,560px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-neutral-200 bg-white text-sm shadow-xl focus:outline-none"
          data-term-editor={term ? "edit" : "new"}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nameRef.current?.focus();
            nameRef.current?.select();
          }}
          onKeyDown={(e) => {
            // 名称、别名等输入框里的 ⌘/Ctrl+Enter；笔记编辑器自己用 onSubmit 处理（已 preventDefault）
            if (e.defaultPrevented || e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex items-start gap-3 px-5 pt-5 pb-3">
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>{term ? "编辑术语" : "新建术语"}</Dialog.Title>
            <Dialog.Close className="-mt-0.5 -mr-1 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label="关闭">
              <IconX width={16} height={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">填写术语名称、别名、匹配方式、作用范围和笔记</Dialog.Description>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4">
            {showDefinition && definition && (
              <Suggestion
                onDismiss={() => setDismissed((s) => new Set(s).add("def"))}
                action="采用"
                onAction={() => {
                  setName(definition.name);
                  setAliases((xs) => cleanAliases([...xs, ...definition.aliases], definition.name));
                }}
                data="definition"
              >
                {definition.reason}：名称「{definition.name}」，别名「{definition.aliases.join("、")}」
              </Suggestion>
            )}
            {showAbbrev && (
              <Suggestion
                onDismiss={() => setDismissed((s) => new Set(s).add("abbr"))}
                action="移到别名"
                onAction={() => {
                  setAliases((xs) => [nameNow, ...xs.filter((x) => x !== nameNow)]);
                  setName("");
                  setTimeout(() => nameRef.current?.focus());
                }}
                data="abbreviation"
              >
                「{nameNow}」看起来是缩写。可以把它移到别名，名称填写全称。
              </Suggestion>
            )}

            <Field label="名称" htmlFor="term-name">
              <input
                id="term-name"
                ref={nameRef}
                className={input}
                value={name}
                placeholder="规范名，如 Long Short-Term Memory"
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                data-term-field="name"
              />
            </Field>

            <Field label="别名" hint="回车或逗号添加；缩写、全称、其他写法">
              <div
                className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-neutral-200 bg-white px-1.5 py-1 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100"
                onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
              >
                {aliases.map((a) => (
                  <span key={a} className={cx(chip, "bg-blue-50 text-blue-800")} data-alias={a}>
                    {a}
                    <button
                      type="button"
                      className="-mr-0.5 rounded text-blue-400 hover:text-blue-700"
                      aria-label={`删除别名 ${a}`}
                      onClick={() => setAliases((xs) => xs.filter((x) => x !== a))}
                    >
                      <IconX width={11} height={11} />
                    </button>
                  </span>
                ))}
                <input
                  className="h-6 min-w-[8em] flex-1 border-0 bg-transparent px-1 text-[13px] outline-none placeholder:text-neutral-400"
                  value={aliasDraft}
                  placeholder={aliases.length ? "" : "LSTM, LSTMs"}
                  onChange={(e) => setAliasDraft(e.target.value)}
                  onKeyDown={onAliasKey}
                  onBlur={() => aliasDraft.trim() && addAlias(aliasDraft)}
                  aria-label="添加别名"
                  data-term-field="alias"
                />
              </div>
            </Field>

            <Field label="匹配方式">
              <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="匹配方式">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={matchMode === m.value}
                    className={cx(
                      "rounded-md border px-2.5 py-1 text-[12px]",
                      matchMode === m.value ? "border-blue-300 bg-blue-50 text-blue-800" : "border-neutral-200 text-neutral-600 hover:bg-neutral-50",
                    )}
                    onClick={() => setMatchMode(m.value)}
                    data-match-mode={m.value}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[12px] text-neutral-500">{MODES.find((m) => m.value === matchMode)!.hint}</p>
            </Field>

            <div className="rounded-md bg-neutral-50 px-3 py-2" data-term-forms>
              <div className="mb-1 text-[11px] text-neutral-400">将匹配以下形式（含自动派生的复数和连字符写法）</div>
              {forms.length ? (
                <div className="flex flex-wrap gap-1">
                  {forms.map((f) => (
                    <span
                      key={`${f.caseSensitive}:${f.form}`}
                      className={cx(chip, "bg-white ring-1 ring-neutral-200")}
                      title={f.caseSensitive ? "区分大小写" : "不区分大小写"}
                      data-form={f.form}
                    >
                      {f.form}
                      {f.caseSensitive && <span className="text-[10px] text-amber-600">Aa</span>}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-neutral-400">填写名称后显示</div>
              )}
            </div>

            {weak.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800" role="status" data-term-weak-forms>
                {weak.some((w) => w.reason === "noAlnum") && (
                  <div>
                    {weak
                      .filter((w) => w.reason === "noAlnum")
                      .map((w) => `“${w.form}”`)
                      .join("、")}{" "}
                    不含字母或数字，会命中大量符号。
                  </div>
                )}
                {weak.some((w) => w.reason === "short") && (
                  <div>
                    {weak
                      .filter((w) => w.reason === "short")
                      .map((w) => `“${w.form}”`)
                      .join("、")}{" "}
                    只有一个字母或数字，可能命中大量无关文字（如冠词 a）。
                  </div>
                )}
                <div className="mt-0.5 text-amber-700/80">仍可保存；建议删掉这些别名，或改用更长的写法。</div>
              </div>
            )}

            {conflicts.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800" role="status" data-term-conflicts>
                <div className="font-medium">与已有术语冲突（仍可保存）</div>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {conflicts.map((c) => {
                    const other = termsById.get(c.termId);
                    return (
                      <li key={c.termId} data-conflict={c.termId} data-conflict-via={c.via}>
                        「{other?.name}」也匹配 {c.forms.map((f) => `“${f}”`).join("、")}，
                        {c.via === "paper" ? `限定的领域不同，但有 ${c.sharedPapers ?? 0} 篇论文同时属于两边的领域` : "且作用范围重叠"}
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-1 text-amber-700/80">在两者都生效的论文里，点击下划线会列出全部候选。可以给其中一个限定领域来区分。</div>
              </div>
            )}

            <Field label="作用范围">
              <div className="flex gap-1" role="radiogroup" aria-label="作用范围">
                {(["global", "domains"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={scope.kind === k}
                    className={cx(
                      "rounded-md border px-2.5 py-1 text-[12px]",
                      scope.kind === k ? "border-blue-300 bg-blue-50 text-blue-800" : "border-neutral-200 text-neutral-600 hover:bg-neutral-50",
                    )}
                    onClick={() => setScope(k === "global" ? { kind: "global" } : { kind: "domains", domainIds: selectedIds })}
                    data-scope-kind={k}
                  >
                    {k === "global" ? "全局" : "仅限指定领域"}
                  </button>
                ))}
              </div>
              {scope.kind === "domains" && (
                <div className="mt-1.5">
                  {tree.length ? (
                    <ul className="max-h-44 overflow-y-auto rounded-md border border-neutral-200 py-1" data-scope-tree>
                      {tree.map((n) => (
                        <li key={n.domain.id}>
                          <label
                            className="flex cursor-pointer items-center gap-2 py-0.5 pr-2 text-[13px] hover:bg-neutral-50"
                            style={{ paddingLeft: 8 + n.depth * 16 }}
                          >
                            <input
                              type="checkbox"
                              className="accent-blue-600"
                              checked={selectedIds.includes(n.domain.id)}
                              onChange={() => toggleDomain(n.domain.id)}
                              data-scope-domain={n.domain.id}
                            />
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: n.domain.color || "#a3a3a3" }} />
                            <span className="truncate">{n.domain.name}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-[12px] text-neutral-400">还没有领域，请先在左侧建立领域</div>
                  )}
                  <p className="mt-1 text-[12px] text-neutral-500">
                    {selectedIds.length
                      ? "只在属于这些领域（含子领域）的论文中标注。"
                      : "未选择领域时，这个术语不会在任何论文中标注。"}
                    {missingIds.length > 0 && ` 另有 ${missingIds.length} 个已删除的领域。`}
                  </p>
                </div>
              )}
            </Field>

            <Field label="笔记">
              <MarkdownEditor value={note} onChange={setNote} onSubmit={() => void save()} placeholder="Markdown，支持 $公式$" />
            </Field>

            {error && (
              <div className="text-[12px] text-red-600" role="alert">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-neutral-100 px-5 py-3">
            {term &&
              (confirmDelete ? (
                <div className="flex min-w-0 flex-1 items-center gap-2" data-term-delete-confirm>
                  <span className="min-w-0 flex-1 text-[12px] leading-snug text-red-700">
                    删除「{term.name}」？出处批注会保留；<EntityDeleteImpact entity={{ kind: "term", id: term.id }} />
                  </span>
                  <button type="button" className={btnDanger} disabled={saving} onClick={() => void remove()}>
                    确认删除
                  </button>
                  <button type="button" className={btnGhost} onClick={() => setConfirmDelete(false)}>
                    取消
                  </button>
                </div>
              ) : (
                <button type="button" className={cx(btnGhost, "text-red-600 hover:bg-red-50")} onClick={() => setConfirmDelete(true)}>
                  删除术语
                </button>
              ))}
            {!confirmDelete && (
              <>
                <span className="flex-1 text-[11px] text-neutral-400">⌘/Ctrl + Enter 保存</span>
                <Dialog.Close className={btnOutline}>取消</Dialog.Close>
                <button type="button" className={btnPrimary} disabled={saving} onClick={() => void save()} data-term-save>
                  {term ? "保存" : req.source ? "创建并标注出处" : "创建"}
                </button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <label htmlFor={htmlFor} className="text-[12px] font-medium text-neutral-700">
          {label}
        </label>
        {hint && <span className="text-[11px] text-neutral-400">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Suggestion({
  children,
  action,
  onAction,
  onDismiss,
  data,
}: {
  children: ReactNode;
  action: string;
  onAction: () => void;
  onDismiss: () => void;
  data: string;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-[12px] text-blue-900" data-term-suggestion={data}>
      <span className="min-w-0 flex-1 leading-relaxed">{children}</span>
      <button type="button" className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-[12px] font-medium text-white hover:bg-blue-700" onClick={onAction}>
        {action}
      </button>
      <button type="button" className="shrink-0 rounded p-0.5 text-blue-400 hover:text-blue-700" aria-label="忽略建议" onClick={onDismiss}>
        <IconX width={12} height={12} />
      </button>
    </div>
  );
}
