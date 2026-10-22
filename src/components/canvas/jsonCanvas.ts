// 导出为 JSON Canvas 1.0（Obsidian .canvas 使用的开放格式，https://jsoncanvas.org/spec/1.0/）。纯函数。
// 批注、术语、论文、自由笔记都导出为 text 节点（内容为 Markdown，带原文和出处）；边的 label 用关系名。
// 论文、术语带 Obsidian 双链，指向存储模块导出的 data/markdown/papers|terms/<名称>.md（文件名规则与之相同）。
import { t } from "@/i18n";
import type { CanvasExportData } from "@/services/canvasService";
import { UNTITLED_FILE, markdownFileNames, safeFileName } from "@/services/storage/markdown";
import type { Annotation, Board, BoardNode, Note, Paper, Term } from "@/types/models";
import { RELATION_STYLE, linksToEdges, relationText } from "./model";

export type CanvasSide = "top" | "right" | "bottom" | "left";

export interface JsonCanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
}

export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasSide;
  fromEnd?: "none" | "arrow";
  toNode: string;
  toSide?: CanvasSide;
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
}

export interface JsonCanvas {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
}

/** 已删除条目的占位文字（导出时的界面语言） */
const missingText = (kind: BoardNode["ref"]["kind"]) => t.canvas.export.missing(t.canvas.entity.deleted[kind]);

const quoteBlock = (s: string) =>
  s
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");

/** 论文、术语在 data/markdown/ 下的文件名主干（id → 名称），与存储模块的 Markdown 导出一致 */
export interface MarkdownNames {
  papers: ReadonlyMap<string, string>;
  terms: ReadonlyMap<string, string>;
}

/** 文件名映射直接用存储模块的 markdownFileNames（与 data/markdown/ 的文件名同一来源）；保留旧名供已有调用 */
export const markdownNames: (
  papers: readonly Pick<Paper, "id" | "title" | "addedAt">[],
  terms: readonly Pick<Term, "id" | "name" | "createdAt">[],
) => MarkdownNames = markdownFileNames;

const linkText = (s: string) => s.replace(/[|[\]]+/g, " ").replace(/\s+/g, " ").trim();
const wiki = (dir: "papers" | "terms", file: string | undefined, text: string) => (file ? `[[${dir}/${file}|${linkText(text)}]]` : text);

function annotationText(a: Annotation, paper: Paper | undefined, names?: MarkdownNames): string {
  const parts = [quoteBlock(a.quote.exact || t.canvas.entity.noQuote)];
  if (a.note.trim()) parts.push(a.note.trim());
  const title = paper ? wiki("papers", names?.papers.get(paper.id), paper.title) : t.canvas.entity.unknownPaper;
  parts.push(t.canvas.export.source(title, a.page));
  return parts.join("\n\n");
}

function termText(term: Term, names?: MarkdownNames): string {
  const head = [`### ${wiki("terms", names?.terms.get(term.id), term.name)}`];
  if (term.aliases.length) head.push(t.canvas.export.aliases(t.canvas.join(term.aliases)));
  const parts = [head.join("\n")];
  if (term.note.trim()) parts.push(term.note.trim());
  return parts.join("\n\n");
}

function paperText(p: Paper, names?: MarkdownNames): string {
  const meta = [p.authors.join(", "), p.year].filter(Boolean).join(" · ");
  const title = `### ${wiki("papers", names?.papers.get(p.id), p.title)}`;
  return meta ? `${title}\n${meta}` : title;
}

const noteText = (n: Note) => n.text;

/** 从 a 看 b 在哪一侧（按中心连线穿出 a 的哪条边） */
export function sideToward(a: Pick<BoardNode, "x" | "y" | "w" | "h">, b: Pick<BoardNode, "x" | "y" | "w" | "h">): CanvasSide {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dx) * a.h >= Math.abs(dy) * a.w) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** 把一块画布转成 JSON Canvas 对象。连线只导出两端都在这块画布上的。names 缺省时论文/术语不带双链 */
export function toJsonCanvas(boardId: string, data: CanvasExportData, names?: MarkdownNames): JsonCanvas {
  const annotations = new Map(data.annotations.map((a) => [a.id, a]));
  const terms = new Map(data.terms.map((x) => [x.id, x]));
  const papers = new Map(data.papers.map((p) => [p.id, p]));
  const notes = new Map(data.notes.map((n) => [n.id, n]));
  const boardNodes = data.nodes
    .filter((n) => n.boardId === boardId)
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));

  const nodes: JsonCanvasNode[] = boardNodes.map((n) => {
    const base = { id: n.id, type: "text" as const, x: Math.round(n.x), y: Math.round(n.y), width: Math.round(n.w), height: Math.round(n.h) };
    const { kind, id } = n.ref;
    if (kind === "annotation") {
      const a = annotations.get(id);
      return a ? { ...base, color: a.color, text: annotationText(a, papers.get(a.paperId), names) } : { ...base, text: missingText(kind) };
    }
    if (kind === "term") {
      const term = terms.get(id);
      return { ...base, text: term ? termText(term, names) : missingText(kind) };
    }
    if (kind === "paper") {
      const p = papers.get(id);
      return { ...base, text: p ? paperText(p, names) : missingText(kind) };
    }
    const note = notes.get(id);
    return { ...base, text: note ? noteText(note) : missingText(kind) };
  });

  const byId = new Map(boardNodes.map((n) => [n.id, n]));
  const edges: JsonCanvasEdge[] = linksToEdges(data.links, boardNodes).map((e) => {
    const s = byId.get(e.source)!;
    const tg = byId.get(e.target)!;
    const style = RELATION_STYLE[e.link.relation] ?? RELATION_STYLE.custom;
    const edge: JsonCanvasEdge = {
      id: e.id,
      fromNode: e.source,
      fromSide: sideToward(s, tg),
      toNode: e.target,
      toSide: sideToward(tg, s),
      color: style.color,
      label: relationText(e.link),
    };
    if (!style.arrow) edge.toEnd = "none";
    return edge;
  });
  return { nodes, edges };
}

export function serializeJsonCanvas(c: JsonCanvas): string {
  return `${JSON.stringify(c, null, "\t")}\n`;
}

// ---------- 文件名 ----------

/** 文件名主干的字节上限：加上 " (99)" 和 ".canvas" 后不超过存储模块的 200 字节（extraNames） */
const MAX_STEM_BYTES = 180;

/**
 * 画布名 → 合法文件名主干（不含扩展名）：与存储模块的 Markdown 文件名规则相同，按 UTF-8 字节截断。
 * 清理后为空时用 fallback（与界面语言无关，理由同 UNTITLED_FILE）
 */
export function sanitizeFileName(name: string, fallback = "untitled canvas"): string {
  const out = safeFileName(name, MAX_STEM_BYTES);
  // safeFileName 在名称清理后为空时返回 UNTITLED_FILE；画布本来就叫这个名字时保留
  return out === UNTITLED_FILE && name.trim() !== UNTITLED_FILE ? fallback : out;
}

/**
 * 每块画布的 .canvas 文件名（boardId → 文件名）。同名（不区分大小写）的按创建先后加 " (2)"、" (3)"，
 * 这样画布顺序不变时文件名稳定。
 */
export function canvasFileNames(boards: readonly Pick<Board, "id" | "name" | "createdAt">[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const sorted = [...boards].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const b of sorted) {
    const base = sanitizeFileName(b.name);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`;
    used.add(name.toLowerCase());
    out.set(b.id, `${name}.canvas`);
  }
  return out;
}

