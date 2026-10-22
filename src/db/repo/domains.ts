// domains 表的读写
import { db } from "@/db/schema";
import type { Domain } from "@/types/models";

export function listDomains(): Promise<Domain[]> {
  return db.domains.toArray();
}

export function getDomain(id: string): Promise<Domain | undefined> {
  return db.domains.get(id);
}

export async function addDomain(domain: Domain): Promise<void> {
  await db.domains.add(domain);
}

export async function updateDomain(id: string, changes: Partial<Omit<Domain, "id">>): Promise<void> {
  await db.domains.update(id, changes);
}

/** 批量写回 parentId / order（拖放后使用） */
export async function placeDomains(updates: { id: string; parentId: string | null; order: number }[]): Promise<void> {
  if (!updates.length) return;
  await db.domains.bulkUpdate(updates.map((u) => ({ key: u.id, changes: { parentId: u.parentId, order: u.order } })));
}

export async function deleteDomains(ids: string[]): Promise<void> {
  await db.domains.bulkDelete(ids);
}
