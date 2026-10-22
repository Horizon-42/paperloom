import { describe, expect, it } from "vitest";
import { DATA_FORMAT_VERSION } from "@/db/schema";
import {
  DataFormatError,
  describeRepairs,
  emptyTables,
  hasUserData,
  isDerivedKvKey,
  parseDataFile,
  serializeDataFile,
  serializeTables,
  type DataTables,
} from "@/services/storage/format";
import type { Annotation, Paper, Term } from "@/types/models";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function paper(id: string, fileHash: string, extra: Partial<Paper> = {}): Paper {
  return { id, fileHash, title: `T ${id}`, authors: [], domainIds: [], pageCount: 3, addedAt: 1, ...extra };
}
function annotation(id: string, paperId: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    paperId,
    page: 1,
    rects: [[1, 2, 3, 4]],
    quote: { exact: "x", prefix: "", suffix: "" },
    fileHash: H1,
    color: "#fde68a",
    note: "",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}
function term(id: string, extra: Partial<Term> = {}): Term {
  return { id, name: id, aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 1, updatedAt: 1, ...extra };
}

function fileOf(tables: Partial<Record<keyof DataTables, unknown[]>>, version = DATA_FORMAT_VERSION) {
  return JSON.stringify({ format: "paperlens", version, exportedAt: "2026-10-21T00:00:00.000Z", tables });
}

describe("序列化", () => {
  it("每条记录一行，结果可以解析回原样", () => {
    const t = emptyTables();
    t.papers.push(paper("p1", H1));
    t.terms.push(term("t1", { note: "多行\n笔记" }));
    t.kv.push({ key: "termDisplay", value: { firstOnly: true, hidden: false } });
    const tablesJson = serializeTables(t);
    expect(tablesJson.split("\n")).toContain(JSON.stringify(t.papers[0]));
    const text = serializeDataFile(tablesJson, { exportedAt: "2026-10-21T00:00:00.000Z", revision: 3 });
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ format: "paperlens", version: DATA_FORMAT_VERSION, revision: 3 });
    const { file, report } = parseDataFile(text);
    expect(file.tables).toEqual(t);
    expect(file.revision).toBe(3);
    expect(describeRepairs(report)).toEqual([]);
  });

  it("同样的数据得到同样的字符串", () => {
    const t = emptyTables();
    t.terms.push(term("t1"));
    expect(serializeTables(t)).toBe(serializeTables(structuredClone(t)));
  });
});

describe("解析与校验", () => {
  it("拒绝非 JSON、非 Paperloom 文件和更新的主版本", () => {
    expect(() => parseDataFile("{oops")).toThrow(DataFormatError);
    expect(() => parseDataFile(JSON.stringify({ format: "zotero", version: 1, tables: {} }))).toThrow("不是 Paperloom");
    expect(() => parseDataFile(JSON.stringify({ format: "paperlens", tables: {} }))).toThrow("版本");
    expect(() => parseDataFile(fileOf({}, DATA_FORMAT_VERSION + 1))).toThrow(/更新版本的 Paperloom/);
    expect(() => parseDataFile(JSON.stringify({ format: "paperlens", version: 1 }))).toThrow("数据表");
    // 同一主版本的次版本可以读
    expect(parseDataFile(fileOf({}, DATA_FORMAT_VERSION + 0.3)).file.tables.papers).toEqual([]);
  });

  it("修复引用：缺 fileHash 的批注补论文当前哈希，悬空的 termId / sourceAnnotationId 去掉", () => {
    const a1 = annotation("a1", "p1", { termId: "gone" });
    const a2 = { ...annotation("a2", "p1"), fileHash: undefined };
    const { file, report } = parseDataFile(
      fileOf({
        papers: [paper("p1", H2)],
        annotations: [a1, a2, annotation("a3", "missing-paper")],
        terms: [term("t1", { sourceAnnotationId: "nope" }), term("t2", { sourceAnnotationId: "a1" })],
      }),
    );
    const byId = new Map(file.tables.annotations.map((a) => [a.id, a]));
    expect(byId.get("a1")!.termId).toBeUndefined();
    expect(byId.get("a2")!.fileHash).toBe(H2);
    expect(byId.has("a3")).toBe(false);
    expect(file.tables.terms.find((t) => t.id === "t1")!.sourceAnnotationId).toBeUndefined();
    expect(file.tables.terms.find((t) => t.id === "t2")!.sourceAnnotationId).toBe("a1");
    expect(report).toMatchObject({ annotationFileHash: 1, annotationTermId: 1, termSource: 1, dropped: { annotations: 1 } });
    expect(describeRepairs(report).join("\n")).toContain("跳过 1 条无效或引用缺失的批注");
  });

  it("端点不存在的连线和画布节点丢弃；领域引用修正", () => {
    const { file, report } = parseDataFile(
      fileOf({
        domains: [
          { id: "d1", name: "ATM", parentId: "ghost", color: "#000", order: 0 },
          { id: "d2", name: "轨迹预测", parentId: "d1", color: "#000", order: 0 },
        ],
        papers: [paper("p1", H1, { domainIds: ["d2", "ghost"] })],
        terms: [term("t1", { scope: { kind: "domains", domainIds: ["d1", "ghost"] } })],
        notes: [{ id: "n1", text: "x", createdAt: 1, updatedAt: 1 }],
        links: [
          { id: "l1", from: { kind: "term", id: "t1" }, to: { kind: "note", id: "n1" }, relation: "supports", createdAt: 1 },
          { id: "l2", from: { kind: "term", id: "t1" }, to: { kind: "annotation", id: "gone" }, relation: "supports", createdAt: 1 },
          { id: "l3", from: { kind: "bogus", id: "t1" }, to: { kind: "note", id: "n1" }, relation: "supports", createdAt: 1 },
        ],
        boards: [{ id: "b1", name: "画布", domainIds: [], createdAt: 1, updatedAt: 1 }],
        boardNodes: [
          { id: "bn1", boardId: "b1", ref: { kind: "paper", id: "p1" }, x: 0, y: 0, w: 1, h: 1 },
          { id: "bn2", boardId: "nope", ref: { kind: "paper", id: "p1" }, x: 0, y: 0, w: 1, h: 1 },
          { id: "bn3", boardId: "b1", ref: { kind: "term", id: "gone" }, x: 0, y: 0, w: 1, h: 1 },
        ],
      }),
    );
    expect(file.tables.domains.find((d) => d.id === "d1")!.parentId).toBeNull();
    expect(file.tables.papers[0].domainIds).toEqual(["d2"]);
    expect(file.tables.terms[0].scope).toEqual({ kind: "domains", domainIds: ["d1"] });
    expect(file.tables.links.map((l) => l.id)).toEqual(["l1"]);
    expect(file.tables.boardNodes.map((n) => n.id)).toEqual(["bn1"]);
    expect(report.dropped).toMatchObject({ links: 2, boardNodes: 2 });
  });

  it("同一 PDF 的重复论文合并，批注改指向保留的那篇", () => {
    const { file, report } = parseDataFile(
      fileOf({ papers: [paper("p1", H1), paper("p2", H1)], annotations: [annotation("a1", "p2")] }),
    );
    expect(file.tables.papers.map((p) => p.id)).toEqual(["p1"]);
    expect(file.tables.annotations[0].paperId).toBe("p1");
    expect(report.mergedPapers).toBe(1);
  });

  it("跳过派生的 kv，保留用户设置和未知字段", () => {
    const { file } = parseDataFile(
      fileOf({
        kv: [
          { key: "termDisplay", value: { firstOnly: true } },
          { key: "indexer:paper:p1", value: {} },
          { key: "storage:lastExportAt", value: 1 },
        ],
        terms: [{ ...term("t1"), futureField: 42 }],
      }),
    );
    expect(file.tables.kv).toEqual([{ key: "termDisplay", value: { firstOnly: true } }]);
    expect((file.tables.terms[0] as unknown as { futureField: number }).futureField).toBe(42);
  });

  it("无效记录丢弃并计数，默认值补齐", () => {
    const { file, report } = parseDataFile(
      fileOf({
        papers: [{ id: "p1", fileHash: H1 }, { id: "", fileHash: H2 }, "junk", { id: "p3" }],
        terms: [{ id: "t1", name: "LSTM", matchMode: "weird" }, { id: "t1", name: "dup" }, { id: "t3", name: "  " }],
      }),
    );
    expect(file.tables.papers).toEqual([expect.objectContaining({ id: "p1", title: "未命名论文", authors: [], domainIds: [], pageCount: 0 })]);
    expect(file.tables.terms).toEqual([expect.objectContaining({ id: "t1", matchMode: "auto", aliases: [], scope: { kind: "global" } })]);
    expect(report.dropped).toMatchObject({ papers: 3, terms: 2 });
  });
});

describe("工具函数", () => {
  it("派生 kv 与是否有数据", () => {
    expect(isDerivedKvKey("indexer:termStats")).toBe(true);
    expect(isDerivedKvKey("storage:lastExportAt")).toBe(true);
    expect(isDerivedKvKey("termDisplay")).toBe(false);
    expect(hasUserData({ kv: 3, boardNodes: 2 })).toBe(false);
    expect(hasUserData({ terms: 1 })).toBe(true);
    expect(hasUserData(null)).toBe(false);
  });
});
