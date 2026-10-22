// 术语与批注导出为 Markdown（Obsidian 友好，开发文档 F4.1、§8"导出到 Obsidian"）。纯函数，可在 Worker 中运行。
//   terms/<术语名>.md   frontmatter（aliases、scope、domains、tags）+ 笔记 + "## 出现于"（[[论文]] 与出现次数）
//   papers/<标题>.md    frontmatter（作者、年份、领域、标签）+ 每条批注（页码、引文、笔记、关联术语）
// 文件名去掉非法字符、限制长度，重名（不区分大小写）时加 " (2)"。
// 标题和说明文字跟随界面语言（t.data.markdown；在 Worker 里由 Worker 名带入语言），切换语言后下一次保存按新语言重写。
// 文件名、目录名（terms/、papers/）和 frontmatter 的键与语言无关；只有标题清理后为空时的后备文件名"未命名"随语言变化。
import { t as ui } from "@/i18n";
import { domainPathNames } from "@/services/domainTree";
import type { Annotation, Domain, Occurrence, Paper, Term } from "@/types/models";
import type { DataTables } from "./format";

export interface MarkdownInput {
  tables: Pick<DataTables, "domains" | "papers" | "annotations" | "terms">;
  occurrences: Pick<Occurrence, "termId" | "paperId" | "pages" | "count">[];
}

export interface MarkdownFile {
  /** 相对 markdown/ 的路径 */
  name: string;
  content: string;
}

// ---------- 文件名 ----------

/** 文件系统或 Obsidian 链接不允许的字符：路径分隔、Windows 保留字符、控制字符，以及 Obsidian 的 # ^ [ ] | */
const ILLEGAL = /[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g;

function utf8Length(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const n = utf8Length(ch.codePointAt(0)!);
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/**
 * 标题清理后为空时的文件名主干。与界面语言无关：文件名随语言变化会让 Obsidian 里的链接失效
 */
export const UNTITLED_FILE = "untitled";

/** 标题 → 安全的文件名主干（不含扩展名）。限制在 maxBytes 字节内（多数文件系统单个文件名上限 255 字节） */
export function safeFileName(raw: string, maxBytes = 150): string {
  let s = raw.normalize("NFC").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[.\s]+/, ""); // 开头的点会变成隐藏文件
  s = truncateUtf8(s, maxBytes).replace(/[.\s]+$/, ""); // Windows 不允许结尾的点和空格
  if (!s) s = UNTITLED_FILE;
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += "_";
  return s;
}

const fold = (s: string) => s.normalize("NFC").toLowerCase();

/** 按给定顺序分配不重复（不区分大小写）的文件名主干 */
export function assignFileNames<T>(items: T[], titleOf: (x: T) => string, used = new Set<string>()): Map<T, string> {
  const out = new Map<T, string>();
  for (const item of items) {
    const base = safeFileName(titleOf(item));
    let name = base;
    for (let i = 2; used.has(fold(name)); i++) name = `${base} (${i})`;
    used.add(fold(name));
    out.set(item, name);
  }
  return out;
}

export interface MarkdownFileNames {
  /** 论文 id → papers/ 下的文件名主干（不含 .md） */
  papers: Map<string, string>;
  /** 术语 id → terms/ 下的文件名主干 */
  terms: Map<string, string>;
}

const byAdded = (a: Pick<Paper, "id" | "addedAt">, b: Pick<Paper, "id" | "addedAt">) => a.addedAt - b.addedAt || a.id.localeCompare(b.id);
const byCreated = (a: Pick<Term, "id" | "createdAt">, b: Pick<Term, "id" | "createdAt">) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * data/markdown/ 里每篇论文、每个术语的文件名（[[papers/<名>]]、[[terms/<名>]] 链接的目标）。
 * 论文按导入时间、术语按创建时间排序后分配，重名的后来者加序号，所以同样的数据得到同样的名字。
 * 画布导出的 wiki 链接也用它，保证指向同一批文件。
 */
export function markdownFileNames(
  papers: readonly Pick<Paper, "id" | "title" | "addedAt">[],
  terms: readonly Pick<Term, "id" | "name" | "createdAt">[],
): MarkdownFileNames {
  const sp = [...papers].sort(byAdded);
  const st = [...terms].sort(byCreated);
  const pn = assignFileNames(sp, (p) => p.title);
  const tn = assignFileNames(st, (t) => t.name);
  return { papers: new Map(sp.map((p) => [p.id, pn.get(p)!])), terms: new Map(st.map((t) => [t.id, tn.get(t)!])) };
}

// ---------- 文本工具 ----------

const pad = (n: number) => String(n).padStart(2, "0");
function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YAML 双引号字符串（JSON 字符串是合法的 YAML） */
const yq = (s: string) => JSON.stringify(s);

function yamlList(key: string, values: string[]): string[] {
  if (!values.length) return [];
  return [`${key}:`, ...values.map((v) => `  - ${yq(v)}`)];
}

/** Obsidian 标签：字母、数字、_、-、/，不能全是数字 */
function tagOf(path: string[]): string | null {
  const segs = path.map((s) => s.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "")).filter(Boolean);
  if (!segs.length) return null;
  const tag = segs.join("/");
  return /^[\d/]+$/.test(tag) ? `_${tag}` : tag;
}

/** 引文中的 Markdown 语法字符转义，避免被渲染成格式或公式 */
function escapeInline(s: string): string {
  return s.replace(/([\\`*_[\]<>#|~$])/g, "\\$1");
}

/** wiki 链接显示文字不能含 | 和方括号 */
const linkText = (s: string) => s.replace(/[|[\]]+/g, " ").replace(/\s+/g, " ").trim();

function blockquote(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  return lines.map((l) => `> ${escapeInline(l)}`.trimEnd()).join("\n");
}

function pageList(pages: number[], max = 12): string {
  return ui.data.markdown.pages(pages.slice(0, max), pages.length > max);
}

/** 领域路径列表："A / B；C"（英文用 "; "） */
const domainList = (paths: string[][]) => ui.data.markdown.longList(paths.map((p) => p.join(" / ")));

function compareAnnotations(a: Annotation, b: Annotation): number {
  if (a.page !== b.page) return a.page - b.page;
  // PDF 坐标原点在左下角：y 越大越靠上
  const ya = a.rects[0]?.[3] ?? Infinity;
  const yb = b.rects[0]?.[3] ?? Infinity;
  if (ya !== yb) return yb - ya;
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

// ---------- 生成 ----------

interface Model {
  domainById: Map<string, Domain>;
  papers: Paper[];
  terms: Term[];
  /** id → 文件名主干 */
  paperName: Map<string, string>;
  termName: Map<string, string>;
  termById: Map<string, Term>;
  paperById: Map<string, Paper>;
  annotationsByPaper: Map<string, Annotation[]>;
  occByTerm: Map<string, MarkdownInput["occurrences"]>;
}

function buildModel(input: MarkdownInput): Model {
  const { domains, papers, annotations, terms } = input.tables;
  const sortedPapers = [...papers].sort(byAdded);
  const sortedTerms = [...terms].sort(byCreated);
  const names = markdownFileNames(papers, terms);
  const annotationsByPaper = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const list = annotationsByPaper.get(a.paperId);
    if (list) list.push(a);
    else annotationsByPaper.set(a.paperId, [a]);
  }
  for (const list of annotationsByPaper.values()) list.sort(compareAnnotations);
  const paperById = new Map(papers.map((p) => [p.id, p]));
  const occByTerm = new Map<string, MarkdownInput["occurrences"]>();
  for (const o of input.occurrences) {
    if (!paperById.has(o.paperId) || o.count <= 0) continue;
    const list = occByTerm.get(o.termId);
    if (list) list.push(o);
    else occByTerm.set(o.termId, [o]);
  }
  return {
    domainById: new Map(domains.map((d) => [d.id, d])),
    papers: sortedPapers,
    terms: sortedTerms,
    paperName: names.papers,
    termName: names.terms,
    termById: new Map(terms.map((t) => [t.id, t])),
    paperById,
    annotationsByPaper,
    occByTerm,
  };
}

function domainPaths(m: Model, ids: string[]): string[][] {
  return ids.filter((id) => m.domainById.has(id)).map((id) => domainPathNames(m.domainById, id));
}

function termOccurrences(m: Model, t: Term) {
  const occ = [...(m.occByTerm.get(t.id) ?? [])];
  occ.sort((a, b) => b.count - a.count || m.paperById.get(a.paperId)!.title.localeCompare(m.paperById.get(b.paperId)!.title));
  return occ;
}

function termFile(m: Model, t: Term): string {
  const base = m.termName.get(t.id)!;
  const paths = t.scope.kind === "domains" ? domainPaths(m, t.scope.domainIds) : [];
  const aliases = [...t.aliases];
  if (base !== t.name && !aliases.includes(t.name)) aliases.unshift(t.name); // 文件名被改过时，用原名也能链接到
  const tags = ["paperlens/term", ...paths.map(tagOf).filter((x): x is string => !!x)];
  const front = [
    "---",
    ...yamlList("aliases", aliases),
    `scope: ${t.scope.kind === "domains" ? "domains" : "global"}`,
    ...yamlList(
      "domains",
      paths.map((p) => p.join("/")),
    ),
    ...yamlList("tags", tags),
    `paperlens-id: ${yq(t.id)}`,
    `created: ${day(t.createdAt)}`,
    `updated: ${day(t.updatedAt)}`,
    "---",
  ];
  const L = ui.data.markdown;
  const body = [`# ${t.name}`, ""];
  if (t.aliases.length) body.push(L.field(L.aliases, L.list(t.aliases)), "");
  if (t.scope.kind === "domains") body.push(L.field(L.scope, paths.length ? domainList(paths) : L.domainDeleted), "");
  body.push(t.note.trim() ? t.note.trim() : L.noNote, "");
  const occ = termOccurrences(m, t);
  body.push(`## ${L.appearsIn}`, "");
  if (!occ.length) body.push(L.notFoundYet);
  for (const o of occ) {
    const p = m.paperById.get(o.paperId)!;
    body.push(`- [[papers/${m.paperName.get(p.id)}|${linkText(p.title)}]] · ${L.occurrences(o.count, pageList(o.pages))}`);
  }
  return `${[...front, "", ...body].join("\n").trimEnd()}\n`;
}

function annotationBlock(m: Model, a: Annotation, termLink: (t: Term) => string): string[] {
  const L = ui.data.markdown;
  const out: string[] = [];
  if (a.quote.exact.trim()) out.push(blockquote(a.quote.exact), "");
  if (a.anchorStatus === "orphaned") out.push(L.orphaned, "");
  if (a.note.trim()) out.push(a.note.trim(), "");
  const term = a.termId ? m.termById.get(a.termId) : undefined;
  if (term) out.push(L.field(L.term, termLink(term)), "");
  return out;
}

function paperFile(m: Model, p: Paper): string {
  const paths = domainPaths(m, p.domainIds);
  const userTags = p.tags ?? [];
  const tags = [
    ...new Set(["paperlens/paper", ...[...paths, ...userTags.map((t) => [t])].map(tagOf).filter((x): x is string => !!x)]),
  ];
  const front = [
    "---",
    `title: ${yq(p.title)}`,
    ...yamlList("authors", p.authors),
    ...(p.year !== undefined ? [`year: ${p.year}`] : []),
    ...yamlList(
      "domains",
      paths.map((x) => x.join("/")),
    ),
    ...yamlList("tags", tags),
    `paperlens-id: ${yq(p.id)}`,
    `file-hash: ${yq(p.fileHash)}`,
    `added: ${day(p.addedAt)}`,
    "---",
  ];
  const L = ui.data.markdown;
  const meta: string[] = [];
  if (p.authors.length) meta.push(`- ${L.field(L.authors, L.authorList(p.authors))}`);
  if (p.year !== undefined) meta.push(`- ${L.field(L.year, String(p.year))}`);
  if (paths.length) meta.push(`- ${L.field(L.domains, escapeInline(domainList(paths)))}`);
  if (userTags.length) meta.push(`- ${L.field(L.tags, escapeInline(L.list(userTags)))}`);
  if (p.pageCount) meta.push(`- ${L.field(L.pageCount, String(p.pageCount))}`);
  const body = [`# ${p.title}`, ""];
  if (meta.length) body.push(...meta, "");
  const anns = m.annotationsByPaper.get(p.id) ?? [];
  body.push(`## ${L.annotations(anns.length)}`, "");
  if (!anns.length) body.push(L.noAnnotations, "");
  let page = 0;
  const termLink = (t: Term) => `[[terms/${m.termName.get(t.id)}|${linkText(t.name)}]]`;
  for (const a of anns) {
    if (a.page !== page) {
      page = a.page;
      body.push(`### ${L.page(page)}`, "");
    }
    body.push(...annotationBlock(m, a, termLink));
  }
  return `${[...front, "", ...body].join("\n").trimEnd()}\n`;
}

/** data/markdown/ 下的全部文件 */
export function buildMarkdownFiles(input: MarkdownInput): MarkdownFile[] {
  const m = buildModel(input);
  const files: MarkdownFile[] = [{ name: "README.md", content: ui.data.markdown.readme }];
  for (const t of m.terms) files.push({ name: `terms/${m.termName.get(t.id)}.md`, content: termFile(m, t) });
  for (const p of m.papers) files.push({ name: `papers/${m.paperName.get(p.id)}.md`, content: paperFile(m, p) });
  return files;
}

/** 没有本地服务时下载的单个合并文件 */
export function buildCombinedMarkdown(input: MarkdownInput, exportedAt: number): string {
  const m = buildModel(input);
  const L = ui.data.markdown;
  const out: string[] = [`# ${L.combinedTitle}`, "", L.combinedSummary(day(exportedAt), m.terms.length, m.papers.length), ""];
  out.push(`## ${L.terms}`, "");
  if (!m.terms.length) out.push(L.noTerms, "");
  for (const t of m.terms) {
    out.push(`### ${t.name}`, "");
    const facts: string[] = [];
    if (t.aliases.length) facts.push(L.field(L.aliases, L.list(t.aliases)));
    if (t.scope.kind === "domains") {
      const paths = domainPaths(m, t.scope.domainIds);
      facts.push(L.field(L.scope, paths.length ? domainList(paths) : L.domainDeleted));
    }
    if (facts.length) out.push(facts.join(" · "), "");
    if (t.note.trim()) out.push(t.note.trim(), "");
    const occ = termOccurrences(m, t);
    if (occ.length) out.push(L.field(L.appearsIn, L.longList(occ.map((o) => L.countIn(m.paperById.get(o.paperId)!.title, o.count)))), "");
  }
  out.push(`## ${L.papersAndAnnotations}`, "");
  if (!m.papers.length) out.push(L.noPapers, "");
  for (const p of m.papers) {
    out.push(`### ${p.title}`, "");
    const facts: string[] = [];
    if (p.authors.length) facts.push(L.field(L.authors, L.authorList(p.authors)));
    if (p.year !== undefined) facts.push(L.field(L.year, String(p.year)));
    const paths = domainPaths(m, p.domainIds);
    if (paths.length) facts.push(L.field(L.domains, escapeInline(domainList(paths))));
    if (p.tags?.length) facts.push(L.field(L.tags, escapeInline(L.list(p.tags))));
    if (facts.length) out.push(facts.join(" · "), "");
    let page = 0;
    for (const a of m.annotationsByPaper.get(p.id) ?? []) {
      if (a.page !== page) {
        page = a.page;
        out.push(`#### ${L.page(page)}`, "");
      }
      out.push(...annotationBlock(m, a, (t) => `**${t.name}**`));
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}
