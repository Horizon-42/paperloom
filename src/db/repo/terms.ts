// terms 的读取，以及术语显示设置（kv）的读写。occurrences 的读取见 db/repo/occurrences.ts
import { db } from "@/db/schema";
import type { Term } from "@/types/models";

export function listTerms(): Promise<Term[]> {
  return db.terms.toArray();
}

export function getTerm(id: string): Promise<Term | undefined> {
  return db.terms.get(id);
}

/** 按 id 批量读取，保持顺序，缺失的跳过 */
export async function getTerms(ids: readonly string[]): Promise<Term[]> {
  const rows = await db.terms.bulkGet([...ids]);
  return rows.filter((t): t is Term => !!t);
}

// ---- 显示设置 ----

export const TERM_DISPLAY_KEY = "termDisplay";

export interface TermDisplaySettings {
  /** 每页每个术语只标第一次出现 */
  firstOnly: boolean;
  /** 隐藏全部术语下划线 */
  hidden: boolean;
}

export const DEFAULT_TERM_DISPLAY: TermDisplaySettings = { firstOnly: false, hidden: false };

/** kv 中的值可能缺字段或类型不对，补成完整设置 */
export function parseTermDisplay(v: unknown): TermDisplaySettings {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof TermDisplaySettings, unknown>>;
  return { firstOnly: o.firstOnly === true, hidden: o.hidden === true };
}

export async function getTermDisplay(): Promise<TermDisplaySettings> {
  return parseTermDisplay((await db.kv.get(TERM_DISPLAY_KEY))?.value);
}

export async function putTermDisplay(value: TermDisplaySettings): Promise<void> {
  await db.kv.put({ key: TERM_DISPLAY_KEY, value });
}
