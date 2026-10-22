/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 术语后台 e2e 的公共工具：通过 window.__paperlens / __paperlensGlossary 写入数据、等待索引完成。
import { expect, type Page } from "@playwright/test";
import { boot, fileHashOf } from "./viewerHelpers";

export interface OccRow {
  termId: string;
  paperId: string;
  pages: number[];
  count: number;
  engineVersion: number;
}

export interface TermSeed {
  id: string;
  name: string;
  aliases?: string[];
  matchMode?: "auto" | "caseSensitive" | "caseInsensitive";
  domains?: string[];
  note?: string;
  updatedAt?: number;
}

export async function bootGlossary(page: Page) {
  await boot(page);
  await page.waitForFunction(() => !!(window as unknown as { __paperlensGlossary?: unknown }).__paperlensGlossary);
}

/** 写入 PDF（files + papers，pageCount 为 0，等后台提取全文时更正） */
export async function addPdf(page: Page, bytes: Buffer, id: string, title: string, domainIds: string[] = []) {
  const hash = fileHashOf(bytes);
  await page.evaluate(
    async ({ b64, hash, id, title, domainIds }) => {
      const { db } = (window as any).__paperlens;
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await db.files.put({ hash, blob: new Blob([bin], { type: "application/pdf" }), size: bin.length });
      await db.papers.put({ id, fileHash: hash, title, authors: [], domainIds, pageCount: 0, addedAt: Date.now() });
    },
    { b64: bytes.toString("base64"), hash, id, title, domainIds },
  );
  return id;
}

export async function putDomains(page: Page, domains: { id: string; name: string; parentId?: string | null; color?: string }[]) {
  await page.evaluate(async (domains) => {
    const { db } = (window as any).__paperlens;
    await db.domains.bulkPut(
      domains.map((d, i) => ({ id: d.id, name: d.name, parentId: d.parentId ?? null, color: d.color ?? "#3b82f6", order: i })),
    );
  }, domains);
}

export async function putTerms(page: Page, terms: TermSeed[]) {
  await page.evaluate(async (terms) => {
    const { db } = (window as any).__paperlens;
    const now = Date.now();
    await db.terms.bulkPut(
      terms.map((t) => ({
        id: t.id,
        name: t.name,
        aliases: t.aliases ?? [],
        matchMode: t.matchMode ?? "auto",
        scope: t.domains ? { kind: "domains", domainIds: t.domains } : { kind: "global" },
        note: t.note ?? "",
        createdAt: now,
        updatedAt: t.updatedAt ?? now,
      })),
    );
  }, terms);
}

export async function updateRecord(page: Page, table: "terms" | "papers", id: string, changes: Record<string, unknown>) {
  await page.evaluate(
    async ({ table, id, changes }) => (window as any).__paperlens.db[table].update(id, changes),
    { table, id, changes },
  );
}

export async function getOccurrences(page: Page): Promise<OccRow[]> {
  return page.evaluate(() => (window as any).__paperlens.db.occurrences.toArray());
}

export async function getPageTexts(page: Page, paperId: string): Promise<{ page: number; text: string }[]> {
  return page.evaluate(async (paperId) => {
    const rows = await (window as any).__paperlens.db.pageTexts.where("paperId").equals(paperId).toArray();
    return rows.map((r: { page: number; text: string }) => ({ page: r.page, text: r.text })).sort((a: { page: number }, b: { page: number }) => a.page - b.page);
  }, paperId);
}

/** 等后台索引空闲，并保持空闲一段时间（防抖中的请求也算未完成） */
export async function waitIndexed(page: Page, timeout = 60_000) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const g = (window as any).__paperlensGlossary;
          await g.whenIndexerIdle();
          await new Promise((r) => setTimeout(r, 700));
          const d = g.getIndexerDebug();
          return !!d && !d.running && !d.pending && !d.queued && d.extractQueue.length === 0;
        }),
      { timeout, intervals: [100] },
    )
    .toBe(true);
}

/** 用正则独立地统计一篇论文里的命中，作为 occurrences 的对照 */
export function expectedOcc(pages: { page: number; text: string }[], patterns: RegExp[]) {
  const hit: number[] = [];
  let count = 0;
  for (const p of pages) {
    let n = 0;
    for (const re of patterns) n += [...p.text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))].length;
    if (n) hit.push(p.page);
    count += n;
  }
  return { pages: hit, count };
}

export function occFor(rows: OccRow[], termId: string, paperId: string) {
  const r = rows.find((o) => o.termId === termId && o.paperId === paperId);
  return r ? { pages: r.pages, count: r.count } : undefined;
}
