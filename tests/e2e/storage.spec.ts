/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 存储模块 e2e：自动保存到 data/、清除浏览器数据后自动恢复（含 PDF 懒加载）、跨源冲突、无服务、导出导入往返、
// Markdown、附加文件组、安全检查、性能。只能用 storage.config.ts 运行（数据目录是临时目录）。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { assertSafeE2EDataDir } from "./storageSafety";
import { addPaper, fileHashOf, fixtureBytes, waitRendered } from "./viewerHelpers";

// 外部传入的目录必须是临时目录：用例会清空它
const DATA = process.env.PAPERLENS_E2E_DATA_DIR ? assertSafeE2EDataDir(process.env.PAPERLENS_E2E_DATA_DIR) : "";
/** 没有 ?project 时打开的是 default 项目：数据在 data/projects/default/ */
const PDIR = DATA ? join(DATA, "projects", "default") : "";
const ORIGIN = "http://localhost:5331";
const OFFLINE = "http://localhost:5338";
const API = `${ORIGIN}/__paperlens/p/default/storage`;
const H = { "X-PaperLens": "1" };
const DAY = 86_400_000;

test.skip(!DATA, "需要用 tests/e2e/storage.config.ts 运行（临时数据目录）");
test.describe.configure({ mode: "serial" });
// 临时数据目录用完即删
test.afterAll(() => {
  if (DATA) rmSync(DATA, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyWin = Window & { __paperlens: any; __paperlensStorage: any; [k: string]: any };

interface Row {
  id: string;
  name?: string;
  [k: string]: unknown;
}
interface LibraryDoc {
  format: string;
  version: number;
  revision: number;
  tables: Record<string, Row[]> & { kv: { key: string; value: unknown }[] };
}

function wipeData() {
  if (!existsSync(DATA)) return;
  for (const n of readdirSync(DATA)) rmSync(join(DATA, n), { recursive: true, force: true });
}
const libPath = () => join(PDIR, "library.json");
const readLib = (): LibraryDoc => JSON.parse(readFileSync(libPath(), "utf8"));
const backups = () => (existsSync(join(PDIR, "backups")) ? readdirSync(join(PDIR, "backups")) : []);
/** data/backups/ 里的备份是 gzip 压缩的 */
const readBackup = (name: string): LibraryDoc => JSON.parse(gunzipSync(readFileSync(join(PDIR, "backups", name))).toString("utf8"));

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || (m.type() === "warning" && /radix|react/i.test(m.text()))) errors.push(m.text());
  });
  return errors;
}

async function boot(page: Page, url = "/") {
  await page.goto(url);
  // 在页面里按 URL 导入开发服务器上的源码模块（与应用共用同一个模块实例）
  await page.evaluate(() => {
    (window as unknown as AnyWin).__load = (p: string) => import(/* @vite-ignore */ p);
  });
  await page.waitForFunction(() => {
    const w = window as unknown as AnyWin;
    if (!w.__paperlens || !w.__paperlensStorage) return false;
    const phase = w.__paperlensStorage.useStorageStore.getState().phase;
    return phase !== "probing" && phase !== "restoring";
  });
}

const flush = (page: Page) => page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.flush());
const phaseOf = (page: Page) => page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.useStorageStore.getState().phase as string);
const termNames = (page: Page) =>
  page.evaluate(async () => ((await (window as unknown as AnyWin).__paperlens.db.terms.toArray()) as Row[]).map((t) => t.name!).sort());

/** 模拟浏览器清除站点数据（IndexedDB、localStorage 等） */
async function clearSiteData(page: Page, origin: string) {
  await page.goto("about:blank");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
  await cdp.detach();
}

const termRow = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  aliases: [],
  matchMode: "auto",
  scope: { kind: "global" },
  note: `${name} 的笔记`,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

async function putTerm(page: Page, id: string, name: string) {
  await page.evaluate((t) => (window as unknown as AnyWin).__paperlens.db.terms.put(t), termRow(id, name));
}

async function makePdf(title: string, body: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor("Ada Lovelace");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(title, { x: 72, y: 760, size: 14, font });
  page.drawText(body, { x: 72, y: 720, size: 12, font });
  return Buffer.from(await doc.save());
}

/** 页面里当前数据的序列化结果（与 library.json 的 tables 部分同一格式） */
const dataTablesJson = (page: Page) =>
  page.evaluate(async () => {
    const { readDataTables } = await (window as unknown as AnyWin).__load("/src/services/storage/snapshot.ts");
    const { serializeTables } = await (window as unknown as AnyWin).__load("/src/services/storage/format.ts");
    return serializeTables(await readDataTables((window as unknown as AnyWin).__paperlens.db)) as string;
  });

// ---------------------------------------------------------------------------

test("改动自动保存到 data/：library.json、PDF、Markdown；删除的论文 PDF 进回收站", async ({ page }) => {
  wipeData();
  const errors = trackErrors(page);
  await boot(page);
  await expect(page.getByTestId("storage-status")).toContainText("已保存到");
  expect(existsSync(libPath())).toBe(false); // 空库不写

  const title = "Storage Test: Attention Is All You Need";
  const pdf = await makePdf(title, "The Transformer uses scaled dot-product attention.");
  const hash = fileHashOf(pdf);
  await page.getByTestId("import-input").setInputFiles({ name: "attention_2017.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.locator("[data-paper-id]").filter({ hasText: "Storage Test" })).toBeVisible();

  // 不调用 flush：防抖后自动写入
  await expect.poll(() => existsSync(libPath()) && readLib().tables.papers.length, { timeout: 20_000 }).toBe(1);
  const pdfFile = join(PDIR, "pdfs", `${hash}.pdf`);
  await expect.poll(() => existsSync(pdfFile), { timeout: 20_000 }).toBe(true);
  expect(createHash("sha256").update(readFileSync(pdfFile)).digest("hex")).toBe(hash);
  const rev1 = readLib().revision;
  const paperId = readLib().tables.papers[0].id;

  // 术语 + 由它定义的批注
  await page.evaluate(
    ({ paperId, hash, term }) => {
      const { db } = (window as unknown as AnyWin).__paperlens;
      return db.transaction("rw", db.terms, db.annotations, async () => {
        await db.terms.put({ ...term, sourceAnnotationId: "a-1" });
        await db.annotations.put({
          id: "a-1",
          paperId,
          page: 1,
          rects: [[72, 715, 300, 730]],
          quote: { exact: "scaled dot-product attention", prefix: "", suffix: "" },
          fileHash: hash,
          color: "#fde68a",
          note: "核心机制",
          termId: term.id,
          createdAt: 2,
          updatedAt: 2,
        });
      });
    },
    { paperId, hash, term: termRow("t-transformer", "Transformer", { aliases: ["Transformers"] }) },
  );
  // 等后台索引算出出现位置，Markdown 的"出现于"才有内容
  await page.evaluate(() => (window as unknown as AnyWin).__load("/src/services/indexer.ts").then((m: any) => m.whenIndexerIdle()));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as AnyWin).__paperlens.db.occurrences.count()), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await flush(page);

  const lib = readLib();
  expect(lib.revision).toBeGreaterThan(rev1);
  expect(lib.tables.terms.map((t) => t.name)).toEqual(["Transformer"]);
  expect(lib.tables.annotations).toHaveLength(1);
  expect(lib.tables.kv.filter((r) => r.key.startsWith("indexer:"))).toEqual([]);
  expect(Object.keys(lib.tables).sort()).toEqual(["annotations", "boardNodes", "boards", "domains", "kv", "links", "notes", "papers", "terms"]);

  const termMd = readFileSync(join(PDIR, "markdown", "terms", "Transformer.md"), "utf8");
  expect(termMd).toContain('aliases:\n  - "Transformers"');
  expect(termMd).toContain("## 出现于");
  expect(termMd).toMatch(/\[\[papers\/Storage Test Attention Is All You Need\|Storage Test: Attention Is All You Need\]\] · \d+ 次/);
  const paperMd = readFileSync(join(PDIR, "markdown", "papers", "Storage Test Attention Is All You Need.md"), "utf8");
  expect(paperMd).toContain("### 第 1 页");
  expect(paperMd).toContain("> scaled dot-product attention");
  expect(paperMd).toContain("核心机制");
  expect(paperMd).toContain("术语：[[terms/Transformer|Transformer]]");
  await expect(page.getByTestId("storage-status")).toContainText(/已保存到 .* · 刚刚/);

  // 删除论文：PDF 移到 trash/，不物理删除
  await page.evaluate((id) => (window as unknown as AnyWin).__load("/src/services/paperService.ts").then((m: any) => m.deletePaper(id)), paperId);
  await flush(page);
  expect(existsSync(pdfFile)).toBe(false);
  expect(existsSync(join(PDIR, "trash", `${hash}.pdf`))).toBe(true);
  expect(existsSync(join(PDIR, "markdown", "papers", "Storage Test Attention Is All You Need.md"))).toBe(false);
  expect(errors).toEqual([]);
});

test("清除浏览器数据后自动从 data/ 恢复；PDF 打开时从 data/pdfs 取回；都没有时提示重新导入", async ({ page }) => {
  wipeData();
  await boot(page);
  const bytes = fixtureBytes("simple.pdf");
  const hash = fileHashOf(bytes);
  await addPaper(page, bytes, "p-simple", "Simple Fixture");
  await page.evaluate(
    ({ hash, term }) => {
      const { db } = (window as unknown as AnyWin).__paperlens;
      return Promise.all([
        db.terms.put(term),
        db.annotations.put({
          id: "a-1",
          paperId: "p-simple",
          page: 1,
          rects: [],
          quote: { exact: "hello", prefix: "", suffix: "" },
          fileHash: hash,
          color: "#bbf7d0",
          note: "恢复后还在",
          createdAt: 1,
          updatedAt: 1,
        }),
        db.kv.put({ key: "termDisplay", value: { firstOnly: true, hidden: false } }),
      ]);
    },
    { hash, term: termRow("t-1", "恢复测试") },
  );
  await flush(page);
  expect(existsSync(join(PDIR, "pdfs", `${hash}.pdf`))).toBe(true);
  const saved = readLib();

  await clearSiteData(page, ORIGIN);
  await boot(page);
  const notice = page.getByTestId("storage-notice");
  await expect(notice).toContainText("已从");
  await expect(notice).toContainText("1 篇论文、1 个术语、1 条批注");
  await expect(page.locator("[data-paper-id]").filter({ hasText: "Simple Fixture" })).toBeVisible();
  const restored = await page.evaluate(async () => {
    const { db } = (window as unknown as AnyWin).__paperlens;
    return { terms: await db.terms.toArray(), annotations: await db.annotations.toArray(), display: await db.kv.get("termDisplay") };
  });
  expect(restored.terms).toEqual(saved.tables.terms);
  expect(restored.annotations).toEqual(saved.tables.annotations);
  expect(restored.display).toEqual({ key: "termDisplay", value: { firstOnly: true, hidden: false } });
  expect(readLib().revision).toBe(saved.revision); // 恢复后没有多写一个版本

  // 后台逐个取回 PDF
  const hasBlob = () => page.evaluate((h) => (window as unknown as AnyWin).__paperlens.db.files.get(h).then((f: unknown) => !!f), hash);
  await expect.poll(hasBlob, { timeout: 20_000 }).toBe(true);

  // 懒加载：去掉本地副本后立即打开，由 PDF 加载器从 data/pdfs 取回并写回 db.files
  await page.evaluate((h) => (window as unknown as AnyWin).__paperlens.db.files.delete(h), hash);
  await page.evaluate(() => (window as unknown as AnyWin).__paperlens.useReaderStore.getState().openPaper("p-simple"));
  await waitRendered(page, 1);
  expect(await hasBlob()).toBe(true);

  // 本地和 data/pdfs 都没有：明确的错误
  await page.evaluate(
    () =>
      (window as unknown as AnyWin).__paperlens.db.papers.put({
        id: "p-missing",
        fileHash: "c".repeat(64),
        title: "Missing PDF",
        authors: [],
        domainIds: [],
        pageCount: 1,
        addedAt: Date.now(),
      }),
  );
  await page.evaluate(() => (window as unknown as AnyWin).__paperlens.useReaderStore.getState().openPaper("p-missing"));
  await expect(page.locator('[data-pane="left"]')).toContainText("缺少 PDF 文件，请重新导入该文件");
});

test("另一个源写过 data/：冲突时暂停并提示，两种选择都先备份；本地没改动时直接载入", async ({ page }) => {
  wipeData();
  await boot(page);
  await putTerm(page, "t-local-1", "本地术语一");
  await flush(page);
  expect(readLib().revision).toBe(1);

  // 模拟另一个源（如 127.0.0.1:5173）写入：revision 和内容都变了
  const other = readLib();
  other.revision = 5;
  other.tables.terms = [termRow("t-other", "外来术语")];
  writeFileSync(libPath(), JSON.stringify(other));
  await putTerm(page, "t-local-2", "本地术语二");
  await flush(page);

  const dialog = page.getByTestId("storage-conflict-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("文件夹中的数据已被另一个窗口更新");
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-phase", "conflict");
  await expect(page.getByTestId("storage-status")).toContainText("文件夹中的数据已被另一个窗口更新");
  expect(readLib().revision).toBe(5); // 暂停期间不写

  // 选择一：载入文件夹的数据
  await dialog.getByTestId("conflict-load-folder").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => termNames(page)).toEqual(["外来术语"]);
  await expect(page.getByTestId("storage-notice")).toContainText("已从");
  const b1 = backups().find((n) => n.endsWith("-browser-before-load.json.gz"));
  expect(b1).toBeTruthy();
  expect(readBackup(b1!).tables.terms.map((t) => t.name).sort()).toEqual([
    "本地术语一",
    "本地术语二",
  ]);
  expect(await phaseOf(page)).toBe("saved");

  // 选择二：用本浏览器的数据覆盖文件夹
  const other2 = readLib();
  other2.revision = 9;
  other2.tables.terms.push(termRow("t-other-2", "外来术语二"));
  writeFileSync(libPath(), JSON.stringify(other2));
  await putTerm(page, "t-local-3", "本地术语三");
  await flush(page);
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("conflict-overwrite-folder").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => readLib().revision).toBe(10);
  expect(readLib().tables.terms.map((t) => t.name).sort()).toEqual(["外来术语", "本地术语三"]);
  const b2 = backups().find((n) => n.endsWith("-before-overwrite.json.gz"));
  expect(b2).toBeTruthy();
  expect(readBackup(b2!).revision).toBe(9);

  // 本地没有改动、文件夹被另一个窗口更新：窗口获得焦点时直接载入，不打扰用户
  const other3 = readLib();
  other3.revision = 11;
  other3.tables.terms.push(termRow("t-ff", "快进术语"));
  writeFileSync(libPath(), JSON.stringify(other3));
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return termNames(page);
      },
      { timeout: 15_000, intervals: [500, 1000] },
    )
    .toContain("快进术语");
  await expect(page.getByTestId("storage-notice")).toContainText("已载入其他窗口保存的数据");
  await expect(dialog).toBeHidden();
});

test("浏览器数据被清空而 data/ 还有数据（页面未刷新）：不覆盖，提示恢复", async ({ page }) => {
  wipeData();
  await boot(page);
  await putTerm(page, "t-keep", "要保住的术语");
  await flush(page);
  // 页面开着时数据被清掉（例如另一个标签页里删光了）
  await page.evaluate(() => (window as unknown as AnyWin).__paperlens.db.terms.clear());
  await flush(page);
  const dialog = page.getByTestId("storage-conflict-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-kind", "local-empty");
  expect(readLib().tables.terms.map((t) => t.name)).toEqual(["要保住的术语"]);
  await dialog.getByTestId("conflict-load-folder").click();
  await expect.poll(() => termNames(page)).toEqual(["要保住的术语"]);
});

test("同源的多个标签页：只有一个负责保存，其他标签页的改动和状态照常同步", async ({ page, context }) => {
  wipeData();
  await boot(page);
  const page2 = await context.newPage();
  await boot(page2);
  const leaders = await Promise.all([page, page2].map((p) => p.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.isLeader())));
  expect(leaders.filter(Boolean)).toHaveLength(1);
  const follower = leaders[0] ? page2 : page;
  await putTerm(follower, "t-tab", "第二个标签页的术语");
  await flush(follower); // 转给负责的标签页执行
  expect(readLib().tables.terms.map((t) => t.name)).toEqual(["第二个标签页的术语"]);
  await expect(follower.getByTestId("storage-status")).toContainText("已保存到");
  await page2.close();
});

test("导出 JSON → 导入：往返一致，导入前自动备份到 data/backups/", async ({ page }) => {
  wipeData();
  await boot(page);
  await page.evaluate(() => {
    const { db } = (window as unknown as AnyWin).__paperlens;
    return db.transaction("rw", [db.domains, db.papers, db.terms, db.annotations, db.notes, db.boards, db.boardNodes, db.links, db.kv], async () => {
      await db.domains.bulkPut([
        { id: "d1", name: "ATM", parentId: null, color: "#3b82f6", order: 0 },
        { id: "d2", name: "轨迹预测", parentId: "d1", color: "#10b981", order: 0 },
      ]);
      await db.papers.put({ id: "p1", fileHash: "d".repeat(64), title: "Round Trip", authors: ["A", "B"], year: 2021, domainIds: ["d2"], pageCount: 9, addedAt: 5 });
      await db.terms.bulkPut([
        { id: "t1", name: "LSTM", aliases: ["LSTMs"], matchMode: "auto", scope: { kind: "global" }, note: "**笔记** $x^2$", createdAt: 1, updatedAt: 2 },
        { id: "t2", name: "ATM", aliases: [], matchMode: "caseSensitive", scope: { kind: "domains", domainIds: ["d1"] }, note: "", sourceAnnotationId: "a1", createdAt: 1, updatedAt: 1 },
      ]);
      await db.annotations.put({
        id: "a1",
        paperId: "p1",
        page: 3,
        rects: [[1, 2, 3, 4]],
        quote: { exact: "air traffic management", prefix: "p", suffix: "s" },
        fileHash: "d".repeat(64),
        color: "#bfdbfe",
        note: "批注",
        termId: "t2",
        createdAt: 3,
        updatedAt: 4,
      });
      await db.notes.put({ id: "n1", text: "想法", createdAt: 1, updatedAt: 1 });
      await db.boards.put({ id: "b1", name: "方法对比", domainIds: ["d1"], createdAt: 1, updatedAt: 1, viewport: { x: 1, y: 2, zoom: 1.5 } });
      await db.boardNodes.put({ id: "bn1", boardId: "b1", ref: { kind: "annotation", id: "a1" }, x: 10, y: 20, w: 200, h: 100 });
      await db.links.put({ id: "l1", from: { kind: "annotation", id: "a1" }, to: { kind: "note", id: "n1" }, relation: "supports", createdAt: 1 });
      await db.kv.put({ key: "termDisplay", value: { firstOnly: true, hidden: true } });
    });
  });
  await flush(page);
  const before = await dataTablesJson(page);

  await page.getByTestId("storage-status").click();
  const dialog = page.getByTestId("storage-dialog");
  await expect(dialog).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("export-json").click()]);
  expect(download.suggestedFilename()).toMatch(/^paperlens-backup-\d{8}\.json$/);
  const text = readFileSync((await download.path())!, "utf8");
  const exported = JSON.parse(text) as LibraryDoc & { exportedAt: string };
  expect(exported).toMatchObject({ format: "paperlens", version: 1 });
  expect(exported.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(exported.tables).not.toHaveProperty("files");
  expect(exported.tables).not.toHaveProperty("pageTexts");
  expect(exported.tables).not.toHaveProperty("occurrences");

  // 改掉本地数据
  await page.evaluate(async () => {
    const { db } = (window as unknown as AnyWin).__paperlens;
    await db.terms.clear();
    await db.terms.put({ id: "tmp", name: "临时术语", aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 1, updatedAt: 1 });
  });
  await flush(page);

  await dialog.getByTestId("import-json-input").setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: Buffer.from(text) });
  const preview = dialog.getByTestId("import-preview");
  await expect(preview).toContainText("包含 1 篇论文、2 个术语、1 条批注、1 块画布、2 个领域");
  await preview.getByTestId("import-confirm").click();
  await expect(dialog.getByTestId("import-result")).toContainText("已导入 1 篇论文、2 个术语、1 条批注");
  expect(await dataTablesJson(page)).toBe(before);

  const b = backups().find((n) => n.endsWith("-before-import.json.gz"));
  expect(b).toBeTruthy();
  expect(readBackup(b!).tables.terms.map((t) => t.name)).toEqual(["临时术语"]);
  await flush(page);
  expect(readLib().tables.terms.map((t) => t.name).sort()).toEqual(["ATM", "LSTM"]);

  // data/backups/ 里的 .json.gz 备份也能直接导入（预览后取消）
  await dialog
    .getByTestId("import-json-input")
    .setInputFiles({ name: b!, mimeType: "application/gzip", buffer: readFileSync(join(PDIR, "backups", b!)) });
  await expect(dialog.getByTestId("import-preview")).toContainText("包含 1 篇论文、1 个术语");
  await dialog.getByTestId("import-preview").getByRole("button", { name: "取消" }).click();

  // 坏文件给出可读的错误
  await dialog.getByTestId("import-json-input").setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"format":"zotero"}') });
  await expect(dialog.getByTestId("import-error")).toContainText("不是 Paperloom 的备份文件");
});

test("附加文件组：写入 data/<group>/，本次没有的旧文件被清理，用户的文件不动", async ({ page }) => {
  wipeData();
  await boot(page);
  await page.evaluate(async () => {
    const m = await (window as unknown as AnyWin).__load("/src/services/storage/extraFiles.ts");
    const w = window as unknown as AnyWin;
    w.__e2eExtra = [
      { name: "方法对比.canvas", content: '{"nodes":[]}' },
      { name: "旧画布.canvas", content: "{}" },
    ];
    m.registerExtraFiles("e2e-group", async () => w.__e2eExtra);
  });
  await flush(page);
  const dir = join(PDIR, "e2e-group");
  expect(readdirSync(dir).sort()).toEqual([".paperlens-manifest.json", "方法对比.canvas", "旧画布.canvas"]);
  writeFileSync(join(dir, "用户文件.md"), "自己放的");

  await page.evaluate(() => {
    (window as unknown as AnyWin).__e2eExtra = [{ name: "方法对比.canvas", content: '{"nodes":[1]}' }];
  });
  await flush(page);
  expect(readdirSync(dir).sort()).toEqual([".paperlens-manifest.json", "方法对比.canvas", "用户文件.md"]);
  expect(readFileSync(join(dir, "方法对比.canvas"), "utf8")).toBe('{"nodes":[1]}');
});

test("安全：缺少自定义头、外来 Origin、非法哈希、其他源页面的请求都被拒绝", async ({ page, request }) => {
  wipeData();
  expect((await request.get(`${API}/status`)).status()).toBe(403);
  expect((await request.get(`${API}/status`, { headers: { ...H, Origin: "http://evil.example" } })).status()).toBe(403);
  expect((await request.get(`${API}/status`, { headers: { ...H, Origin: ORIGIN } })).status()).toBe(200);
  expect((await request.get(`${API}/pdfs/not-a-hash`, { headers: H })).status()).toBe(400);
  expect((await request.put(`${API}/pdfs/${"0".repeat(64)}`, { headers: H, data: Buffer.from("%PDF-1.7 x") })).status()).toBe(400);
  expect(existsSync(join(PDIR, "pdfs", `${"0".repeat(64)}.pdf`))).toBe(false);
  const put = await request.put(`${API}/library`, {
    headers: { ...H, Origin: "http://evil.example", "X-PaperLens-Base-Revision": "0" },
    data: JSON.stringify({ format: "paperlens", version: 1, revision: 1, tables: {} }),
  });
  expect(put.status()).toBe(403);

  // 另一个源（5338）的页面：简单请求读不到响应，带自定义头的请求过不了预检
  await page.goto(`${OFFLINE}/`);
  const results = await page.evaluate(async (api) => {
    const out: string[] = [];
    const inits: RequestInit[] = [
      {},
      { headers: { "X-PaperLens": "1" } },
      { method: "PUT", headers: { "X-PaperLens": "1", "X-PaperLens-Base-Revision": "0" }, body: '{"format":"paperlens","version":1,"revision":1,"tables":{}}' },
    ];
    for (const init of inits) {
      try {
        const res = await fetch(`${api}/library`, init);
        out.push(`status ${res.status}`);
      } catch {
        out.push("blocked");
      }
    }
    return out;
  }, API);
  expect(results).toEqual(["blocked", "blocked", "blocked"]);
  expect(existsSync(libPath())).toBe(false);

  // 第 1 项：数据目录不能经 Vite 的静态文件服务读到（/@fs/、/@id/、?import 等），其他 localhost 源也拿不到 CORS 许可
  mkdirSync(PDIR, { recursive: true });
  writeFileSync(libPath(), JSON.stringify({ format: "paperlens", version: 1, revision: 1, tables: { terms: [{ id: "x", name: "SECRET-7f3a" }] } }));
  const probes = [`/@fs${PDIR}/library.json`, `/@fs${PDIR}/library.json?import`, `/@fs${PDIR}/library.json?raw&import`, `//@fs${PDIR}/library.json?import`, `/@id${PDIR}/library.json?import`];
  const crossOrigin = await page.evaluate(
    async ({ origin, probes }) => {
      const out: string[] = [];
      for (const p of probes) {
        try {
          const res = await fetch(`${origin}${p}`);
          out.push(`${res.status} ${(await res.text()).includes("SECRET-7f3a") ? "LEAK" : ""}`);
        } catch {
          out.push("blocked");
        }
      }
      return out;
    },
    { origin: ORIGIN, probes },
  );
  expect(crossOrigin.every((r) => r === "blocked")).toBe(true);
  for (const p of probes) {
    const res = await request.get(`${ORIGIN}${p}`, { headers: { Origin: OFFLINE } });
    expect(res.status(), p).toBe(403);
    expect(await res.text()).not.toContain("SECRET-7f3a");
    expect(res.headers()["access-control-allow-origin"]).toBeUndefined();
  }
});

test("没有本地服务：提示数据只在浏览器中、每周提醒导出，导出导入照常且不报错", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page, `${OFFLINE}/`);
  const status = page.getByTestId("storage-status");
  await expect(status).toHaveAttribute("data-phase", "offline");
  await expect(status).toContainText("未连接本地服务：数据只保存在本浏览器中");
  await page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.flush()); // 没有服务时什么也不做

  // 最早的论文是 10 天前导入的，从未导出过 → 提醒
  await page.evaluate(
    (addedAt) =>
      (window as unknown as AnyWin).__paperlens.db.papers.put({ id: "p1", fileHash: "e".repeat(64), title: "Offline", authors: [], domainIds: [], pageCount: 1, addedAt }),
    Date.now() - 10 * DAY,
  );
  await expect(status).toContainText("已 10 天未导出备份");

  await status.click();
  const dialog = page.getByTestId("storage-dialog");
  await expect(dialog).toContainText("未连接本地服务");
  await expect(dialog.getByTestId("storage-last-export")).toContainText("从未导出");
  const [json] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("export-json").click()]);
  expect(json.suggestedFilename()).toMatch(/^paperlens-backup-\d{8}\.json$/);
  await expect(dialog.getByTestId("storage-last-export")).toContainText("刚刚");
  await expect(status).toContainText("未连接本地服务：数据只保存在本浏览器中"); // 不再提醒

  const [md] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("export-markdown").click()]);
  expect(md.suggestedFilename()).toMatch(/^paperlens-notes-\d{8}\.md$/);
  expect(readFileSync((await md.path())!, "utf8")).toContain("### Offline");

  // 没有服务时导入：先自动下载一份当前数据
  const text = readFileSync((await json.path())!, "utf8");
  await dialog.getByTestId("import-json-input").setInputFiles({ name: "b.json", mimeType: "application/json", buffer: Buffer.from(text) });
  // 第 10 项：没有服务时两步确认：先下载备份并确认已保存，才能替换
  await expect(dialog.getByTestId("import-confirm")).toBeDisabled();
  const [auto] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("import-download-backup").click()]);
  expect(auto.suggestedFilename()).toMatch(/^paperlens-backup-before-import-\d{8}-\d{4}\.json$/);
  await expect(dialog.getByTestId("import-confirm")).toBeDisabled();
  await dialog.getByTestId("import-backup-saved").check();
  await dialog.getByTestId("import-confirm").click();
  await expect(dialog.getByTestId("import-result")).toContainText("已导入 1 篇论文");
  expect(errors).toEqual([]);
});

test("性能：2000 个术语 + 6000 条批注时保存不阻塞主线程", async ({ page }) => {
  wipeData();
  await boot(page);
  await page.evaluate(async () => {
    const { db } = (window as unknown as AnyWin).__paperlens;
    const lorem = "注意力机制 attention mechanism ".repeat(8);
    const papers = Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`,
      fileHash: i.toString(16).padStart(64, "0"),
      title: `Paper ${i}: A Study of Trajectory Prediction`,
      authors: ["Alice Zhang", "Bob Li"],
      year: 2000 + (i % 25),
      domainIds: [],
      pageCount: 12,
      addedAt: i,
    }));
    const terms = Array.from({ length: 2000 }, (_, i) => ({
      id: `t${i}`,
      name: `Term ${i}`,
      aliases: [`T${i}`, `TERM-${i}`],
      matchMode: "auto",
      scope: { kind: "global" },
      note: `${lorem}${i}`,
      createdAt: i,
      updatedAt: i,
    }));
    const annotations = Array.from({ length: 6000 }, (_, i) => ({
      id: `a${i}`,
      paperId: `p${i % 300}`,
      page: (i % 12) + 1,
      rects: [
        [72.12, 700.5 - (i % 40) * 12, 300.75, 712.25 - (i % 40) * 12],
        [72.12, 688.5 - (i % 40) * 12, 250.5, 700.25 - (i % 40) * 12],
      ],
      quote: { exact: `the proposed model significantly outperforms baseline ${i}`, prefix: "In our experiments on the dataset, ", suffix: " across all evaluation metrics." },
      fileHash: (i % 300).toString(16).padStart(64, "0"),
      color: "#fde68a",
      note: `${lorem}${i}`,
      createdAt: i,
      updatedAt: i,
    }));
    await db.transaction("rw", db.papers, db.terms, db.annotations, async () => {
      await db.papers.bulkPut(papers);
      await db.terms.bulkPut(terms);
      await db.annotations.bulkPut(annotations);
    });
  });
  await flush(page);
  await page.waitForTimeout(1500); // 等界面和索引平静下来

  await page.evaluate(() => {
    const w = window as unknown as AnyWin;
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
    }).observe({ type: "longtask" });
  });
  const flushMs = await page.evaluate(async () => {
    const w = window as unknown as AnyWin;
    await w.__paperlens.db.annotations.update("a42", { note: "改一条批注" });
    const t0 = performance.now();
    await w.__paperlensStorage.flush();
    return Math.round(performance.now() - t0);
  });
  await page.waitForTimeout(300);
  const longTasks = (await page.evaluate(() => (window as unknown as AnyWin).__longTasks)) as number[];
  const dbg = await page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.debug());
  // 对照：同样的读取和序列化放在主线程要多久
  const inline = await page.evaluate(async () => {
    const { readDataTables } = await (window as unknown as AnyWin).__load("/src/services/storage/snapshot.ts");
    const { serializeTables } = await (window as unknown as AnyWin).__load("/src/services/storage/format.ts");
    const t0 = performance.now();
    const tables = await readDataTables((window as unknown as AnyWin).__paperlens.db);
    const t1 = performance.now();
    const json = serializeTables(tables);
    const t2 = performance.now();
    return { readMs: Math.round(t1 - t0), serializeMs: Math.round(t2 - t1), bytes: json.length };
  });
  console.log(
    `[storage perf] library.json ${(dbg.lastMirror.bytes / 1048576).toFixed(2)} MB；Worker 内 读取 ${dbg.lastMirror.timings.readMs.toFixed(0)} ms / 序列化 ${dbg.lastMirror.timings.serializeMs.toFixed(0)} ms / 哈希 ${dbg.lastMirror.timings.hashMs.toFixed(0)} ms / 写入 ${dbg.lastMirror.timings.putMs.toFixed(0)} ms；flush 共 ${flushMs} ms（含 Markdown）；` +
      `主线程长任务 ${longTasks.length} 个${longTasks.length ? `（最长 ${Math.max(...longTasks)} ms）` : ""}；若在主线程执行：读取 ${inline.readMs} ms + 序列化 ${inline.serializeMs} ms`,
  );
  expect(dbg.usesWorker).toBe(true);
  expect(dbg.lastMirror.status).toBe("saved");
  expect(readLib().tables.annotations).toHaveLength(6000);
  expect(existsSync(join(PDIR, "markdown", "terms", "Term 1999.md"))).toBe(true);
  expect(Math.max(0, ...longTasks)).toBeLessThan(100);
});

// ---------------------------------------------------------------------------
// 评审 M4 的回归测试（由评审的复现脚本改写）
// ---------------------------------------------------------------------------

const syncState = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as AnyWin).__paperlensStorage.useStorageStore.getState();
    return { phase: s.phase as string, conflict: s.conflict as { kind: string } | null, failedPdfUploads: s.failedPdfUploads as number };
  });
const tenTerms = (page: Page) =>
  page.evaluate(async () => {
    const { db } = (window as unknown as AnyWin).__paperlens;
    await db.terms.bulkPut(
      Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, name: `术语${i}`, aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 1, updatedAt: 1 })),
    );
  });

test("评审 T1（第 4 项）：快进载入期间本地有新改动时放弃载入、转为冲突，改动不丢", async ({ browser }) => {
  wipeData();
  const ctxA = await browser.newContext({ locale: "zh-CN" });
  const a = await ctxA.newPage();
  await boot(a, `${ORIGIN}/`);
  await putTerm(a, "t1", "初始");
  await flush(a);
  const ctxB = await browser.newContext({ locale: "zh-CN" });
  const b = await ctxB.newPage();
  await boot(b, "http://127.0.0.1:5331/");
  await expect.poll(() => termNames(b), { timeout: 15_000 }).toEqual(["初始"]);
  await putTerm(b, "tB", "B的改动");
  await flush(b);
  const folderAfterB = readLib();

  let delayed = 0;
  await ctxA.route("**/__paperlens/p/*/storage/library", async (route) => {
    if (route.request().method() === "GET") {
      delayed++;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await route.continue();
  });
  // A 获得焦点 → 发现文件夹更新、本地没改动 → 开始快进载入（GET 被拖慢 3 秒）
  await expect
    .poll(
      async () => {
        await a.evaluate(() => window.dispatchEvent(new Event("focus")));
        return delayed;
      },
      { timeout: 10_000, intervals: [300, 500, 1000] },
    )
    .toBeGreaterThan(0);
  await putTerm(a, "tA", "A在载入期间的改动");
  await expect(a.getByTestId("storage-conflict-dialog")).toBeVisible({ timeout: 20_000 });
  await expect(a.getByTestId("storage-conflict-dialog")).toHaveAttribute("data-kind", "revision");
  expect(await termNames(a)).toEqual(["A在载入期间的改动", "初始"]);
  expect(readLib()).toEqual(folderAfterB); // 暂停期间不写
  await ctxA.close();
  await ctxB.close();
});

test("评审 T2（第 5 项）：写入成功但响应丢失，之后不误报冲突", async ({ page, context }) => {
  wipeData();
  await boot(page);
  await putTerm(page, "t1", "一");
  await flush(page);
  let hits = 0;
  await context.route("**/__paperlens/p/*/storage/library", async (route) => {
    if (route.request().method() === "PUT" && hits++ === 0) {
      await route.fetch(); // 请求到达服务端并写入
      await route.abort("connectionreset"); // 但浏览器没收到响应
      return;
    }
    await route.continue();
  });
  await putTerm(page, "t2", "二");
  const first = await page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.flush().then(() => "ok", (e: Error) => `error: ${e.message}`));
  expect(first).toMatch(/^error/); // 失败的 flush 以错误结束
  expect(readLib().revision).toBe(2);
  // 退避后自动重试：服务端 409，但内容哈希相同 → 直接采用
  await expect.poll(() => syncState(page), { timeout: 15_000 }).toMatchObject({ phase: "saved", conflict: null });
  await expect(page.getByTestId("storage-conflict-dialog")).toBeHidden();
  expect(readLib().revision).toBe(2);
  expect(readLib().tables.terms.map((t) => t.name).sort()).toEqual(["一", "二"]);
});

test("评审 T3（第 3 项）：保存持续失败时，页面隐藏和立即保存不会触发无退避的重试", async ({ page, context }) => {
  wipeData();
  await boot(page);
  await putTerm(page, "t1", "一");
  await flush(page);
  let puts = 0;
  await context.route("**/__paperlens/p/*/storage/library", async (route) => {
    if (route.request().method() === "PUT") {
      puts++;
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"internal","message":"ENOSPC: no space left on device"}' });
      return;
    }
    await route.continue();
  });
  await putTerm(page, "t2", "二");
  await expect.poll(() => syncState(page).then((s) => s.phase), { timeout: 10_000 }).toBe("error");
  puts = 0;
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(4000);
  expect(puts).toBeLessThanOrEqual(2);
  puts = 0;
  const r = await page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.flush().then(() => "ok", (e: Error) => `error: ${e.message}`));
  expect(r).toContain("ENOSPC");
  await page.waitForTimeout(3000);
  expect(puts).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("storage-status")).toContainText("保存失败");
  // 服务恢复后自动保存成功
  await context.unroute("**/__paperlens/p/*/storage/library");
  await expect.poll(() => readLib().tables.terms.length, { timeout: 70_000 }).toBe(2);
});

test("评审 T3b（第 3 项）：服务停掉（连接被拒）且页面在后台时也按退避重试", async ({ page, context }) => {
  wipeData();
  await boot(page);
  await putTerm(page, "a", "a");
  await flush(page);
  let attempts = 0;
  await context.route("**/__paperlens/p/*/storage/**", async (route) => {
    attempts++;
    await route.abort("connectionrefused");
  });
  await putTerm(page, "b", "b");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(5000);
  expect(attempts).toBeLessThanOrEqual(4);
});

test("评审 T4（第 2 项）：页面开着时 IndexedDB 被清空，之后的保存不会用残缺数据覆盖 library.json", async ({ page, context }) => {
  wipeData();
  await boot(page);
  await tenTerms(page);
  await flush(page);
  expect(readLib().tables.terms).toHaveLength(10);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "indexeddb" });
  await page.waitForTimeout(1000);
  await putTerm(page, "new", "清空后新建");
  await page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.flush().catch(() => {}));
  await page.waitForTimeout(1500);
  // 两种结果都可以：数据库刚被清空时自动从 data/ 恢复（之后新建的照常保存），或者有了新数据后暂停并询问
  const s = await syncState(page);
  const local = await termNames(page);
  expect(readLib().tables.terms.length).toBeGreaterThanOrEqual(10);
  if (s.phase === "conflict") {
    expect(s.conflict?.kind).toBe("db-reset");
    await page.getByTestId("conflict-load-folder").click();
    await expect.poll(() => termNames(page).then((t) => t.length)).toBe(10);
  } else {
    expect(local).toHaveLength(11);
  }
  expect(backups().filter((n) => n.includes("-shrink"))).toEqual([]);
});

test("评审 T7（第 2 项）：只清了 IndexedDB、启动探测较慢时先建了数据：暂停并询问，两种选择都可用", async ({ browser }) => {
  wipeData();
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const p = await ctx.newPage();
  await boot(p);
  await tenTerms(p);
  await flush(p);
  await p.goto("about:blank");
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "indexeddb" });
  await cdp.detach();
  await ctx.route("**/__paperlens/p/*/storage/status", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await p.goto("/");
  await p.waitForFunction(() => !!(window as unknown as AnyWin).__paperlens);
  await putTerm(p, "early", "启动时新建");
  const dialog = p.getByTestId("storage-conflict-dialog");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toHaveAttribute("data-kind", "db-reset");
  await expect(dialog).toContainText("本地数据库已被重置");
  expect(readLib().tables.terms).toHaveLength(10);
  await ctx.unroute("**/__paperlens/p/*/storage/status");
  // 从 data/ 恢复：先备份本地那条新数据
  await dialog.getByTestId("conflict-load-folder").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => termNames(p).then((t) => t.length)).toBe(10);
  const b = backups().find((n) => n.endsWith("-browser-before-load.json.gz"));
  expect(readBackup(b!).tables.terms.map((t) => t.name)).toEqual(["启动时新建"]);
  // 之后照常保存（新的数据库实例标识已记下）
  await putTerm(p, "after", "恢复后新建");
  await flush(p);
  expect(readLib().tables.terms).toHaveLength(11);
  expect((await syncState(p)).phase).toBe("saved");
  await ctx.close();
});

test("评审 T5（第 6 项）：library.json 损坏 + 浏览器为空：不覆盖，提示并可从最近的可读备份恢复", async ({ browser }) => {
  wipeData();
  const ctx1 = await browser.newContext({ locale: "zh-CN" });
  const p1 = await ctx1.newPage();
  await boot(p1);
  await putTerm(p1, "t1", "一");
  await flush(p1);
  await putTerm(p1, "t2", "二");
  await flush(p1); // 覆盖 r1 时留下自动备份
  await ctx1.close();
  const broken = '{"format":"paperlens","version":1,"revision":7,"tables":{"terms":[{"id":"t","name":"重要术语"}]';
  writeFileSync(libPath(), broken);

  const ctx = await browser.newContext({ locale: "zh-CN" });
  const p = await ctx.newPage();
  await boot(p);
  const dialog = p.getByTestId("storage-conflict-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-kind", "unreadable");
  await expect(p.getByTestId("storage-status")).toContainText("无法读取");
  await p.waitForTimeout(2500);
  expect(readFileSync(libPath(), "utf8")).toBe(broken);
  await dialog.getByTestId("conflict-recover-backup").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => termNames(p)).toEqual(["一"]);
  await expect(p.getByTestId("storage-notice")).toContainText("已从备份");
  expect(readLib().tables.terms.map((t) => t.name)).toEqual(["一"]);
  expect(backups().some((n) => n.includes("-unreadable"))).toBe(true);
  await ctx.close();
});

test("评审 T6（第 5 项）：负责保存的标签页关闭后，接手的标签页不误报冲突", async ({ browser }) => {
  wipeData();
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const p1 = await ctx.newPage();
  await boot(p1);
  await putTerm(p1, "x0", "基线");
  await flush(p1);
  const p2 = await ctx.newPage();
  await boot(p2);
  const leader = (await p1.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.isLeader())) ? p1 : p2;
  const other = leader === p1 ? p2 : p1;
  await putTerm(leader, "x1", "关闭前的改动");
  await leader.close();
  await expect.poll(() => other.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.isLeader()), { timeout: 10_000 }).toBe(true);
  await flush(other);
  expect((await syncState(other)).conflict).toBeNull();
  expect(readLib().tables.terms.map((t) => t.name).sort()).toEqual(["关闭前的改动", "基线"]);
  await ctx.close();
});

test("评审 T8（第 5、12 项）：改完马上关闭页面：先提示有未保存的改动；再打开不误报冲突", async ({ browser }) => {
  wipeData();
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const p = await ctx.newPage();
  await boot(p);
  await putTerm(p, "a", "一");
  await flush(p);
  await p.click("body"); // beforeunload 提示需要用户与页面交互过
  await putTerm(p, "b", "关闭前改的");
  const dialogs: string[] = [];
  p.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.accept();
  });
  await p.close({ runBeforeUnload: true });
  await expect.poll(() => p.isClosed(), { timeout: 10_000 }).toBe(true);
  expect(dialogs).toContain("beforeunload");
  const p2 = await ctx.newPage();
  await boot(p2);
  await flush(p2);
  await p2.waitForTimeout(1000);
  expect((await syncState(p2)).conflict).toBeNull();
  await expect(p2.getByTestId("storage-conflict-dialog")).toBeHidden();
  expect(readLib().tables.terms.map((t) => t.name).sort()).toEqual(["一", "关闭前改的"]);
  await ctx.close();
});

test("评审 T9（第 7 项）：一个 PDF 被服务拒绝不会挡住后面的 PDF，并在界面上提示", async ({ page, context }) => {
  wipeData();
  await boot(page);
  const bad = await makePdf("BAD one", "bad");
  const badHash = fileHashOf(bad);
  let badHits = 0;
  await context.route(`**/__paperlens/p/*/storage/pdfs/${badHash}`, async (route) => {
    if (route.request().method() === "PUT") {
      badHits++;
      await route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"hash-mismatch","message":"文件内容与哈希不一致"}' });
      return;
    }
    await route.continue();
  });
  await addPaper(page, bad, "p-bad", "Bad");
  await page.waitForTimeout(500);
  const good = await makePdf("GOOD two", "good");
  await addPaper(page, good, "p-good", "Good");
  await expect.poll(() => existsSync(join(PDIR, "pdfs", `${fileHashOf(good)}.pdf`)), { timeout: 20_000 }).toBe(true);
  await flush(page);
  expect(badHits).toBeLessThanOrEqual(2);
  expect((await syncState(page)).failedPdfUploads).toBe(1);
  await page.getByTestId("storage-status").click();
  await expect(page.getByTestId("storage-failed-uploads")).toContainText("1 个 PDF 无法保存到 data/pdfs");
});
