// 领域服务：新建、重命名、改色、拖放移动、级联删除
import { db } from "@/db/schema";
import { t } from "@/i18n";
import { addDomain, deleteDomains, getDomain, listDomains, placeDomains, updateDomain } from "@/db/repo/domains";
import { removeDomainsFromAllPapers } from "@/db/repo/papers";
import { newId } from "@/lib/id";
import type { Domain } from "@/types/models";
import { computeDomainMove, getSubtreeIds, nextOrder, type DomainDrop } from "./domainTree";

export type DomainColorKey = keyof typeof t.library.domains.colors;

/** 领域预设色；颜色名在 t.library.domains.colors[key] */
export const DOMAIN_COLORS: { value: string; key: DomainColorKey }[] = [
  { value: "#3b82f6", key: "blue" },
  { value: "#10b981", key: "green" },
  { value: "#f59e0b", key: "amber" },
  { value: "#ef4444", key: "red" },
  { value: "#8b5cf6", key: "purple" },
  { value: "#06b6d4", key: "cyan" },
  { value: "#ec4899", key: "pink" },
  { value: "#f97316", key: "orange" },
  { value: "#84cc16", key: "lime" },
  { value: "#6366f1", key: "indigo" },
  { value: "#64748b", key: "gray" },
];

export async function createDomain(input: { name?: string; parentId?: string | null; color?: string } = {}): Promise<Domain> {
  return db.transaction("rw", db.domains, async () => {
    const all = await listDomains();
    let parentId = input.parentId ?? null;
    if (parentId !== null && !all.some((d) => d.id === parentId)) parentId = null;
    const domain: Domain = {
      id: newId(),
      name: input.name?.trim() || t.library.domains.defaultName,
      parentId,
      color: input.color ?? DOMAIN_COLORS[all.length % DOMAIN_COLORS.length].value,
      order: nextOrder(all, parentId),
    };
    await addDomain(domain);
    return domain;
  });
}

/** 名称为空时不改 */
export async function renameDomain(id: string, name: string): Promise<void> {
  const n = name.replace(/\s+/g, " ").trim();
  if (n) await updateDomain(id, { name: n });
}

export async function setDomainColor(id: string, color: string): Promise<void> {
  await updateDomain(id, { color });
}

/** 拖放移动领域。非法（会形成环、目标不存在）时返回 false 且不改数据 */
export async function moveDomain(dragId: string, drop: DomainDrop): Promise<boolean> {
  return db.transaction("rw", db.domains, async () => {
    const updates = computeDomainMove(await listDomains(), dragId, drop);
    if (updates === null) return false;
    await placeDomains(updates);
    return true;
  });
}

export interface DomainDeleteImpact {
  domain: Domain;
  /** 自身 + 所有子孙 */
  domainIds: string[];
  descendantCount: number;
  /** 会被移出这些领域的论文数（论文本身不删） */
  paperCount: number;
  /** 作用范围包含这些领域的术语数 */
  termCount: number;
}

export async function getDomainDeleteImpact(id: string): Promise<DomainDeleteImpact | null> {
  const domain = await getDomain(id);
  if (!domain) return null;
  const domainIds = getSubtreeIds(await listDomains(), id);
  const set = new Set(domainIds);
  const paperCount = (await db.papers.where("domainIds").anyOf(domainIds).distinct().primaryKeys()).length;
  const termCount = await db.terms
    .filter((t) => t.scope.kind === "domains" && t.scope.domainIds.some((d) => set.has(d)))
    .count();
  return { domain, domainIds, descendantCount: domainIds.length - 1, paperCount, termCount };
}

/**
 * 删除领域及其所有子孙。论文不删，只从 domainIds 中移除；
 * 术语 scope 为 domains 时移除这些 id（列表变空表示不在任何地方生效，不改成全局）；
 * 画布的 domainIds 同样移除。返回被删除的领域 id。
 */
export async function deleteDomain(id: string): Promise<string[]> {
  return db.transaction("rw", [db.domains, db.papers, db.terms, db.boards], async () => {
    const all = await listDomains();
    if (!all.some((d) => d.id === id)) return [];
    const ids = getSubtreeIds(all, id);
    const drop = new Set(ids);
    const now = Date.now();

    await deleteDomains(ids);
    await removeDomainsFromAllPapers(ids);
    await db.terms
      .filter((t) => t.scope.kind === "domains" && t.scope.domainIds.some((d) => drop.has(d)))
      .modify((t) => {
        if (t.scope.kind !== "domains") return;
        t.scope = { kind: "domains", domainIds: t.scope.domainIds.filter((d) => !drop.has(d)) };
        t.updatedAt = now;
      });
    await db.boards
      .filter((b) => b.domainIds.some((d) => drop.has(d)))
      .modify((b) => {
        b.domainIds = b.domainIds.filter((d) => !drop.has(d));
      });
    return ids;
  });
}
