// Paperloom 数据文件格式（data/library.json 与导出的 JSON 备份共用）：
//   { format: "paperlens", version, exportedAt, revision?, tables: { domains, papers, annotations, terms, links, notes, boards, boardNodes, kv } }
// 不含 files（PDF 单独存放）、pageTexts 和 occurrences（派生数据，恢复后由索引器重建），
// 以及 kv 中 "indexer:"（索引派生数据）和 "storage:"（本模块在每个浏览器里的记账）开头的记录。
// 纯函数：不碰数据库和 DOM，可在 Worker 中运行。
import { DATA_FORMAT_VERSION } from "@/db/schema";
import { t } from "@/i18n";
import { normalizeTags } from "@/lib/tags";
import type {
  AnchorStatus,
  Annotation,
  Board,
  BoardNode,
  Domain,
  EntityKind,
  EntityRef,
  KvRecord,
  Link,
  LinkRelation,
  MatchMode,
  Note,
  Paper,
  PdfRect,
  Term,
  TermScope,
} from "@/types/models";

export const DATA_TABLE_NAMES = ["domains", "papers", "annotations", "terms", "links", "notes", "boards", "boardNodes", "kv"] as const;
export type DataTableName = (typeof DATA_TABLE_NAMES)[number];

export interface DataTables {
  domains: Domain[];
  papers: Paper[];
  annotations: Annotation[];
  terms: Term[];
  links: Link[];
  notes: Note[];
  boards: Board[];
  boardNodes: BoardNode[];
  kv: KvRecord[];
}

export interface DataFile {
  format: "paperlens";
  version: number;
  exportedAt: string;
  revision?: number;
  tables: DataTables;
}

export type DataCounts = Record<DataTableName, number>;

/** 不导出的 kv 前缀 */
export const DERIVED_KV_PREFIXES = ["indexer:", "storage:"] as const;

export function isDerivedKvKey(key: string): boolean {
  return DERIVED_KV_PREFIXES.some((p) => key.startsWith(p));
}

export function emptyTables(): DataTables {
  return { domains: [], papers: [], annotations: [], terms: [], links: [], notes: [], boards: [], boardNodes: [], kv: [] };
}

export function countTables(t: DataTables): DataCounts {
  const out = {} as DataCounts;
  for (const name of DATA_TABLE_NAMES) out[name] = t[name].length;
  return out;
}

/** 是否有用户内容（不计 kv 设置和依附于画布的节点）。与服务端 CONTENT_TABLES 一致 */
export function hasUserData(c: Partial<Record<string, number>> | null | undefined): boolean {
  if (!c) return false;
  return ["domains", "papers", "annotations", "terms", "links", "notes", "boards"].some((k) => (c[k] ?? 0) > 0);
}

// ---------- 序列化 ----------

/**
 * tables 部分的 JSON：每条记录一行，便于用文本工具查看和比较版本差异。
 * 记录顺序沿用读取顺序（按主键），同样的数据得到同样的字符串（用来判断是否需要保存）。
 */
export function serializeTables(t: DataTables): string {
  const parts: string[] = [];
  for (const name of DATA_TABLE_NAMES) {
    const rows = t[name];
    parts.push(rows.length ? `"${name}":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]` : `"${name}":[]`);
  }
  return `{\n${parts.join(",\n")}\n}`;
}

/**
 * 完整的数据文件。contentHash 是 tables 部分的 SHA-256：本地服务据此认出"文件夹里就是这份数据"
 * （例如写入成功但响应丢失时，不必当作冲突）。导入时忽略。
 */
export function serializeDataFile(tablesJson: string, meta: { exportedAt: string; revision?: number; contentHash?: string }): string {
  const head = JSON.stringify({
    format: "paperlens",
    version: DATA_FORMAT_VERSION,
    exportedAt: meta.exportedAt,
    ...(meta.revision !== undefined ? { revision: meta.revision } : {}),
    ...(meta.contentHash !== undefined ? { contentHash: meta.contentHash } : {}),
  });
  return `${head.slice(0, -1)},"tables":${tablesJson}}\n`;
}

/**
 * 同步计算的快速指纹（两路 32 位 FNV-1a）。用在 IndexedDB 事务里比较"数据有没有变"：
 * 事务中不能等待 crypto.subtle 之类的异步调用，否则事务会提前提交。
 */
export function fingerprint(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}${s.length.toString(16)}`;
}

// ---------- 解析与修复 ----------

export class DataFormatError extends Error {
  override name = "DataFormatError";
}

/** 导入时被丢弃或修正的记录数 */
export interface RepairReport {
  /** 无效或引用缺失而丢弃的记录 */
  dropped: Partial<Record<DataTableName, number>>;
  /** 批注补上 fileHash（旧数据没有该字段） */
  annotationFileHash: number;
  /** 批注指向的术语不存在，去掉 termId */
  annotationTermId: number;
  /** 术语的出处批注不存在，去掉 sourceAnnotationId */
  termSource: number;
  /** 同一 PDF 的重复论文合并到第一篇 */
  mergedPapers: number;
}

export interface ParsedDataFile {
  file: DataFile;
  report: RepairReport;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter(isStr))] : []);
const numOr = (v: unknown, d: number) => (isNum(v) ? v : d);
const strOr = (v: unknown, d: string) => (isStr(v) ? v : d);

const MATCH_MODES: MatchMode[] = ["auto", "caseSensitive", "caseInsensitive"];
const ANCHOR_STATUSES: AnchorStatus[] = ["ok", "relocated", "orphaned"];
const ENTITY_KINDS: EntityKind[] = ["annotation", "term", "paper", "note"];
const RELATIONS: LinkRelation[] = ["supports", "contradicts", "extends", "compares", "partOf", "custom"];
const DEFAULT_DOMAIN_COLOR = "#3b82f6"; // 与 domainService.DOMAIN_COLORS[0] 相同
const DEFAULT_HIGHLIGHT = "#fde68a";

function isRect(v: unknown): v is PdfRect {
  return Array.isArray(v) && v.length === 4 && v.every(isNum);
}

function asRef(v: unknown): EntityRef | null {
  if (!isObj(v) || !ENTITY_KINDS.includes(v.kind as EntityKind) || !isId(v.id)) return null;
  return { kind: v.kind as EntityKind, id: v.id };
}

/** 解析数据文件：校验格式与版本，修复引用。失败时抛出 DataFormatError（消息可直接展示） */
export function parseDataFile(text: string, now = Date.now()): ParsedDataFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new DataFormatError(t.data.format.invalidJson);
  }
  if (!isObj(doc) || doc.format !== "paperlens") throw new DataFormatError(t.data.format.notPaperloom);
  const v = doc.version;
  if (!isNum(v) || v < 1) throw new DataFormatError(t.data.format.missingVersion);
  if (Math.floor(v) > DATA_FORMAT_VERSION) {
    throw new DataFormatError(t.data.format.newerVersion(Math.floor(v), DATA_FORMAT_VERSION));
  }
  if (!isObj(doc.tables)) throw new DataFormatError(t.data.format.missingTables);
  const { tables, report } = normalizeTables(doc.tables, now);
  return {
    file: {
      format: "paperlens",
      version: v,
      exportedAt: strOr(doc.exportedAt, ""),
      ...(Number.isInteger(doc.revision) ? { revision: doc.revision as number } : {}),
      tables,
    },
    report,
  };
}

/**
 * 校验每条记录、补默认值、修复引用：
 * 批注的 termId 指向不存在的术语则去掉；术语的 sourceAnnotationId 指向不存在的批注则去掉；
 * 端点不存在的连线和画布节点丢弃；批注缺 fileHash 时补为论文当前的哈希。保留未知字段（较新的次版本可能加了字段）。
 */
export function normalizeTables(raw: Obj, now = Date.now()): { tables: DataTables; report: RepairReport } {
  const report: RepairReport = { dropped: {}, annotationFileHash: 0, annotationTermId: 0, termSource: 0, mergedPapers: 0 };
  const drop = (t: DataTableName, n = 1) => {
    if (n > 0) report.dropped[t] = (report.dropped[t] ?? 0) + n;
  };
  /** 取出一张表的对象记录，按 id 去重（保留第一条） */
  const rowsOf = (name: DataTableName, key = "id"): Obj[] => {
    const v = raw[name];
    if (!Array.isArray(v)) return [];
    const seen = new Set<string>();
    const out: Obj[] = [];
    for (const r of v) {
      if (!isObj(r) || !isId(r[key]) || seen.has(r[key] as string)) {
        drop(name);
        continue;
      }
      seen.add(r[key] as string);
      out.push(r);
    }
    return out;
  };

  // 领域
  const domains: Domain[] = [];
  rowsOf("domains").forEach((r, i) => {
    if (!isStr(r.name)) return drop("domains");
    domains.push({
      ...r,
      id: r.id as string,
      name: r.name,
      parentId: isId(r.parentId) ? r.parentId : null,
      color: strOr(r.color, DEFAULT_DOMAIN_COLOR),
      order: numOr(r.order, i),
    });
  });
  const domainIds = new Set(domains.map((d) => d.id));
  for (const d of domains) if (d.parentId !== null && (!domainIds.has(d.parentId) || d.parentId === d.id)) d.parentId = null;

  // 论文（fileHash 唯一：重复的合并到第一篇）
  const papers: Paper[] = [];
  const paperByHash = new Map<string, Paper>();
  const paperAlias = new Map<string, string>(); // 被合并的论文 id → 保留的论文 id
  for (const r of rowsOf("papers")) {
    if (!isId(r.fileHash)) {
      drop("papers");
      continue;
    }
    const kept = paperByHash.get(r.fileHash);
    if (kept) {
      paperAlias.set(r.id as string, kept.id);
      report.mergedPapers++;
      continue;
    }
    const p: Paper = {
      ...r,
      id: r.id as string,
      fileHash: r.fileHash,
      title: isStr(r.title) && r.title.trim() ? r.title : t.data.format.untitledPaper,
      authors: strList(r.authors),
      domainIds: strList(r.domainIds).filter((id) => domainIds.has(id)),
      pageCount: numOr(r.pageCount, 0),
      addedAt: numOr(r.addedAt, now),
    };
    if (!isNum(r.year)) delete p.year;
    if (!isNum(r.lastOpenedAt)) delete p.lastOpenedAt;
    const tags = normalizeTags(strList(r.tags));
    if (tags.length) p.tags = tags;
    else delete p.tags;
    papers.push(p);
    paperByHash.set(p.fileHash, p);
  }
  const paperById = new Map(papers.map((p) => [p.id, p]));
  const resolvePaper = (id: unknown) => (isId(id) ? paperById.get(paperAlias.get(id) ?? id) : undefined);

  // 批注
  const annotations: Annotation[] = [];
  for (const r of rowsOf("annotations")) {
    const paper = resolvePaper(r.paperId);
    if (!paper || !isNum(r.page) || r.page < 1) {
      drop("annotations");
      continue;
    }
    const q = isObj(r.quote) ? r.quote : {};
    const a: Annotation = {
      ...r,
      id: r.id as string,
      paperId: paper.id,
      page: Math.floor(r.page),
      rects: Array.isArray(r.rects) ? r.rects.filter(isRect) : [],
      quote: { exact: strOr(q.exact, ""), prefix: strOr(q.prefix, ""), suffix: strOr(q.suffix, "") },
      fileHash: isId(r.fileHash) ? r.fileHash : paper.fileHash,
      color: strOr(r.color, DEFAULT_HIGHLIGHT),
      note: strOr(r.note, ""),
      createdAt: numOr(r.createdAt, now),
      updatedAt: numOr(r.updatedAt, numOr(r.createdAt, now)),
    };
    if (!isId(r.fileHash)) report.annotationFileHash++;
    if (!ANCHOR_STATUSES.includes(r.anchorStatus as AnchorStatus)) delete a.anchorStatus;
    if (!isId(r.termId)) delete a.termId;
    annotations.push(a);
  }
  const annotationIds = new Set(annotations.map((a) => a.id));

  // 术语
  const terms: Term[] = [];
  for (const r of rowsOf("terms")) {
    if (!isStr(r.name) || !r.name.trim()) {
      drop("terms");
      continue;
    }
    const s = isObj(r.scope) ? r.scope : {};
    const scope: TermScope =
      s.kind === "domains" ? { kind: "domains", domainIds: strList(s.domainIds).filter((id) => domainIds.has(id)) } : { kind: "global" };
    const t: Term = {
      ...r,
      id: r.id as string,
      name: r.name,
      aliases: strList(r.aliases),
      matchMode: MATCH_MODES.includes(r.matchMode as MatchMode) ? (r.matchMode as MatchMode) : "auto",
      scope,
      note: strOr(r.note, ""),
      createdAt: numOr(r.createdAt, now),
      updatedAt: numOr(r.updatedAt, numOr(r.createdAt, now)),
    };
    if (r.sourceAnnotationId !== undefined && !(isId(r.sourceAnnotationId) && annotationIds.has(r.sourceAnnotationId))) {
      delete t.sourceAnnotationId;
      if (r.sourceAnnotationId !== null) report.termSource++;
    }
    terms.push(t);
  }
  const termIds = new Set(terms.map((t) => t.id));
  for (const a of annotations) {
    if (a.termId !== undefined && !termIds.has(a.termId)) {
      delete a.termId;
      report.annotationTermId++;
    }
  }

  // 自由笔记
  const notes: Note[] = [];
  for (const r of rowsOf("notes")) {
    notes.push({
      ...r,
      id: r.id as string,
      text: strOr(r.text, ""),
      createdAt: numOr(r.createdAt, now),
      updatedAt: numOr(r.updatedAt, numOr(r.createdAt, now)),
    });
  }
  const noteIds = new Set(notes.map((n) => n.id));

  /** 端点是否存在；论文引用经过合并映射 */
  const resolveRef = (ref: EntityRef | null): EntityRef | null => {
    if (!ref) return null;
    switch (ref.kind) {
      case "paper": {
        const p = resolvePaper(ref.id);
        return p ? { kind: "paper", id: p.id } : null;
      }
      case "annotation":
        return annotationIds.has(ref.id) ? ref : null;
      case "term":
        return termIds.has(ref.id) ? ref : null;
      case "note":
        return noteIds.has(ref.id) ? ref : null;
    }
  };

  // 连线
  const links: Link[] = [];
  for (const r of rowsOf("links")) {
    const from = resolveRef(asRef(r.from));
    const to = resolveRef(asRef(r.to));
    if (!from || !to) {
      drop("links");
      continue;
    }
    const l: Link = {
      ...r,
      id: r.id as string,
      from,
      to,
      relation: RELATIONS.includes(r.relation as LinkRelation) ? (r.relation as LinkRelation) : "custom",
      createdAt: numOr(r.createdAt, now),
    };
    if (!isStr(r.label)) delete l.label;
    links.push(l);
  }

  // 画布与节点
  const boards: Board[] = [];
  for (const r of rowsOf("boards")) {
    const b: Board = {
      ...r,
      id: r.id as string,
      name: isStr(r.name) && r.name.trim() ? r.name : t.data.format.untitledBoard,
      domainIds: strList(r.domainIds).filter((id) => domainIds.has(id)),
      createdAt: numOr(r.createdAt, now),
      updatedAt: numOr(r.updatedAt, numOr(r.createdAt, now)),
    };
    const vp = r.viewport;
    if (!(isObj(vp) && isNum(vp.x) && isNum(vp.y) && isNum(vp.zoom))) delete b.viewport;
    boards.push(b);
  }
  const boardIds = new Set(boards.map((b) => b.id));
  const boardNodes: BoardNode[] = [];
  for (const r of rowsOf("boardNodes")) {
    const ref = resolveRef(asRef(r.ref));
    if (!isId(r.boardId) || !boardIds.has(r.boardId) || !ref) {
      drop("boardNodes");
      continue;
    }
    const n: BoardNode = {
      ...r,
      id: r.id as string,
      boardId: r.boardId,
      ref,
      x: numOr(r.x, 0),
      y: numOr(r.y, 0),
      w: numOr(r.w, 240),
      h: numOr(r.h, 120),
    };
    if (!isStr(r.groupId)) delete n.groupId;
    boardNodes.push(n);
  }

  // 设置（跳过派生记录）
  const kv: KvRecord[] = [];
  for (const r of rowsOf("kv", "key")) {
    const key = r.key as string;
    if (isDerivedKvKey(key)) continue;
    kv.push({ key, value: r.value === undefined ? null : r.value });
  }

  return { tables: { domains, papers, annotations, terms, links, notes, boards, boardNodes, kv }, report };
}

/** 修复报告里值得告诉用户的部分（没有则为空数组） */
export function describeRepairs(r: RepairReport): string[] {
  const out: string[] = [];
  const m = t.data.format;
  for (const name of DATA_TABLE_NAMES) {
    const n = r.dropped[name];
    if (n) out.push(m.skipped(n, name));
  }
  if (r.mergedPapers) out.push(m.mergedPapers(r.mergedPapers));
  if (r.annotationTermId) out.push(m.annotationTermMissing(r.annotationTermId));
  if (r.termSource) out.push(m.termSourceMissing(r.termSource));
  return out;
}
