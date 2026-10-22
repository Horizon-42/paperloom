// 术语与批注导出为 Markdown（Obsidian 友好，开发文档 F4.1、§8"导出到 Obsidian"）。纯函数，可在 Worker 中运行。
//   terms/<术语名>.md   frontmatter（aliases、scope、domains、tags）+ 笔记 + "## 出现于"（[[论文]] 与出现次数）
//   papers/<标题>.md    frontmatter（作者、年份、领域、标签）+ 每条批注（页码、引文、笔记、关联术语）
// 文件名去掉非法字符、限制长度，重名（不区分大小写）时加 " (2)"。
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

/** 标题 → 安全的文件名主干（不含扩展名）。限制在 maxBytes 字节内（多数文件系统单个文件名上限 255 字节） */
export function safeFileName(raw: string, maxBytes = 150): string {
  let s = raw.normalize("NFC").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[.\s]+/, ""); // 开头的点会变成隐藏文件
  s = truncateUtf8(s, maxBytes).replace(/[.\s]+$/, ""); // Windows 不允许结尾的点和空格
  if (!s) s = "未命名";
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
  const shown = pages.slice(0, max).join("、");
  return pages.length > max ? `${shown} 等` : shown;
}

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
  const body = [`# ${t.name}`, ""];
  if (t.aliases.length) body.push(`别名：${t.aliases.join("、")}`, "");
  if (t.scope.kind === "domains") body.push(`作用范围：${paths.length ? paths.map((p) => p.join(" / ")).join("；") : "（领域已删除）"}`, "");
  body.push(t.note.trim() ? t.note.trim() : "_（还没有笔记）_", "");
  const occ = termOccurrences(m, t);
  body.push("## 出现于", "");
  if (!occ.length) body.push("_（还没有在文库中找到）_");
  for (const o of occ) {
    const p = m.paperById.get(o.paperId)!;
    body.push(`- [[papers/${m.paperName.get(p.id)}|${linkText(p.title)}]] · ${o.count} 次（第 ${pageList(o.pages)} 页）`);
  }
  return `${[...front, "", ...body].join("\n").trimEnd()}\n`;
}

function annotationBlock(m: Model, a: Annotation, termLink: (t: Term) => string): string[] {
  const out: string[] = [];
  if (a.quote.exact.trim()) out.push(blockquote(a.quote.exact), "");
  if (a.anchorStatus === "orphaned") out.push("_（换过 PDF 文件后未找到这段原文）_", "");
  if (a.note.trim()) out.push(a.note.trim(), "");
  const term = a.termId ? m.termById.get(a.termId) : undefined;
  if (term) out.push(`术语：${termLink(term)}`, "");
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
  const meta: string[] = [];
  if (p.authors.length) meta.push(`- 作者：${p.authors.join("、")}`);
  if (p.year !== undefined) meta.push(`- 年份：${p.year}`);
  if (paths.length) meta.push(`- 领域：${escapeInline(paths.map((x) => x.join(" / ")).join("；"))}`);
  if (userTags.length) meta.push(`- 标签：${escapeInline(userTags.join("、"))}`);
  if (p.pageCount) meta.push(`- 页数：${p.pageCount}`);
  const body = [`# ${p.title}`, ""];
  if (meta.length) body.push(...meta, "");
  const anns = m.annotationsByPaper.get(p.id) ?? [];
  body.push(`## 批注（${anns.length}）`, "");
  if (!anns.length) body.push("_（还没有批注）_", "");
  let page = 0;
  const termLink = (t: Term) => `[[terms/${m.termName.get(t.id)}|${linkText(t.name)}]]`;
  for (const a of anns) {
    if (a.page !== page) {
      page = a.page;
      body.push(`### 第 ${page} 页`, "");
    }
    body.push(...annotationBlock(m, a, termLink));
  }
  return `${[...front, "", ...body].join("\n").trimEnd()}\n`;
}

const README = `# Paperloom 笔记

此目录由 Paperloom 自动生成，每次保存时更新：

- \`terms/\`：每个术语一个文件（别名、作用范围、笔记、出现在哪些论文）
- \`papers/\`：每篇论文一个文件（元数据和全部批注）

在这里直接修改的内容会在下次保存时被覆盖，请在 Paperloom 中编辑。可以把这个目录作为 Obsidian 仓库打开。
`;

/** data/markdown/ 下的全部文件 */
export function buildMarkdownFiles(input: MarkdownInput): MarkdownFile[] {
  const m = buildModel(input);
  const files: MarkdownFile[] = [{ name: "README.md", content: README }];
  for (const t of m.terms) files.push({ name: `terms/${m.termName.get(t.id)}.md`, content: termFile(m, t) });
  for (const p of m.papers) files.push({ name: `papers/${m.paperName.get(p.id)}.md`, content: paperFile(m, p) });
  return files;
}

/** 没有本地服务时下载的单个合并文件 */
export function buildCombinedMarkdown(input: MarkdownInput, exportedAt: number): string {
  const m = buildModel(input);
  const out: string[] = ["# Paperloom 导出", "", `导出时间：${day(exportedAt)}；术语 ${m.terms.length} 个，论文 ${m.papers.length} 篇。`, ""];
  out.push("## 术语", "");
  if (!m.terms.length) out.push("_（没有术语）_", "");
  for (const t of m.terms) {
    out.push(`### ${t.name}`, "");
    const facts: string[] = [];
    if (t.aliases.length) facts.push(`别名：${t.aliases.join("、")}`);
    if (t.scope.kind === "domains") {
      const paths = domainPaths(m, t.scope.domainIds);
      facts.push(`作用范围：${paths.length ? paths.map((p) => p.join(" / ")).join("；") : "（领域已删除）"}`);
    }
    if (facts.length) out.push(facts.join(" · "), "");
    if (t.note.trim()) out.push(t.note.trim(), "");
    const occ = termOccurrences(m, t);
    if (occ.length) out.push(`出现于：${occ.map((o) => `${m.paperById.get(o.paperId)!.title}（${o.count} 次）`).join("；")}`, "");
  }
  out.push("## 论文与批注", "");
  if (!m.papers.length) out.push("_（没有论文）_", "");
  for (const p of m.papers) {
    out.push(`### ${p.title}`, "");
    const facts: string[] = [];
    if (p.authors.length) facts.push(`作者：${p.authors.join("、")}`);
    if (p.year !== undefined) facts.push(`年份：${p.year}`);
    const paths = domainPaths(m, p.domainIds);
    if (paths.length) facts.push(`领域：${escapeInline(paths.map((x) => x.join(" / ")).join("；"))}`);
    if (p.tags?.length) facts.push(`标签：${escapeInline(p.tags.join("、"))}`);
    if (facts.length) out.push(facts.join(" · "), "");
    let page = 0;
    for (const a of m.annotationsByPaper.get(p.id) ?? []) {
      if (a.page !== page) {
        page = a.page;
        out.push(`#### 第 ${page} 页`, "");
      }
      out.push(...annotationBlock(m, a, (t) => `**${t.name}**`));
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}
