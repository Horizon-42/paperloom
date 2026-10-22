// 术语的增删改。签名是契约（术语表、批注模块都会调用），术语前台模块可以在此基础上扩展实现。
import { db } from "@/db/schema";
import { getTermDisplay, putTermDisplay, type TermDisplaySettings } from "@/db/repo/terms";
import { normalizeString } from "@/engine/normalize";
import { newId } from "@/lib/id";
import { scheduleIndex } from "@/services/indexer";
import type { Annotation, MatchMode, SelectionAnchor, Term, TermScope } from "@/types/models";

export type TermInput = Pick<Term, "name" | "aliases" | "matchMode" | "scope" | "note">;

/** 从选区创建术语时，出处批注的默认高亮色 */
export const TERM_SOURCE_COLOR = "#fde68a";

const MATCH_MODES: MatchMode[] = ["auto", "caseSensitive", "caseInsensitive"];

/** 名称、别名去掉首尾空白并压缩内部空白 */
export function cleanTermText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 规范化后是否为空（只有空白、零宽字符等），这样的形式永远匹配不到 */
export function isBlankForm(s: string): boolean {
  return !normalizeString(s).trim();
}

/** 别名：清理、去空（含规范化后为空的）、去重（区分大小写），去掉与名称完全相同的 */
export function cleanAliases(aliases: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (const a of aliases) {
    const c = cleanTermText(a);
    if (c && !isBlankForm(c) && c !== name && !out.includes(c)) out.push(c);
  }
  return out;
}

function cleanScope(scope: TermScope | undefined): TermScope {
  if (!scope || scope.kind !== "domains") return { kind: "global" };
  return { kind: "domains", domainIds: [...new Set(scope.domainIds ?? [])] };
}

/** 校验并规范化输入；名称为空时抛错 */
export function normalizeTermInput(input: TermInput): TermInput {
  const name = cleanTermText(input.name ?? "");
  if (!name || isBlankForm(name)) throw new Error("术语名称不能为空");
  return {
    name,
    aliases: cleanAliases(input.aliases ?? [], name),
    matchMode: MATCH_MODES.includes(input.matchMode) ? input.matchMode : "auto",
    scope: cleanScope(input.scope),
    note: input.note ?? "",
  };
}

/** 新建术语；带 source 时同时创建出处批注，并互相关联（Term.sourceAnnotationId / Annotation.termId） */
export async function createTerm(input: TermInput, source?: SelectionAnchor): Promise<Term> {
  const now = Date.now();
  const term: Term = { id: newId(), ...normalizeTermInput(input), createdAt: now, updatedAt: now };
  await db.transaction("rw", db.terms, db.annotations, async () => {
    if (source) {
      const ann: Annotation = {
        id: newId(),
        ...source,
        color: TERM_SOURCE_COLOR,
        note: "",
        termId: term.id,
        createdAt: now,
        updatedAt: now,
      };
      await db.annotations.add(ann);
      term.sourceAnnotationId = ann.id;
    }
    await db.terms.add(term);
  });
  scheduleIndex();
  return term;
}

export async function updateTerm(id: string, patch: Partial<TermInput>): Promise<void> {
  const changes: Partial<TermInput> = { ...patch };
  if (patch.name !== undefined || patch.aliases !== undefined) {
    const cur = await db.terms.get(id);
    if (!cur) return;
    const name = patch.name !== undefined ? cleanTermText(patch.name) : cur.name;
    if (!name || isBlankForm(name)) throw new Error("术语名称不能为空");
    if (patch.name !== undefined) changes.name = name;
    changes.aliases = cleanAliases(patch.aliases ?? cur.aliases, name);
  }
  if (patch.matchMode !== undefined && !MATCH_MODES.includes(patch.matchMode)) changes.matchMode = "auto";
  if (patch.scope !== undefined) changes.scope = cleanScope(patch.scope);
  await db.terms.update(id, { ...changes, updatedAt: Date.now() });
  // 只改笔记不影响匹配，不必重扫
  if (Object.keys(patch).some((k) => k !== "note")) scheduleIndex();
}

/** 删除术语及其派生数据；出处批注保留，只解除关联 */
export async function deleteTerm(id: string): Promise<void> {
  await db.transaction("rw", [db.terms, db.occurrences, db.annotations, db.links, db.boardNodes], async () => {
    await db.occurrences.where("termId").equals(id).delete();
    await db.annotations.where("termId").equals(id).modify((a) => {
      delete a.termId;
    });
    const links = [
      ...(await db.links.where("from.id").equals(id).toArray()),
      ...(await db.links.where("to.id").equals(id).toArray()),
    ].filter((l) => (l.from.kind === "term" && l.from.id === id) || (l.to.kind === "term" && l.to.id === id));
    await db.links.bulkDelete(links.map((l) => l.id));
    const nodes = await db.boardNodes.where("ref.id").equals(id).toArray();
    await db.boardNodes.bulkDelete(nodes.filter((n) => n.ref.kind === "term").map((n) => n.id));
    await db.terms.delete(id);
  });
}

// ---- 下划线显示设置（kv） ----

export async function setTermDisplaySettings(patch: Partial<TermDisplaySettings>): Promise<void> {
  await db.transaction("rw", db.kv, async () => {
    await putTermDisplay({ ...(await getTermDisplay()), ...patch });
  });
}
