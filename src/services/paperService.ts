// 论文领域服务：导入（去重、元数据推断）、编辑、归类、级联删除
import { db } from "@/db/schema";
import { t } from "@/i18n";
import { getDomain } from "@/db/repo/domains";
import { getFile, putFile } from "@/db/repo/files";
import { addPaper, getPaper, getPaperByHash, updatePaper, type PaperChanges } from "@/db/repo/papers";
import { sha256Hex } from "@/lib/hash";
import { newId } from "@/lib/id";
import { normalizeTags, paperTags, tagKey } from "@/lib/tags";
import type { EntityRef, Paper } from "@/types/models";
import { STAMP_PREFIX } from "@/db/repo/occurrences";

// ---------- 元数据推断（纯函数） ----------

/** 从 PDF 读出的原始信息 */
export interface PdfInfo {
  pageCount: number;
  title?: string; // Info 字典的 Title
  author?: string; // Info 字典的 Author
  creationDate?: string; // "D:20230512..."
  xmpTitle?: string; // XMP dc:title
  xmpCreator?: string; // XMP dc:creator
}

export type PdfInfoReader = (data: ArrayBuffer) => Promise<PdfInfo>;

const FILE_EXT_RE = /\.(pdf|docx?|tex|dvi|ps|eps|fm|cdr|indd|rtf|odt|pptx?|xlsx?|qxd|pub|wpd|txt|md)$/i;
const OFFICE_PREFIX_RE = /^microsoft\s+(word|powerpoint|excel)\s*-/i;
// PDF 元数据里常见的占位标题
const PLACEHOLDER_RE =
  // i18n-ignore: 识别规则（含中文的"无标题"），不是界面文字
  /^(untitled|untitled[\s-]*\d+|无标题|document\s*\d*|title|template|.*\btemplate|table of contents|executive summary|powerpoint presentation|presentation\d*|slide\s*\d+|main|manuscript|article|paper|draft|cover|abstract|doi|pdf)$/i;

/** 元数据标题是否明显无意义（空、纯数字、Word 转换名、文件名、模板占位符等） */
export function isMeaninglessTitle(raw: string | undefined | null): boolean {
  const t = (raw ?? "").trim();
  if (t.length < 3) return true;
  if (!/\p{L}/u.test(t)) return true; // 没有任何字母/汉字
  if (OFFICE_PREFIX_RE.test(t)) return true;
  if (FILE_EXT_RE.test(t)) return true;
  if (PLACEHOLDER_RE.test(t)) return true;
  if (/use style:/i.test(t)) return true; // IEEE 模板 "Paper Title (use style: paper title)"
  if (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(t)) return true; // arXiv 编号
  if (/^(doi:\s*)?10\.\d{4,}\//i.test(t)) return true;
  if (/^PII:/i.test(t)) return true;
  if (/\b\d+\.\.\d+\b/.test(t)) return true; // 排版系统的页码范围，如 "COMPLEXITY1659103 1..19"
  if (!/\s/.test(t) && /_/.test(t)) return true; // 无空格但含下划线，像文件名
  return false;
}

/** 规整元数据标题：去首尾空白、合并空白、去掉整串重复（"AbcAbc" → "Abc"） */
export function cleanTitle(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  if (t.length % 2 === 0 && t.length >= 8) {
    const half = t.length / 2;
    if (t.slice(0, half) === t.slice(half)) t = t.slice(0, half).trim();
  }
  return t;
}

/** 文件名 → 标题：去扩展名、下划线转空格 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const title = base.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return title || fileName || t.library.importErrors.untitled;
}

export function deriveTitle(info: Pick<PdfInfo, "title" | "xmpTitle">, fileName: string): string {
  for (const cand of [info.title, info.xmpTitle]) {
    if (cand && !isMeaninglessTitle(cand)) {
      const t = cleanTitle(cand);
      if (!isMeaninglessTitle(t)) return t;
    }
  }
  return titleFromFileName(fileName);
}

function plausibleYear(y: number, now = new Date()): boolean {
  return y >= 1900 && y <= now.getFullYear() + 1;
}

/** PDF 日期字符串（"D:20230512..."，或不规范的 "5/21/2015"）中的年份 */
export function yearFromPdfDate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^D:(\d{4})/.exec(raw.trim()) ?? /(?:^|\D)(19\d{2}|20\d{2})(?!\d)/.exec(raw);
  const y = m ? Number(m[1]) : NaN;
  return plausibleYear(y) ? y : undefined;
}

/** 文件名中的年份：19xx/20xx（前后不是数字），或 arXiv 编号 "2211.14730" → 2022 */
export function yearFromFileName(fileName: string): number | undefined {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const m = /(?:^|\D)(19\d{2}|20\d{2})(?!\d)/.exec(base);
  if (m && plausibleYear(Number(m[1]))) return Number(m[1]);
  const arxiv = /(?:^|\D)(\d{2})(0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?(?!\d)/.exec(base);
  if (arxiv) {
    const y = 2000 + Number(arxiv[1]);
    if (y >= 2007 && plausibleYear(y)) return y; // 新式 arXiv 编号始于 2007
  }
  return undefined;
}

/** 文件名中的年份通常是用户有意写的，优先于 PDF 生成日期 */
export function deriveYear(info: Pick<PdfInfo, "creationDate">, fileName: string): number | undefined {
  return yearFromFileName(fileName) ?? yearFromPdfDate(info.creationDate);
}

/** 像 "mwatson"、"PDF5"、邮箱、软件名这样的作者字段不是真实作者 */
function isJunkAuthor(a: string): boolean {
  if (a.length < 2) return true;
  if (a.includes("@") || /^https?:/i.test(a)) return true;
  if (/^(et al\.?|admin(istrator)?|user|owner|authors?|unknown|ieee|latex.*|microsoft.*|adobe.*|anonymous.*)$/i.test(a)) return true;
  // 用户名：单个 ASCII 词，全小写或带数字（"mwatson"、"PDF5"）；中文名不受影响
  if (/^[\w-]+$/.test(a) && (/\d/.test(a) || a === a.toLowerCase())) return true;
  return false;
}

/** "Last, First" → "First Last" */
function flipLastFirst(a: string): string {
  const m = /^([^,]+),\s*([^,]+)$/.exec(a);
  return m ? `${m[2].trim()} ${m[1].trim()}` : a;
}

/** 解析 PDF 元数据里的作者字符串 */
export function parseMetadataAuthors(raw: string | undefined): string[] {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return [];
  let parts: string[];
  // \uFF1B：全角分号；\uFF0C：全角逗号；\u3001：顿号
  if (/[;\uFF1B]/.test(s)) {
    parts = s.split(/[;\uFF1B]/);
  } else {
    const byAnd = s.split(/\s+and\s+|\s*&\s*/i);
    if (byAnd.length >= 2 && byAnd.every((p) => (p.match(/,/g) ?? []).length === 1)) {
      // "Alligier, Richard and Gianazza, David"
      parts = byAnd.map(flipLastFirst);
    } else if (byAnd.length === 1 && /^[A-Za-z'-]+,\s*[A-Z][A-Za-z.' -]*$/.test(s) && s.split(",")[1].trim().split(/\s+/).length <= 2) {
      // 单个 "Holleman, E.C." / "Price, Craig"（只对西文姓名翻转，"张三, 李四" 按两人处理）
      parts = [flipLastFirst(s)];
    } else {
      parts = s.split(/\s*[,\uFF0C\u3001]\s*(?:and\s+)?|\s+and\s+|\s*&\s*/i);
    }
  }
  return dedupe(parts.map((p) => p.trim()).filter((p) => p && !isJunkAuthor(p)));
}

/** 编辑框里的作者输入：逗号或分号分隔 */
export function parseAuthorsInput(raw: string): string[] {
  return dedupe(
    raw
      .split(/[,;\uFF0C\uFF1B\u3001\n]/) // 含全角逗号、分号和顿号
      .map((a) => a.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

export function formatAuthorsInput(authors: string[]): string {
  return authors.join(", ");
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// ---------- 读取 PDF ----------

/** 文件头前 1 KB 内是否有 "%PDF-" 标记 */
export function hasPdfMagic(data: ArrayBuffer): boolean {
  const head = new Uint8Array(data, 0, Math.min(1024, data.byteLength));
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  outer: for (let i = 0; i + sig.length <= head.length; i++) {
    for (let j = 0; j < sig.length; j++) if (head[i + j] !== sig[j]) continue outer;
    return true;
  }
  return false;
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("; ") || undefined;
  return undefined;
}

/** 默认实现：用 pdf.js 读页数和元数据。动态加载 pdf.js，测试注入假实现时不必加载它 */
export const readPdfInfo: PdfInfoReader = async (data) => {
  const { loadPdf } = await import("@/lib/pdf");
  // pdf.js 会转移传入的 buffer，这里传副本
  const doc = await loadPdf(data.slice(0));
  try {
    const { info, metadata } = await doc.getMetadata().catch(() => ({ info: {}, metadata: null }));
    const dict = (info ?? {}) as Record<string, unknown>;
    return {
      pageCount: doc.numPages,
      title: asString(dict.Title),
      author: asString(dict.Author),
      creationDate: asString(dict.CreationDate),
      xmpTitle: asString(metadata?.get("dc:title")),
      xmpCreator: asString(metadata?.get("dc:creator")),
    };
  } finally {
    void doc.loadingTask.destroy();
  }
};

// ---------- 导入 ----------

/** File 满足此接口；测试中可传普通对象 */
export interface ImportSource {
  name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ImportOutcome =
  | { status: "added"; fileName: string; paper: Paper }
  | { status: "duplicate"; fileName: string; paper: Paper }
  | { status: "failed"; fileName: string; error: string };

export interface ImportOptions {
  /** 新论文自动归入的领域（领域不存在时忽略） */
  domainId?: string | null;
  readInfo?: PdfInfoReader;
  now?: () => number;
}

export interface ImportSummary {
  added: Extract<ImportOutcome, { status: "added" }>[];
  duplicates: Extract<ImportOutcome, { status: "duplicate" }>[];
  failed: Extract<ImportOutcome, { status: "failed" }>[];
}

class ImportError extends Error {}

function describeError(e: unknown): string {
  if (e instanceof ImportError) return e.message;
  const name = (e as { name?: string } | null)?.name ?? "";
  const errors = t.library.importErrors;
  if (name === "PasswordException") return errors.encrypted;
  if (name === "InvalidPDFException") return errors.corrupt;
  if (name === "NotReadableError" || name === "NotFoundError") return errors.unreadable;
  const msg = e instanceof Error ? e.message : String(e);
  return msg || errors.unknown;
}

/** 导入一个文件。不抛异常：失败时返回 status "failed" */
export async function importPdf(source: ImportSource, opts: ImportOptions = {}): Promise<ImportOutcome> {
  const fileName = source.name;
  try {
    let data: ArrayBuffer;
    try {
      data = await source.arrayBuffer();
    } catch {
      throw new ImportError(t.library.importErrors.unreadable);
    }
    if (!hasPdfMagic(data)) throw new ImportError(t.library.importErrors.notPdf);

    const hash = await sha256Hex(data);
    const existing = await getPaperByHash(hash);
    if (existing) {
      // 旧记录缺少文件（例如只从 JSON 备份恢复了元数据）时顺便补上
      if (!(await getFile(hash))) await putFile({ hash, blob: new Blob([data], { type: "application/pdf" }), size: data.byteLength });
      return { status: "duplicate", fileName, paper: existing };
    }

    const info = await (opts.readInfo ?? readPdfInfo)(data);
    if (!Number.isFinite(info.pageCount) || info.pageCount < 1) throw new ImportError(t.library.importErrors.noPages);

    const domainIds: string[] = [];
    if (opts.domainId && (await getDomain(opts.domainId))) domainIds.push(opts.domainId);

    const year = deriveYear(info, fileName);
    const paper: Paper = {
      id: newId(),
      fileHash: hash,
      title: deriveTitle(info, fileName),
      authors: parseMetadataAuthors(info.author ?? info.xmpCreator),
      ...(year !== undefined ? { year } : {}),
      domainIds,
      pageCount: info.pageCount,
      addedAt: (opts.now ?? Date.now)(),
    };
    const blob = new Blob([data], { type: "application/pdf" });

    const dup = await db.transaction("rw", db.papers, db.files, async () => {
      // 事务内再查一次，防止并发导入同一文件
      const again = await getPaperByHash(hash);
      if (again) return again;
      await putFile({ hash, blob, size: data.byteLength });
      await addPaper(paper);
      return null;
    });
    if (dup) return { status: "duplicate", fileName, paper: dup };
    return { status: "added", fileName, paper };
  } catch (e) {
    return { status: "failed", fileName, error: describeError(e) };
  }
}

export function summarizeImport(outcomes: ImportOutcome[]): ImportSummary {
  const s: ImportSummary = { added: [], duplicates: [], failed: [] };
  for (const o of outcomes) {
    if (o.status === "added") s.added.push(o);
    else if (o.status === "duplicate") s.duplicates.push(o);
    else s.failed.push(o);
  }
  return s;
}

/** 依次导入多个文件；单个失败不影响其他文件 */
export async function importPdfs(
  sources: ImportSource[],
  opts: ImportOptions & { onProgress?: (done: number, total: number, last: ImportOutcome) => void } = {},
): Promise<ImportSummary> {
  const outcomes: ImportOutcome[] = [];
  for (const src of sources) {
    const o = await importPdf(src, opts);
    outcomes.push(o);
    opts.onProgress?.(outcomes.length, sources.length, o);
  }
  return summarizeImport(outcomes);
}

// ---------- 编辑与归类 ----------

export interface PaperMetadataPatch {
  title?: string;
  authors?: string[];
  /** null 表示清空年份 */
  year?: number | null;
  domainIds?: string[];
  /** 整体替换标签，空数组表示清空 */
  tags?: string[];
  /**
   * 在论文当前的标签上增删（编辑对话框用：只应用用户在表单里做的改动，
   * 不会用打开对话框时的旧副本覆盖期间从别处加上的标签）。与 tags 同时给出时忽略。
   */
  tagChanges?: { add: string[]; remove: string[] };
}

export async function updatePaperMetadata(id: string, patch: PaperMetadataPatch): Promise<void> {
  const changes: PaperChanges = {};
  if (patch.title !== undefined) {
    const t = patch.title.replace(/\s+/g, " ").trim();
    if (t) changes.title = t;
  }
  if (patch.authors !== undefined) changes.authors = dedupe(patch.authors.map((a) => a.trim()).filter(Boolean));
  if (patch.year !== undefined) {
    if (patch.year === null) changes.year = undefined;
    else if (Number.isInteger(patch.year)) changes.year = patch.year;
  }
  if (patch.domainIds !== undefined) changes.domainIds = dedupe(patch.domainIds);
  if (patch.tags !== undefined) {
    const tags = normalizeTags(patch.tags);
    changes.tags = tags.length ? tags : undefined;
  }
  const delta = patch.tags === undefined ? patch.tagChanges : undefined;
  if (!delta || (!delta.add.length && !delta.remove.length)) {
    await updatePaper(id, changes);
    return;
  }
  await db.transaction("rw", db.papers, async () => {
    const p = await getPaper(id);
    if (!p) return;
    // 只改大小写时 add 与 remove 的键相同：保留标签（沿用原写法），不当作删除
    const added = new Set(delta.add.map(tagKey));
    const drop = new Set(delta.remove.map(tagKey).filter((k) => !added.has(k)));
    const tags = normalizeTags([...paperTags(p), ...delta.add]).filter((t) => !drop.has(t.toLocaleLowerCase()));
    await updatePaper(id, { ...changes, tags: tags.length ? tags : undefined });
  });
}

/** 把论文加入领域（保留已有领域） */
export async function addPaperToDomain(paperId: string, domainId: string): Promise<boolean> {
  return db.transaction("rw", db.papers, db.domains, async () => {
    const p = await getPaper(paperId);
    if (!p || !(await getDomain(domainId)) || p.domainIds.includes(domainId)) return false;
    await updatePaper(paperId, { domainIds: [...p.domainIds, domainId] });
    return true;
  });
}

/**
 * 把论文移到领域（拖放）：先移出 from 中的领域（"all" = 移出所有领域），再加入目标领域。
 * 返回移动前的 domainIds（供撤销）；目标领域不存在或没有变化时返回 null
 */
export async function movePaperToDomain(paperId: string, domainId: string, from: readonly string[] | "all"): Promise<string[] | null> {
  return db.transaction("rw", db.papers, db.domains, async () => {
    const p = await getPaper(paperId);
    if (!p || !(await getDomain(domainId))) return null;
    const drop = new Set(from === "all" ? p.domainIds : from);
    const next = p.domainIds.filter((id) => !drop.has(id) && id !== domainId);
    next.push(domainId);
    if (next.length === p.domainIds.length && next.every((id) => p.domainIds.includes(id))) return null;
    await updatePaper(paperId, { domainIds: next });
    return p.domainIds;
  });
}

/** 撤销移动：恢复原来的领域（期间被删除的领域跳过） */
export async function restorePaperDomains(paperId: string, domainIds: readonly string[]): Promise<void> {
  await db.transaction("rw", db.papers, db.domains, async () => {
    const p = await getPaper(paperId);
    if (!p) return;
    const exist = new Set((await db.domains.bulkGet([...domainIds])).filter((d) => !!d).map((d) => d!.id));
    await updatePaper(paperId, { domainIds: domainIds.filter((id) => exist.has(id)) });
  });
}

/** 从论文的 domainIds 中移除给定领域 */
export async function removePaperFromDomains(paperId: string, domainIds: string[]): Promise<void> {
  const drop = new Set(domainIds);
  await db.transaction("rw", db.papers, async () => {
    const p = await getPaper(paperId);
    if (!p) return;
    const next = p.domainIds.filter((id) => !drop.has(id));
    if (next.length !== p.domainIds.length) await updatePaper(paperId, { domainIds: next });
  });
}

export async function markPaperOpened(paperId: string, at = Date.now()): Promise<void> {
  await updatePaper(paperId, { lastOpenedAt: at });
}

// ---------- 删除 ----------

/** 删除确认框里展示的影响范围 */
export async function getPaperDeleteImpact(paperId: string): Promise<{ annotationCount: number }> {
  return { annotationCount: await db.annotations.where("paperId").equals(paperId).count() };
}

function refersTo(ref: EntityRef, paperId: string, annotationIds: Set<string>): boolean {
  return (ref.kind === "paper" && ref.id === paperId) || (ref.kind === "annotation" && annotationIds.has(ref.id));
}

/**
 * 删除论文并级联：批注、术语出现位置、页面文本缓存、PDF 文件（无其他论文引用时）、
 * 指向论文或其批注的连线和画布节点；术语的 sourceAnnotationId 指向被删批注的清空。
 */
export async function deletePaper(paperId: string): Promise<void> {
  const tables = [db.papers, db.annotations, db.occurrences, db.pageTexts, db.files, db.links, db.boardNodes, db.terms, db.kv];
  await db.transaction("rw", tables, async () => {
    const paper = await db.papers.get(paperId);
    if (!paper) return;

    const annotationIds = new Set(await db.annotations.where("paperId").equals(paperId).primaryKeys());
    const refIds = [paperId, ...annotationIds];

    await db.annotations.bulkDelete([...annotationIds]);
    await db.occurrences.where("paperId").equals(paperId).delete();
    await db.pageTexts.where("paperId").equals(paperId).delete();
    await db.kv.delete(STAMP_PREFIX + paperId); // 后台索引的扫描戳

    const linkIds = new Set<string>();
    for (const index of ["from.id", "to.id"] as const) {
      const links = await db.links.where(index).anyOf(refIds).toArray();
      for (const l of links) {
        if (refersTo(l.from, paperId, annotationIds) || refersTo(l.to, paperId, annotationIds)) linkIds.add(l.id);
      }
    }
    await db.links.bulkDelete([...linkIds]);

    const nodes = await db.boardNodes.where("ref.id").anyOf(refIds).toArray();
    await db.boardNodes.bulkDelete(nodes.filter((n) => refersTo(n.ref, paperId, annotationIds)).map((n) => n.id));

    if (annotationIds.size) {
      await db.terms
        .filter((t) => t.sourceAnnotationId !== undefined && annotationIds.has(t.sourceAnnotationId))
        .modify((t) => {
          delete t.sourceAnnotationId;
        });
    }

    await db.papers.delete(paperId);
    const stillUsed = await db.papers.where("fileHash").equals(paper.fileHash).count();
    if (!stillUsed) await db.files.delete(paper.fileHash);
  });
}
