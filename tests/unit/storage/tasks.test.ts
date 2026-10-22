// @vitest-environment node
// 存储任务与真实的本地服务（临时目录）联调：保存、冲突、恢复、PDF 上传与取回、Markdown、导入导出往返。
// node 环境：jsdom 的 Blob 经 fake-indexeddb 结构化克隆后会变成普通对象
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import { sha256Hex } from "@/lib/hash";
import { createStorageApi } from "@/services/storage/api";
import { serializeTables } from "@/services/storage/format";
import { readDataTables } from "@/services/storage/snapshot";
import { storageTasks as T, type FolderState, type TaskContext } from "@/services/storage/tasks";
import type { Annotation, Paper, Term } from "@/types/models";

// app 的 tsconfig 不含 Node 类型：服务端测试工具与 fs 按需动态导入
interface TestServer {
  dataDir: string;
  base: string;
  close(): Promise<void>;
}
interface NodeFs {
  readFileSync(p: string, enc: "utf8"): string;
  writeFileSync(p: string, data: string | Uint8Array): void;
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
}
const harnessPath = "./node/harness.ts";
const fsPath = "node:fs";
const { startTestServer } = (await import(/* @vite-ignore */ harnessPath)) as { startTestServer: () => Promise<TestServer> };
const fs = (await import(/* @vite-ignore */ fsPath)) as NodeFs;

let server: TestServer;
let ctx: TaskContext;
const NO_FOLDER: FolderState = { exists: false, hasData: false, revision: 0, contentHash: null, unreadable: false };
/** 已知的文件夹状态（contentHash 缺省为 null：不知道文件夹里是哪份数据） */
const folderAt = (revision: number, extra: Partial<FolderState> = {}): FolderState => ({
  exists: true,
  hasData: true,
  revision,
  contentHash: null,
  unreadable: false,
  ...extra,
});

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  server = await startTestServer();
  ctx = { db, api: createStorageApi(server.base) };
});
afterEach(() => server.close());

const pdfBytes = (s: string) => new TextEncoder().encode(`%PDF-1.7\n${s}\n%%EOF`);

async function addPaper(id: string, body = id): Promise<Paper> {
  const bytes = pdfBytes(body);
  const hash = await sha256Hex(bytes.buffer as ArrayBuffer);
  const p: Paper = { id, fileHash: hash, title: `Paper ${id}`, authors: ["A"], domainIds: [], pageCount: 2, addedAt: Date.now() };
  await db.files.put({ hash, blob: new Blob([bytes], { type: "application/pdf" }), size: bytes.length });
  await db.papers.put(p);
  return p;
}

const term = (id: string, name = id): Term => ({
  id,
  name,
  aliases: [],
  matchMode: "auto",
  scope: { kind: "global" },
  note: `笔记 ${name}`,
  createdAt: 1,
  updatedAt: 1,
});

const annotation = (id: string, p: Paper, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  paperId: p.id,
  page: 1,
  rects: [[10, 10, 50, 20]],
  quote: { exact: "hello", prefix: "", suffix: "" },
  fileHash: p.fileHash,
  color: "#fde68a",
  note: "批注",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const libraryFile = () => `${server.dataDir}/library.json`;
const readLibrary = () => JSON.parse(fs.readFileSync(libraryFile(), "utf8")) as { revision: number; tables: Record<string, unknown[]> };

describe("mirrorLibrary", () => {
  it("两边都没有数据时不写；有数据后写入，内容不变则跳过", async () => {
    expect((await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER })).status).toBe("empty");
    expect(fs.existsSync(libraryFile())).toBe(false);

    await db.terms.put(term("t1"));
    await db.kv.bulkPut([
      { key: "termDisplay", value: { firstOnly: true, hidden: false } },
      { key: "indexer:paper:x", value: { big: true } },
    ]);
    const r1 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    expect(r1).toMatchObject({ status: "saved", revision: 1, hasData: true });
    const doc = readLibrary();
    expect(doc.revision).toBe(1);
    expect(doc.tables.terms).toHaveLength(1);
    expect(doc.tables.kv).toEqual([{ key: "termDisplay", value: { firstOnly: true, hidden: false } }]); // 不含 indexer:

    const folder = folderAt(1);
    expect((await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: r1.hash, folder })).status).toBe("unchanged");
    // 派生数据变化不影响哈希
    await db.kv.put({ key: "indexer:paper:x", value: { big: false } });
    expect((await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: r1.hash, folder })).status).toBe("unchanged");

    await db.terms.put(term("t2"));
    const r2 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: r1.hash, folder });
    expect(r2).toMatchObject({ status: "saved", revision: 2 });
    expect(readLibrary().tables.terms).toHaveLength(2);
  });

  it("另一个源写过（revision 变了）：本地有改动 → conflict；本地没改动 → behind", async () => {
    await db.terms.put(term("t1"));
    const r1 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    const doc = readLibrary();
    fs.writeFileSync(libraryFile(), JSON.stringify({ ...doc, revision: 5 }));

    const behind = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: r1.hash, folder: folderAt(5) });
    expect(behind.status).toBe("behind");

    await db.terms.put(term("t2"));
    const c = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: r1.hash, folder: folderAt(1) });
    expect(c).toMatchObject({ status: "conflict", folderRevision: 5 });
    expect(readLibrary().revision).toBe(5);

    // 用户选择覆盖：以文件夹的 revision 为基准强制写入
    const f = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 5, lastHash: null, folder: folderAt(5), force: true });
    expect(f).toMatchObject({ status: "saved", revision: 6 });
  });

  it("本地被清空而文件夹还有数据：不覆盖，交给用户决定", async () => {
    await db.terms.put(term("t1"));
    const r1 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    await db.terms.clear();
    const folder = folderAt(1);
    expect((await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: r1.hash, folder })).status).toBe("local-empty");
    expect(readLibrary().tables.terms).toHaveLength(1);
    expect((await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: r1.hash, folder, allowEmpty: true })).status).toBe("saved");
    expect(readLibrary().tables.terms).toHaveLength(0);
  });
});

describe("恢复与 PDF", () => {
  it("清空本地后从 data/ 恢复：数据一致，PDF 懒加载后逐个取回", async () => {
    const p1 = await addPaper("p1");
    const p2 = await addPaper("p2");
    await db.terms.put(term("t1", "LSTM"));
    await db.annotations.bulkPut([annotation("a1", p1, { termId: "t1" }), annotation("a2", p2)]);
    await db.kv.put({ key: "termDisplay", value: { firstOnly: false, hidden: true } });
    const before = serializeTables(await readDataTables(db));

    const r1 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    expect(r1.status).toBe("saved");
    const diff1 = await T.pdfDiff(ctx);
    expect(diff1.toUpload.sort()).toEqual([p1.fileHash, p2.fileHash].sort());
    for (const h of diff1.toUpload) expect(await T.uploadPdf(ctx, h)).toBe(true);
    expect(fs.readdirSync(`${server.dataDir}/pdfs`).sort()).toEqual([`${p1.fileHash}.pdf`, `${p2.fileHash}.pdf`].sort());
    expect((await T.pdfDiff(ctx)).toUpload).toEqual([]);

    // 模拟浏览器清除站点数据
    await Promise.all(db.tables.map((t) => t.clear()));
    expect((await T.countLocal(ctx)).papers).toBe(0);
    const restored = await T.restoreFromService(ctx, {});
    expect(restored).toMatchObject({ revision: 1, counts: { papers: 2, terms: 1, annotations: 2, kv: 1 } });
    expect(serializeTables(await readDataTables(db))).toBe(before);
    // 恢复后的哈希与再次保存时一致：不会多写一个版本
    expect((await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: restored.hash, folder: folderAt(1) })).status).toBe("unchanged");

    // PDF 还没回来
    expect(await db.files.count()).toBe(0);
    const diff2 = await T.pdfDiff(ctx);
    expect(diff2.toFetch.map((f) => f.hash).sort()).toEqual([p1.fileHash, p2.fileHash].sort());
    expect(await T.backfillPdf(ctx, p1.fileHash)).toBe(true);
    const f1 = await db.files.get(p1.fileHash);
    expect(await sha256Hex(f1!.blob)).toBe(p1.fileHash);
    expect((await T.pdfDiff(ctx)).toFetch.map((f) => f.hash)).toEqual([p2.fileHash]);

    // data/pdfs 里的文件损坏：拒绝写入
    fs.writeFileSync(`${server.dataDir}/pdfs/${p2.fileHash}.pdf`, "corrupted");
    await expect(T.backfillPdf(ctx, p2.fileHash)).rejects.toThrow("已损坏");
    expect(await db.files.get(p2.fileHash)).toBeUndefined();
  });

  it("本地和服务都没有的 PDF 报告为缺失", async () => {
    const p = await addPaper("p1");
    await db.files.clear();
    const d = await T.pdfDiff(ctx);
    expect(d.missing).toEqual([{ hash: p.fileHash, paperIds: ["p1"] }]);
    expect(await T.backfillPdf(ctx, p.fileHash)).toBe(false);
  });

  it("替换数据时保留仍有效的派生数据，清掉已不存在的论文的", async () => {
    const p1 = await addPaper("p1");
    await addPaper("p2");
    await db.pageTexts.bulkPut([
      { paperId: "p1", page: 1, text: "x", fileHash: p1.fileHash, engineVersion: 1 },
      { paperId: "p2", page: 1, text: "y", fileHash: "zz", engineVersion: 1 },
    ]);
    await db.kv.bulkPut([
      { key: "indexer:paper:p2", value: {} },
      { key: "storage:lastExportAt", value: 1 },
    ]);
    const exported = await T.exportJson(ctx);
    const doc = JSON.parse(exported.text);
    doc.tables.papers = doc.tables.papers.filter((p: Paper) => p.id === "p1");
    await T.applyImport(ctx, { text: JSON.stringify(doc) });
    expect((await db.pageTexts.toArray()).map((r) => r.paperId)).toEqual(["p1"]);
    expect(await db.kv.get("indexer:paper:p2")).toBeUndefined();
    expect(await db.kv.get("storage:lastExportAt")).toBeDefined(); // 本模块的记账保留
    expect(await db.files.count()).toBe(2); // PDF 不动
  });
});

describe("导出、导入、Markdown", () => {
  it("导出 JSON → 清空 → 导入：往返一致", async () => {
    const p = await addPaper("p1");
    await db.domains.put({ id: "d1", name: "ATM", parentId: null, color: "#3b82f6", order: 0 });
    await db.papers.update("p1", { domainIds: ["d1"], year: 2020 });
    await db.terms.bulkPut([term("t1", "LSTM"), { ...term("t2", "ATM"), scope: { kind: "domains", domainIds: ["d1"] }, sourceAnnotationId: "a1" }]);
    await db.annotations.put(annotation("a1", p, { termId: "t2" }));
    await db.notes.put({ id: "n1", text: "想法", createdAt: 1, updatedAt: 1 });
    await db.boards.put({ id: "b1", name: "对比", domainIds: ["d1"], createdAt: 1, updatedAt: 1 });
    await db.boardNodes.put({ id: "bn1", boardId: "b1", ref: { kind: "note", id: "n1" }, x: 1, y: 2, w: 3, h: 4 });
    await db.links.put({ id: "l1", from: { kind: "annotation", id: "a1" }, to: { kind: "note", id: "n1" }, relation: "supports", createdAt: 1 });
    const before = serializeTables(await readDataTables(db));

    const { text, counts } = await T.exportJson(ctx);
    expect(counts).toMatchObject({ papers: 1, terms: 2, annotations: 1, boards: 1, notes: 1, links: 1, boardNodes: 1, domains: 1 });
    const preview = await T.previewImport(ctx, text);
    expect(preview.counts).toEqual(counts);
    expect(preview.repairs).toEqual([]);

    await Promise.all(db.tables.map((t) => t.clear()));
    const r = await T.applyImport(ctx, { text });
    expect(r.counts).toEqual(counts);
    expect(serializeTables(await readDataTables(db))).toBe(before);
  });

  it("Markdown 写入 data/markdown/，改名后旧文件被清理", async () => {
    const p = await addPaper("p1");
    await db.terms.put(term("t1", "LSTM"));
    await db.annotations.put(annotation("a1", p, { termId: "t1" }));
    await db.occurrences.put({ termId: "t1", paperId: "p1", pages: [1, 2], count: 4, engineVersion: 1 });
    const r = await T.writeMarkdown(ctx);
    expect(r).toMatchObject({ files: 3, written: 3, deleted: 0 });
    const termMd = fs.readFileSync(`${server.dataDir}/markdown/terms/LSTM.md`, "utf8");
    expect(termMd).toContain("[[papers/Paper p1|Paper p1]] · 4 次（第 1、2 页）");
    expect(fs.readFileSync(`${server.dataDir}/markdown/papers/Paper p1.md`, "utf8")).toContain("术语：[[terms/LSTM|LSTM]]");

    await db.terms.update("t1", { name: "Long Short-Term Memory" });
    const r2 = await T.writeMarkdown(ctx);
    expect(r2).toMatchObject({ written: 2, unchanged: 1, deleted: 1 });
    expect(fs.existsSync(`${server.dataDir}/markdown/terms/LSTM.md`)).toBe(false);
    expect(fs.existsSync(`${server.dataDir}/markdown/terms/Long Short-Term Memory.md`)).toBe(true);
  });

  it("导入格式错误的文件给出可读的错误", async () => {
    await expect(T.previewImport(ctx, "not json")).rejects.toThrow("不是有效的 JSON");
    await expect(T.previewImport(ctx, JSON.stringify({ format: "paperlens", version: 99, tables: {} }))).rejects.toThrow("更新版本");
  });
});

// ---------------------------------------------------------------------------
// 评审 M4 的回归测试
// ---------------------------------------------------------------------------

describe("评审回归：不丢数据、不误报", () => {
  it("第 5 项：写入成功但响应丢失（客户端还以为是旧 revision）时认出是自己写的，采用文件夹的 revision", async () => {
    await db.terms.put(term("t1"));
    const r1 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    expect(r1.status).toBe("saved");
    expect(readLibrary()).toMatchObject({ revision: 1, contentHash: r1.hash });
    // 客户端没收到响应：仍以 revision 0、旧的文件夹状态再写一次 → 服务端 409，但内容哈希相同
    const again = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    expect(again).toMatchObject({ status: "adopted", revision: 1 });
    // 已知文件夹的内容哈希时不必发请求
    const known = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: folderAt(1, { contentHash: r1.hash }) });
    expect(known).toMatchObject({ status: "adopted", revision: 1, bytes: 0 });
    expect(readLibrary().revision).toBe(1);
  });

  it("第 2 项：数据库被清空重建（实例标识不符）后又有新数据时不写入文件夹", async () => {
    await T.stampDb(ctx, "instance-A");
    await db.terms.bulkPut(Array.from({ length: 10 }, (_, i) => term(`k${i}`)));
    const r1 = await T.mirrorLibrary(ctx, { dbInstance: "instance-A", baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    expect(r1.status).toBe("saved");
    // 模拟清除站点数据：整个数据库被清空（含 kv 里的实例标识），随后新建了一条
    await Promise.all(db.tables.map((t) => t.clear()));
    await db.terms.put(term("new"));
    const r2 = await T.mirrorLibrary(ctx, { dbInstance: "instance-A", baseRevision: 1, lastHash: r1.hash, folder: folderAt(1, { contentHash: r1.hash }) });
    expect(r2).toMatchObject({ status: "db-reset", localHasData: true });
    expect(readLibrary().tables.terms).toHaveLength(10);
    // 被清空、还没有新数据时同样报告（由控制器决定直接恢复）
    await db.terms.clear();
    expect(await T.mirrorLibrary(ctx, { dbInstance: "instance-A", baseRevision: 1, lastHash: r1.hash, folder: folderAt(1) })).toMatchObject({
      status: "db-reset",
      localHasData: false,
    });
    expect((await T.inspectLocal(ctx)).dbInstance).toBeNull();
  });

  it("第 4 项：决定载入之后本地又有改动时放弃替换，本地数据原样保留", async () => {
    await db.terms.put(term("t1", "文件夹里的"));
    await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    await db.terms.clear();
    await db.terms.put(term("t0", "本地原有"));
    const decided = await T.inspectLocal(ctx);
    await db.terms.put(term("t2", "载入期间新建"));
    await expect(T.restoreFromService(ctx, { expect: decided.fingerprint })).rejects.toMatchObject({ name: "LocalChangedError" });
    expect((await db.terms.toArray()).map((t) => t.name).sort()).toEqual(["本地原有", "载入期间新建"]);
    // 指纹一致时照常替换
    const now = await T.inspectLocal(ctx);
    await T.restoreFromService(ctx, { expect: now.fingerprint });
    expect((await db.terms.toArray()).map((t) => t.name)).toEqual(["文件夹里的"]);
  });

  it("第 6 项：library.json 损坏时不覆盖；确认后才覆盖（先另存损坏的文件）；也可以从最近的可读备份恢复", async () => {
    await db.terms.put(term("t1", "备份里的"));
    await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: NO_FOLDER });
    await ctx.api.backup("manual");
    const broken = '{"format":"paperlens","version":1,"revision":7,"tables":{"terms":[';
    fs.writeFileSync(libraryFile(), broken);
    const status = await ctx.api.status();
    expect(status!.library).toMatchObject({ exists: true, revision: 0 });
    expect(status!.library.error).toBeTruthy();

    await db.terms.clear();
    // 空浏览器、旧的文件夹状态：服务端拒绝
    const r1 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: null, folder: folderAt(1) });
    expect(r1.status).toBe("local-empty");
    await db.terms.put(term("t9", "浏览器里的"));
    const r2 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 1, lastHash: null, folder: folderAt(1) });
    expect(r2.status).toBe("unreadable");
    const r3 = await T.mirrorLibrary(ctx, { dbInstance: null, baseRevision: 0, lastHash: null, folder: folderAt(0, { unreadable: true, hasData: false }) });
    expect(r3.status).toBe("unreadable");
    expect(fs.readFileSync(libraryFile(), "utf8")).toBe(broken);

    // 从最近的可读备份恢复
    const rec = await ctx.api.recoverLibrary();
    expect(rec.name).toMatch(/-manual\.json\.gz$/);
    expect(readLibrary().tables.terms.map((t) => (t as { name: string }).name)).toEqual(["备份里的"]);
    expect(fs.readdirSync(`${server.dataDir}/backups`).some((n) => n.includes("-unreadable"))).toBe(true);

    // 再次损坏后由用户确认覆盖
    fs.writeFileSync(libraryFile(), broken);
    const r4 = await T.mirrorLibrary(ctx, {
      dbInstance: null,
      baseRevision: 0,
      lastHash: null,
      folder: folderAt(0, { unreadable: true }),
      force: true,
      overwriteUnreadable: true,
    });
    expect(r4.status).toBe("saved");
    expect(readLibrary().tables.terms.map((t) => (t as { name: string }).name)).toEqual(["浏览器里的"]);
  });

  it("第 13 项：Markdown 内容没变的文件只发哈希；服务端对不上时补发内容", async () => {
    const p = await addPaper("p1");
    await db.terms.put(term("t1", "LSTM"));
    await db.annotations.put(annotation("a1", p));
    const r1 = await T.writeMarkdown(ctx);
    expect(r1).toMatchObject({ files: 3, sent: 3, written: 3 });
    const manifest = `${server.dataDir}/markdown/.paperlens-manifest.json`;
    const before = fs.readFileSync(manifest, "utf8");
    const r2 = await T.writeMarkdown(ctx);
    expect(r2).toMatchObject({ sent: 0, written: 0, unchanged: 3 });
    expect(fs.readFileSync(manifest, "utf8")).toBe(before);
    await db.terms.update("t1", { note: "新笔记" });
    expect(await T.writeMarkdown(ctx)).toMatchObject({ sent: 1, written: 1 });
    // 文件被删掉：只发哈希的那项服务端对不上，补发内容
    fs.writeFileSync(manifest, JSON.stringify({ files: {} }));
    const r4 = await T.writeMarkdown(ctx);
    expect(r4.missing).toEqual([]);
    expect(fs.existsSync(`${server.dataDir}/markdown/terms/LSTM.md`)).toBe(true);
  });
});
