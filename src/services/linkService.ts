// 实体之间的连线（开发文档 9.3、9.5）：术语弹窗的"相关笔记"读写这里。
// 连线全局有效、与画布无关；这里只做增删查，以及把 EntityRef 解析成可显示的标题和摘要。
import { db } from "@/db/schema";
import { newId } from "@/lib/id";
import type { EntityKind, EntityRef, Link, LinkRelation } from "@/types/models";

export const RELATIONS: LinkRelation[] = ["supports", "contradicts", "extends", "compares", "partOf", "custom"];

export const RELATION_LABELS: Record<LinkRelation, string> = {
  supports: "支持",
  contradicts: "反驳",
  extends: "扩展",
  compares: "对比",
  partOf: "属于",
  custom: "自定义",
};

export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  annotation: "批注",
  term: "术语",
  paper: "论文",
  note: "笔记",
};

export const refKey = (r: EntityRef) => `${r.kind}:${r.id}`;
export const sameRef = (a: EntityRef, b: EntityRef) => a.kind === b.kind && a.id === b.id;

export interface LinkInput {
  from: EntityRef;
  to: EntityRef;
  relation: LinkRelation;
  label?: string;
}

const cleanRelation = (r: LinkRelation): LinkRelation => (RELATIONS.includes(r) ? r : "custom");
const cleanLabel = (l: string | undefined) => l?.trim() || undefined;

/** 两条连线是否完全相同（同方向、同关系、同文字） */
function sameLink(l: Pick<Link, "from" | "to" | "relation" | "label">, from: EntityRef, to: EntityRef, relation: LinkRelation, label: string | undefined) {
  return sameRef(l.from, from) && sameRef(l.to, to) && l.relation === relation && (l.label ?? undefined) === label;
}

async function findSameLink(from: EntityRef, to: EntityRef, relation: LinkRelation, label: string | undefined, exceptId?: string) {
  return (await db.links.where("from.id").equals(from.id).toArray()).find((l) => l.id !== exceptId && sameLink(l, from, to, relation, label));
}

/** 新建连线。不允许连到自己；完全相同的连线已存在时不重复创建，返回已有的那条（existed = true） */
export async function addLink(input: LinkInput): Promise<{ link: Link; existed: boolean }> {
  const { from, to } = input;
  if (sameRef(from, to)) throw new Error("不能连到自身");
  const relation = cleanRelation(input.relation);
  const label = cleanLabel(input.label);
  return db.transaction("rw", db.links, async () => {
    const existing = await findSameLink(from, to, relation, label);
    if (existing) return { link: existing, existed: true };
    const link: Link = { id: newId(), from: { ...from }, to: { ...to }, relation, createdAt: Date.now() };
    if (label) link.label = label;
    await db.links.add(link);
    return { link, existed: false };
  });
}

/** 同 addLink，只返回连线 */
export async function createLink(input: LinkInput): Promise<Link> {
  return (await addLink(input)).link;
}

/** 删除连线，返回被删除的记录（供撤销） */
export async function deleteLinks(ids: readonly string[]): Promise<Link[]> {
  if (!ids.length) return [];
  return db.transaction("rw", db.links, async () => {
    const links = (await db.links.bulkGet([...ids])).filter((l): l is Link => !!l);
    await db.links.bulkDelete(links.map((l) => l.id));
    return links;
  });
}

export async function deleteLink(id: string): Promise<void> {
  await deleteLinks([id]);
}

async function entityExists(r: EntityRef): Promise<boolean> {
  if (r.kind === "annotation") return !!(await db.annotations.get(r.id));
  if (r.kind === "term") return !!(await db.terms.get(r.id));
  if (r.kind === "paper") return !!(await db.papers.get(r.id));
  return !!(await db.notes.get(r.id));
}

/**
 * 撤销删除：按原 id 写回。两端有一端已不存在、或此间又建了完全相同的连线时跳过。返回恢复的条数
 */
export async function restoreLinks(snapshot: readonly Link[]): Promise<number> {
  const tables = [db.links, db.annotations, db.terms, db.papers, db.notes];
  return db.transaction("rw", tables, async () => {
    const keep: Link[] = [];
    for (const l of snapshot) {
      if (!(await entityExists(l.from)) || !(await entityExists(l.to))) continue;
      if (await findSameLink(l.from, l.to, l.relation, cleanLabel(l.label), l.id)) continue;
      keep.push(l);
    }
    if (keep.length) await db.links.bulkPut(keep);
    return keep.length;
  });
}

/**
 * 修改连线的关系类型、文字，可选调换方向；文字为空时去掉 label 字段。
 * 改完后与另一条连线完全相同时合并（删除这条），返回保留下来的连线 id。
 */
export async function updateLink(id: string, patch: { relation: LinkRelation; label?: string; reverse?: boolean }): Promise<{ id: string; merged: boolean } | null> {
  const relation = cleanRelation(patch.relation);
  const label = cleanLabel(patch.label);
  return db.transaction("rw", db.links, async () => {
    const cur = await db.links.get(id);
    if (!cur) return null;
    const from = patch.reverse ? cur.to : cur.from;
    const to = patch.reverse ? cur.from : cur.to;
    const dup = await findSameLink(from, to, relation, label, id);
    if (dup) {
      await db.links.delete(id);
      return { id: dup.id, merged: true };
    }
    await db.links.update(id, { from, to, relation, label });
    return { id, merged: false };
  });
}

/** 与实体相连的全部连线（两个方向），按创建时间排序 */
export async function listLinksFor(ref: EntityRef): Promise<Link[]> {
  const [out, inc] = await Promise.all([
    db.links.where("from.id").equals(ref.id).toArray(),
    db.links.where("to.id").equals(ref.id).toArray(),
  ]);
  const seen = new Set<string>();
  return [...out, ...inc]
    .filter((l) => (sameRef(l.from, ref) || sameRef(l.to, ref)) && !seen.has(l.id) && (seen.add(l.id), true))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 连线另一端 */
export function otherEnd(link: Link, self: EntityRef): EntityRef {
  return sameRef(link.from, self) ? link.to : link.from;
}

export interface EntitySummary {
  ref: EntityRef;
  title: string;
  /** 第二行：所在论文、别名等 */
  subtitle?: string;
  /** 摘要：批注原文 / 笔记开头 */
  excerpt?: string;
  /** 批注所在位置，用于跳转 */
  paperId?: string;
  page?: number;
  pdfPoint?: [number, number];
  /** 实体已被删除 */
  missing?: boolean;
}

const clip = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 把一组 EntityRef 解析成可显示的摘要，按 refKey 索引 */
export async function resolveEntities(refs: readonly EntityRef[]): Promise<Map<string, EntitySummary>> {
  const ids = (kind: EntityKind) => [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
  const [anns, terms, papers, notes] = await Promise.all([
    db.annotations.bulkGet(ids("annotation")),
    db.terms.bulkGet(ids("term")),
    db.papers.bulkGet(ids("paper")),
    db.notes.bulkGet(ids("note")),
  ]);
  const annPapers = await db.papers.bulkGet([...new Set(anns.filter((a) => !!a).map((a) => a!.paperId))]);
  const paperTitle = new Map(annPapers.filter((p) => !!p).map((p) => [p!.id, p!.title]));
  const out = new Map<string, EntitySummary>();
  for (const a of anns) {
    if (!a) continue;
    const r = a.rects[0];
    out.set(refKey({ kind: "annotation", id: a.id }), {
      ref: { kind: "annotation", id: a.id },
      title: clip(a.quote.exact || "（无原文）", 60),
      subtitle: `${paperTitle.get(a.paperId) ?? "未知论文"} · 第 ${a.page} 页`,
      excerpt: a.note ? clip(a.note) : undefined,
      paperId: a.paperId,
      page: a.page,
      pdfPoint: r ? [r[0], r[3]] : undefined,
    });
  }
  for (const t of terms) {
    if (!t) continue;
    out.set(refKey({ kind: "term", id: t.id }), {
      ref: { kind: "term", id: t.id },
      title: t.name,
      subtitle: t.aliases.length ? t.aliases.join("、") : undefined,
      excerpt: t.note ? clip(t.note) : undefined,
    });
  }
  for (const p of papers) {
    if (!p) continue;
    out.set(refKey({ kind: "paper", id: p.id }), {
      ref: { kind: "paper", id: p.id },
      title: p.title,
      subtitle: [p.authors.slice(0, 3).join(", "), p.year].filter(Boolean).join(" · ") || undefined,
      paperId: p.id,
    });
  }
  for (const n of notes) {
    if (!n) continue;
    out.set(refKey({ kind: "note", id: n.id }), { ref: { kind: "note", id: n.id }, title: clip(n.text || "（空笔记）", 60) });
  }
  for (const r of refs) {
    const k = refKey(r);
    if (!out.has(k)) out.set(k, { ref: r, title: `已删除的${ENTITY_KIND_LABELS[r.kind]}`, missing: true });
  }
  return out;
}

/**
 * 按关键词搜索可以连线的实体（术语、批注、论文、自由笔记），每类最多 limit 条。
 * 关键词按空白切分，全部出现才算命中（不区分大小写）。exclude 中的实体不返回。
 */
export async function searchEntities(query: string, opts: { exclude?: EntityRef[]; limit?: number } = {}): Promise<EntitySummary[]> {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const limit = opts.limit ?? 6;
  const excluded = new Set((opts.exclude ?? []).map(refKey));
  const hit = (s: string) => {
    const h = s.toLowerCase();
    return tokens.every((t) => h.includes(t));
  };
  const [terms, anns, papers, notes] = await Promise.all([db.terms.toArray(), db.annotations.toArray(), db.papers.toArray(), db.notes.toArray()]);
  const refs: EntityRef[] = [
    ...terms
      .filter((t) => hit(`${t.name}\n${t.aliases.join("\n")}`) && !excluded.has(`term:${t.id}`))
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, limit)
      .map((t) => ({ kind: "term" as const, id: t.id })),
    ...anns
      .filter((a) => hit(`${a.quote.exact}\n${a.note}`) && !excluded.has(`annotation:${a.id}`))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((a) => ({ kind: "annotation" as const, id: a.id })),
    ...papers
      .filter((p) => hit(`${p.title}\n${p.authors.join("\n")}`) && !excluded.has(`paper:${p.id}`))
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, limit)
      .map((p) => ({ kind: "paper" as const, id: p.id })),
    ...notes
      .filter((n) => hit(n.text) && !excluded.has(`note:${n.id}`))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((n) => ({ kind: "note" as const, id: n.id })),
  ];
  const resolved = await resolveEntities(refs);
  return refs.map((r) => resolved.get(refKey(r))!).filter((s) => !s.missing);
}
