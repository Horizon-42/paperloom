/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// 项目（notebook）e2e：新建并切换项目、项目之间完全隔离（论文、批注、术语、画布、术语表、搜索）、
// 两个标签页同时开不同项目（各自索引、各自保存、互不挡对方的选举）、重命名、删除（移到回收站）、
// 旧版目录结构的迁移提示与服务端不写入、旧接口 410、运行迁移脚本后恢复并继续保存、没有本地服务时的多项目。
// 只能用 projects.config.ts 运行（数据目录都在临时目录里）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { assertSafeE2EDataDir } from "./storageSafety";

const ROOT = process.env.PAPERLENS_E2E_PROJECTS_ROOT ? assertSafeE2EDataDir(process.env.PAPERLENS_E2E_PROJECTS_ROOT) : "";
const DATA_A = ROOT ? join(ROOT, "a", "data") : "";
const DATA_B = ROOT ? join(ROOT, "b", "data") : "";
const A = "http://localhost:5401";
const B = "http://localhost:5402";
const OFFLINE = "http://localhost:5403";
const H = { "X-PaperLens": "1" };
const REPO = fileURLToPath(new URL("../..", import.meta.url));

test.skip(!ROOT, "需要用 tests/e2e/projects.config.ts 运行（临时数据目录）");
test.describe.configure({ mode: "serial" });
test.afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyWin = Window & { __paperlens: any; __paperlensStorage: any; [k: string]: any };
interface Row {
  id: string;
  name?: string;
  [k: string]: unknown;
}
interface LibraryDoc {
  revision: number;
  tables: Record<string, Row[]>;
}

function wipe(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
const projDir = (data: string, id: string) => join(data, "projects", id);
const readLib = (data: string, id: string): LibraryDoc => JSON.parse(readFileSync(join(projDir(data, id), "library.json"), "utf8"));
const libTerms = (data: string, id: string) => readLib(data, id).tables.terms.map((t) => t.name).sort();
const registry = (data: string) => JSON.parse(readFileSync(join(data, "projects.json"), "utf8")) as { projects: { id: string; name: string }[] };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || (m.type() === "warning" && /radix|react/i.test(m.text()))) errors.push(m.text());
  });
  return errors;
}

/** 打开页面并等应用加载完、存储探测结束 */
async function boot(page: Page, url: string) {
  await page.goto(url);
  await waitReady(page);
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as AnyWin;
    if (!w.__paperlens || !w.__paperlensStorage) return false;
    const phase = w.__paperlensStorage.useStorageStore.getState().phase;
    return phase !== "probing" && phase !== "restoring";
  });
  await page.evaluate(() => {
    (window as unknown as AnyWin).__load = (p: string) => import(/* @vite-ignore */ p);
  });
}

const info = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as AnyWin;
    return { projectId: w.__paperlens.projectId as string, dbName: w.__paperlens.db.name as string, title: document.title, url: location.href };
  });
const flush = (page: Page) => page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.flush());
const count = (page: Page, table: string) => page.evaluate((t) => (window as unknown as AnyWin).__paperlens.db[t].count() as Promise<number>, table);
const termNames = (page: Page) =>
  page.evaluate(async () => ((await (window as unknown as AnyWin).__paperlens.db.terms.toArray()) as Row[]).map((t) => t.name!).sort());

const termRow = (id: string, name: string) => ({ id, name, aliases: [], matchMode: "auto", scope: { kind: "global" }, note: `${name} 的笔记`, createdAt: 1, updatedAt: 1 });
const putTerm = (page: Page, id: string, name: string) => page.evaluate((t) => (window as unknown as AnyWin).__paperlens.db.terms.put(t), termRow(id, name));

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

async function importPdf(page: Page, title: string, body: string): Promise<string> {
  const pdf = await makePdf(title, body);
  await page.getByTestId("import-input").setInputFiles({ name: `${title.replace(/\W+/g, "_")}.pdf`, mimeType: "application/pdf", buffer: pdf });
  await expect(page.locator("[data-paper-id]").filter({ hasText: title })).toBeVisible();
  return page.evaluate(async (t) => ((await (window as unknown as AnyWin).__paperlens.db.papers.toArray()) as Row[]).find((p) => p.title === t)!.id, title);
}

/** 一条批注、一块画布（含指向批注的节点）、一条自由笔记 */
async function addNotes(page: Page, paperId: string, tag: string) {
  await page.evaluate(
    ({ paperId, tag }) => {
      const { db } = (window as unknown as AnyWin).__paperlens;
      return db.transaction("rw", [db.annotations, db.boards, db.boardNodes, db.notes, db.papers], async () => {
        const paper = await db.papers.get(paperId);
        await db.annotations.put({
          id: `a-${tag}`,
          paperId,
          page: 1,
          rects: [[72, 715, 300, 730]],
          quote: { exact: `quote ${tag}`, prefix: "", suffix: "" },
          fileHash: paper.fileHash,
          color: "#fde68a",
          note: `批注 ${tag}`,
          createdAt: 2,
          updatedAt: 2,
        });
        await db.notes.put({ id: `n-${tag}`, text: `笔记 ${tag}`, createdAt: 1, updatedAt: 1 });
        await db.boards.put({ id: `b-${tag}`, name: `画布 ${tag}`, domainIds: [], createdAt: 1, updatedAt: 1 });
        await db.boardNodes.put({ id: `bn-${tag}`, boardId: `b-${tag}`, ref: { kind: "annotation", id: `a-${tag}` }, x: 0, y: 0, w: 200, h: 100 });
      });
    },
    { paperId, tag },
  );
}

async function waitIndexed(page: Page) {
  await page.evaluate(() => (window as unknown as AnyWin).__load("/src/services/indexer.ts").then((m: any) => m.whenIndexerIdle()));
  await expect.poll(() => count(page, "occurrences"), { timeout: 30_000 }).toBeGreaterThan(0);
}

async function openMenu(page: Page) {
  await page.getByTestId("project-switcher").click();
  const menu = page.getByTestId("project-menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function createViaApi(origin: string, name: string): Promise<string> {
  const res = await fetch(`${origin}/__paperlens/projects`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { project: { id: string } }).project.id;
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d).sort()) {
      const st = statSync(join(d, n));
      if (st.isDirectory()) walk(join(d, n), `${rel}${n}/`);
      else out.push(`${rel}${n}:${st.size}:${st.mtimeMs}`);
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}

async function newPage(context: BrowserContext, url: string) {
  const p = await context.newPage();
  await boot(p, url);
  return p;
}

// ---------------------------------------------------------------------------

let projB = "";

test("新建项目并切换；项目之间完全隔离：论文、批注、术语、画布、术语表、搜索", async ({ page }) => {
  wipe(DATA_A);
  const errors = trackErrors(page);
  await boot(page, `${A}/`);
  // 没有 ?project：打开第一个项目（default），并把它补进 URL
  expect(await info(page)).toMatchObject({ projectId: "default", dbName: "paperlens", title: "我的项目 · Paperloom", url: `${A}/?project=default` });
  await expect(page.getByTestId("project-name")).toHaveText("我的项目");

  const paperId = await importPdf(page, "Alpha Isolation Paper", "Quaternion embeddings improve recall.");
  await addNotes(page, paperId, "alpha");
  await putTerm(page, "t-alpha", "Quaternion");
  await flush(page);
  expect(libTerms(DATA_A, "default")).toEqual(["Quaternion"]);

  // 用菜单新建项目，在本标签页打开
  const menu = await openMenu(page);
  await menu.getByRole("menuitem", { name: "新建项目…" }).click();
  const dialog = page.getByTestId("project-create-dialog");
  await dialog.getByLabel("项目名称").fill("RoFormer 精读");
  await dialog.getByRole("button", { name: "创建并打开" }).click();
  await page.waitForURL(/\?project=roformer-[a-z2-9]{4}$/);
  await waitReady(page);
  const b = await info(page);
  projB = b.projectId;
  expect(b).toMatchObject({ dbName: `paperlens-p-${projB}`, title: "RoFormer 精读 · Paperloom" });
  await expect(page.getByTestId("project-name")).toHaveText("RoFormer 精读");
  expect(registry(DATA_A).projects.map((p) => p.name)).toEqual(["我的项目", "RoFormer 精读"]);
  expect(existsSync(projDir(DATA_A, projB))).toBe(true);

  // 新项目里什么都没有
  for (const t of ["papers", "files", "annotations", "terms", "boards", "boardNodes", "notes", "occurrences", "pageTexts"]) expect(await count(page, t), t).toBe(0);
  await expect(page.locator("[data-paper-id]")).toHaveCount(0);
  await page.getByRole("tab", { name: "术语表" }).click();
  await expect(page.getByTestId("glossary-count")).toHaveText("0 个术语");
  await page.getByRole("tab", { name: "阅读" }).click();
  for (const q of ["Quaternion", "Alpha Isolation", "批注 alpha", "笔记 alpha"]) {
    await page.getByLabel("全局搜索").fill(q);
    await expect(page.getByText(`没有找到与「${q}」匹配的内容`)).toBeVisible();
  }
  await page.getByLabel("全局搜索").fill("");

  // 在新项目里的改动只进它自己的文件夹
  await putTerm(page, "t-beta", "OnlyInB");
  await flush(page);
  expect(libTerms(DATA_A, projB)).toEqual(["OnlyInB"]);
  expect(libTerms(DATA_A, "default")).toEqual(["Quaternion"]);
  const pdfsB = join(projDir(DATA_A, projB), "pdfs");
  expect(existsSync(pdfsB) ? readdirSync(pdfsB) : []).toEqual([]);

  // 切回 default：原来的数据都在，没有 B 的
  const menu2 = await openMenu(page);
  await menu2.locator('[data-project-id="default"]').click();
  await page.waitForURL(/\?project=default$/);
  await waitReady(page);
  expect(await termNames(page)).toEqual(["Quaternion"]);
  expect(await count(page, "annotations")).toBe(1);
  expect(await count(page, "boards")).toBe(1);
  await expect(page.locator("[data-paper-id]").filter({ hasText: "Alpha Isolation Paper" })).toBeVisible();
  await page.getByLabel("全局搜索").fill("OnlyInB");
  await expect(page.getByText("没有找到与「OnlyInB」匹配的内容")).toBeVisible();
  // 上次打开的项目记在本浏览器：不带 ?project 打开时回到它
  expect(await page.evaluate(() => localStorage.getItem("paperlens.lastProject"))).toBe("default");
  expect(errors).toEqual([]);
});

test("两个标签页同时打开不同项目：各自索引、各自保存到自己的文件夹，互不挡对方的选举", async ({ context }) => {
  expect(projB).not.toBe("");
  const pa = await newPage(context, `${A}/?project=default`);
  const pb = await newPage(context, `${A}/?project=${projB}`);
  const errors = [...trackErrors(pa), ...trackErrors(pb)];
  // 两个标签页都负责保存和索引自己的项目
  for (const p of [pa, pb]) {
    expect(await p.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.isLeader())).toBe(true);
    await expect
      .poll(() => p.evaluate(() => (window as unknown as AnyWin).__load("/src/services/indexer.ts").then((m: any) => m.getIndexerDebug()?.leader)))
      .toBe(true);
  }
  // 同一项目的第三个标签页：照常只有一个负责
  const pa2 = await newPage(context, `${A}/?project=default`);
  expect(await pa2.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.isLeader())).toBe(false);
  await pa2.close();

  await importPdf(pb, "Beta Rotary Paper", "Rotary position embedding helps long context.");
  await putTerm(pb, "t-rotary", "Rotary");
  await waitIndexed(pb);
  await waitIndexed(pa);

  // 出现位置写进各自的数据库：B 里只有 Rotary 的，A 里只有 Quaternion 的
  const occ = (p: Page) => p.evaluate(async () => [...new Set(((await (window as unknown as AnyWin).__paperlens.db.occurrences.toArray()) as { termId: string }[]).map((o) => o.termId))]);
  expect(await occ(pb)).toEqual(["t-rotary"]);
  expect(await occ(pa)).toEqual(["t-alpha"]);
  // 匹配确实在 Worker 里做的（Worker 打开的数据库与页面不一致时会退回主线程）
  for (const p of [pa, pb]) {
    const dbg = await p.evaluate(() => (window as unknown as AnyWin).__load("/src/services/indexer.ts").then((m: any) => m.getIndexerDebug()));
    expect(dbg.usesWorker).toBe(true);
  }

  // 同时改两边，各自保存（存储任务也在 Worker 里）
  await Promise.all([putTerm(pa, "t-a2", "AlphaTwo"), putTerm(pb, "t-b2", "BetaTwo")]);
  await Promise.all([flush(pa), flush(pb)]);
  for (const p of [pa, pb]) expect((await p.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.debug())).usesWorker).toBe(true);
  expect(libTerms(DATA_A, "default")).toEqual(["AlphaTwo", "Quaternion"]);
  expect(libTerms(DATA_A, projB)).toEqual(["BetaTwo", "OnlyInB", "Rotary"]);
  expect(readdirSync(join(projDir(DATA_A, projB), "pdfs"))).toHaveLength(1);
  expect(readdirSync(join(projDir(DATA_A, "default"), "pdfs"))).toHaveLength(1);
  // Markdown 也写进各自的文件夹
  expect(existsSync(join(projDir(DATA_A, projB), "markdown", "terms", "Rotary.md"))).toBe(true);
  expect(existsSync(join(projDir(DATA_A, "default"), "markdown", "terms", "Rotary.md"))).toBe(false);
  await expect(pb.getByTestId("storage-status")).toContainText(`已保存到 …/${projB}/`);
  await expect(pa.getByTitle(/数据与备份（.*projects\/default）/)).toBeVisible();
  expect(errors).toEqual([]);
  await pa.close();
  await pb.close();
});

test("重命名、在新标签页打开、删除（移到回收站；其他标签页开着时拒绝）", async ({ page, context }) => {
  const errors = trackErrors(page);
  const projC = await createViaApi(A, "要删除的项目");
  await boot(page, `${A}/?project=default`);
  await page.evaluate(() => (window as unknown as AnyWin).__load("/src/services/projects.ts").then((m: any) => m.refreshProjects()));

  // 重命名当前项目：标题、切换器、projects.json、同项目的其他标签页都更新
  const other = await newPage(context, `${A}/?project=default`);
  let menu = await openMenu(page);
  await menu.getByRole("menuitem", { name: "重命名当前项目…" }).click();
  const rename = page.getByTestId("project-rename-dialog");
  await rename.getByLabel("项目名称").fill("论文精读");
  await rename.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("project-name")).toHaveText("论文精读");
  await expect(page).toHaveTitle("论文精读 · Paperloom");
  await expect(other).toHaveTitle("论文精读 · Paperloom");
  expect(registry(DATA_A).projects.find((p) => p.id === "default")?.name).toBe("论文精读");
  await other.close();

  // 菜单里每个项目都能在新标签页打开
  menu = await openMenu(page);
  const [opened] = await Promise.all([context.waitForEvent("page"), menu.locator(`[data-project-id="${projC}"]`).getByTestId("project-open-new-tab").click()]);
  await opened.waitForLoadState();
  await waitReady(opened);
  expect(await info(opened)).toMatchObject({ projectId: projC, title: "要删除的项目 · Paperloom" });
  expect(await info(page)).toMatchObject({ projectId: "default" }); // 当前标签页不变
  await putTerm(opened, "t-c", "C 的术语");
  await flush(opened);

  // C 正在另一个标签页里打开：不让删
  menu = await openMenu(page);
  await menu.getByRole("menuitem", { name: "管理/删除项目…" }).click();
  const manage = page.getByTestId("project-manage-dialog");
  const row = manage.locator(`li[data-project-id="${projC}"]`);
  await row.getByTestId("project-delete").click();
  await expect(row.getByTestId("project-delete-confirm")).toContainText("数据移到 data/trash/projects/，不会物理删除");
  await row.getByTestId("project-delete-confirm-button").click();
  await expect(manage.getByTestId("project-manage-message")).toContainText("正在其他标签页中打开");
  expect(existsSync(projDir(DATA_A, projC))).toBe(true);
  // 当前项目没有删除按钮
  await expect(manage.locator('li[data-project-id="default"]').getByTestId("project-delete")).toHaveCount(0);

  // 离开页面时撤销"正在使用"的登记（pagehide），服务端才允许删除
  await opened.goto("about:blank");
  await opened.close();
  await page.waitForTimeout(500);
  await row.getByTestId("project-delete-confirm-button").click();
  await expect(manage.getByTestId("project-manage-message")).toContainText(`已删除「要删除的项目」：文件夹已移到 data/trash/projects/${projC}-`);
  expect(existsSync(projDir(DATA_A, projC))).toBe(false);
  const trashed = readdirSync(join(DATA_A, "trash", "projects")).filter((n) => n.startsWith(`${projC}-`));
  expect(trashed).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(DATA_A, "trash", "projects", trashed[0], "library.json"), "utf8")).tables.terms.map((t: Row) => t.name)).toEqual(["C 的术语"]);
  expect(registry(DATA_A).projects.map((p) => p.id)).not.toContain(projC);
  await expect(manage.locator(`li[data-project-id="${projC}"]`)).toHaveCount(0);
  // 本浏览器里它的数据库也删掉了，其他项目的还在
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).not.toContain(`paperlens-p-${projC}`);
  expect(dbs).toContain("paperlens");
  // 再打开已删除项目的地址：提示找不到，不建数据库
  await page.goto(`${A}/?project=${projC}`);
  await expect(page.getByTestId("project-not-found")).toContainText(`找不到项目「${projC}」`);
  await expect(page.getByTestId("project-not-found").getByRole("link", { name: "打开「论文精读」" })).toBeVisible();
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain(`paperlens-p-${projC}`);
  expect(errors).toEqual([]);
});

test("旧版不分项目的接口一律 410：旧页面的写入失败，不会写到别处", async ({ request }) => {
  const before = tree(DATA_A);
  expect((await request.get(`${A}/__paperlens/storage/status`, { headers: H })).status()).toBe(410);
  const put = await request.put(`${A}/__paperlens/storage/library`, {
    headers: { ...H, "X-PaperLens-Base-Revision": "0" },
    data: JSON.stringify({ format: "paperlens", version: 1, revision: 1, tables: {} }),
  });
  expect(put.status()).toBe(410);
  expect((await request.put(`${A}/__paperlens/storage/pdfs/${"a".repeat(64)}`, { headers: H, data: Buffer.from("%PDF") })).status()).toBe(410);
  expect((await request.get(`${A}/__paperlens/storage/status`)).status()).toBe(403); // 安全检查照旧
  expect((await request.get(`${A}/__paperlens/p/nope/storage/status`, { headers: H })).status()).toBe(404);
  expect(tree(DATA_A)).toEqual(before);
});

test("旧版目录结构：提示迁移、服务什么都不写；运行迁移脚本后刷新即恢复并继续保存（default 就是 IndexedDB 里原来的 paperlens）", async ({ page }) => {
  wipe(DATA_B);
  // 1. 先在新结构下存一份数据，再把目录改回旧版结构、同步记录改回旧版的样子（模拟用旧版本一直在用的浏览器）
  await boot(page, `${B}/`);
  const paperId = await importPdf(page, "Legacy Paper", "Old layout content.");
  await addNotes(page, paperId, "legacy");
  await putTerm(page, "t-1", "旧术语一");
  await putTerm(page, "t-2", "旧术语二");
  await flush(page);
  const savedRev = readLib(DATA_B, "default").revision;
  await page.goto("about:blank");
  for (const n of readdirSync(projDir(DATA_B, "default"))) renameSync(join(projDir(DATA_B, "default"), n), join(DATA_B, n));
  rmSync(join(DATA_B, "projects"), { recursive: true });
  rmSync(join(DATA_B, "projects.json"));
  expect(existsSync(join(DATA_B, "library.json"))).toBe(true);

  // 2. 打开页面：阻断提示，自动保存暂停
  const errors = trackErrors(page);
  await boot(page, `${B}/`);
  const notice = page.getByTestId("migration-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("数据需要迁移到项目结构：请运行 npm run migrate:projects");
  await page.keyboard.press("Escape");
  await expect(notice).toBeVisible(); // 关不掉
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-phase", "needs-migration");
  expect(await info(page)).toMatchObject({ projectId: "default", dbName: "paperlens" });
  // 旧版本的同步记录以 data/ 根目录为标识
  const status = await (await fetch(`${B}/__paperlens/p/default/storage/status`, { headers: H })).json();
  expect(status.needsMigration).toBe(true);
  await page.evaluate((root) => {
    const rec = JSON.parse(localStorage.getItem("paperlens:storage:sync")!);
    localStorage.setItem("paperlens:storage:sync", JSON.stringify({ ...rec, dataDir: root }));
  }, status.dataRoot as string);

  // 3. 迁移前在浏览器里的改动留在 IndexedDB，服务端一个字节都不写
  const before = tree(DATA_B);
  await putTerm(page, "t-3", "迁移前新加的");
  await page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.flush());
  await page.waitForTimeout(3000);
  expect(tree(DATA_B)).toEqual(before);
  expect((await fetch(`${B}/__paperlens/storage/status`, { headers: H })).status).toBe(410);

  // 4. 运行迁移脚本（新版服务开着也可以：迁移前它不写）
  const out = execFileSync(process.execPath, [join(REPO, "scripts", "migrate-projects.mjs"), "--data", DATA_B, "--apply", "--ports", "5402", "--no-process-scan", "--name", "迁移来的项目"], {
    encoding: "utf8",
  });
  expect(out).toContain("新版 Paperloom 服务（localhost:5402）");
  expect(out).toContain("迁移完成");
  expect(readdirSync(DATA_B).sort()).toEqual(["projects", "projects.json"]);
  expect(readdirSync(join(ROOT, "b")).some((n) => n.startsWith("data-backup-before-projects-"))).toBe(true);

  // 5. 刷新：没有冲突，迁移前的改动接着保存，revision 接着往上走
  await page.reload();
  await waitReady(page);
  await expect(notice).toBeHidden();
  expect(await info(page)).toMatchObject({ projectId: "default", dbName: "paperlens", title: "迁移来的项目 · Paperloom" });
  expect(await termNames(page)).toEqual(["旧术语一", "旧术语二", "迁移前新加的"]);
  await flush(page);
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-phase", "saved");
  await expect(page.getByTestId("storage-conflict-dialog")).toHaveCount(0);
  const lib = readLib(DATA_B, "default");
  expect(lib.revision).toBe(savedRev + 1);
  expect(lib.tables.terms.map((t) => t.name).sort()).toEqual(["旧术语一", "旧术语二", "迁移前新加的"]);
  expect(lib.tables.annotations).toHaveLength(1);
  expect(readdirSync(join(projDir(DATA_B, "default"), "pdfs"))).toHaveLength(1);
  // 之后的改动照常保存
  await putTerm(page, "t-4", "迁移后");
  await flush(page);
  expect(readLib(DATA_B, "default").tables.terms.map((t) => t.name)).toContain("迁移后");

  // 6. 清除浏览器数据后也能从迁移后的文件夹恢复
  await page.goto("about:blank");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Storage.clearDataForOrigin", { origin: B, storageTypes: "all" });
  await cdp.detach();
  await boot(page, `${B}/`);
  await expect(page.getByTestId("storage-notice")).toContainText("已从");
  expect(await termNames(page)).toEqual(["旧术语一", "旧术语二", "迁移前新加的", "迁移后"].sort());
  expect(errors).toEqual([]);
});

test("没有本地服务：项目列表只在本浏览器，照样可以新建、切换、删除", async ({ page }) => {
  const errors = trackErrors(page);
  await boot(page, `${OFFLINE}/`);
  expect(await info(page)).toMatchObject({ projectId: "default", dbName: "paperlens" });
  await putTerm(page, "t-off", "默认项目的术语");
  const menu = await openMenu(page);
  await expect(menu).toContainText("未连接本地服务：列表只保存在本浏览器");
  await menu.getByRole("menuitem", { name: "新建项目…" }).click();
  const dialog = page.getByTestId("project-create-dialog");
  await expect(dialog).toContainText("新项目只保存在本浏览器中");
  await dialog.getByLabel("项目名称").fill("离线项目");
  await dialog.getByRole("button", { name: "创建并打开" }).click();
  await page.waitForURL(/\?project=p-[a-z2-9]{6}$/);
  await waitReady(page);
  const { projectId, dbName } = await info(page);
  expect(dbName).toBe(`paperlens-p-${projectId}`);
  expect(await count(page, "terms")).toBe(0);
  await putTerm(page, "t-off2", "离线项目的术语");
  const list = await page.evaluate(() => JSON.parse(localStorage.getItem("paperlens.projects")!));
  expect(list.map((p: { name: string; localOnly?: boolean }) => [p.name, !!p.localOnly])).toEqual([
    ["我的项目", false],
    ["离线项目", true],
  ]);

  await boot(page, `${OFFLINE}/?project=default`);
  expect(await termNames(page)).toEqual(["默认项目的术语"]);
  const m2 = await openMenu(page);
  await m2.getByRole("menuitem", { name: "管理/删除项目…" }).click();
  const manage = page.getByTestId("project-manage-dialog");
  const row = manage.locator(`li[data-project-id="${projectId}"]`);
  await row.getByTestId("project-delete").click();
  // 只在本浏览器里的项目：浏览器里的就是唯一一份，删除前先下载备份
  await expect(row.getByTestId("project-delete-confirm")).toContainText("删除前会先下载一份 JSON 备份");
  const [download] = await Promise.all([page.waitForEvent("download"), row.getByTestId("project-delete-confirm-button").click()]);
  expect(JSON.parse(readFileSync((await download.path())!, "utf8")).tables.terms.map((t: Row) => t.name)).toEqual(["离线项目的术语"]);
  await expect(manage.getByTestId("project-manage-message")).toContainText("已删除「离线项目」");
  await expect(manage.getByTestId("project-manage-message")).toContainText("删除前已下载备份");
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain(`paperlens-p-${projectId}`);
  expect(errors).toEqual([]);
});

test("评审第 10 项：迁移后又运行过一次旧版本（根目录被写回旧结构、同步记录指回根目录）：不快进覆盖浏览器数据，提示冲突和根目录残留", async ({ page, context }) => {
  // 接着上一个用例：DATA_B 已迁移，default 项目已保存
  await boot(page, `${B}/?project=default`);
  await flush(page);
  const saved = readLib(DATA_B, "default");
  await page.goto("about:blank");

  // 模拟旧版本运行了一次：页面连不上新接口（旧 JS），浏览器里多了一条改动，旧版服务把它写进了根目录的 library.json（r1）
  await context.route("**/__paperlens/**", (r) => r.abort("connectionrefused"));
  await boot(page, `${B}/?project=default`);
  expect(await page.evaluate(() => (window as unknown as AnyWin).__paperlensStorage.useStorageStore.getState().phase)).toBe("offline");
  await putTerm(page, "t-old", "C-回退旧版时的改动");
  const localHash = await page.evaluate(async () => {
    const w = window as unknown as AnyWin;
    const { storageTasks } = await w.__load("/src/services/storage/tasks.ts");
    return (await storageTasks.inspectLocal({ db: w.__paperlens.db })).hash as string;
  });
  const status = await (await fetch(`${B}/__paperlens/p/default/storage/status`, { headers: H })).json();
  await page.evaluate(
    ({ root, hash }) => localStorage.setItem("paperlens:storage:sync", JSON.stringify({ dataDir: root, revision: 1, hash })),
    { root: status.dataRoot as string, hash: localHash },
  );
  writeFileSync(join(DATA_B, "library.json"), JSON.stringify({ format: "paperlens", version: 1, revision: 1, contentHash: localHash, tables: { terms: [] } }));
  mkdirSync(join(DATA_B, "pdfs"), { recursive: true });
  await page.goto("about:blank");
  await context.unroute("**/__paperlens/**");

  // 再用新版本打开：同步记录对不上项目文件夹 → 当作不知道 → 冲突，浏览器里的改动还在；根目录残留有提示
  await boot(page, `${B}/?project=default`);
  await expect(page.getByTestId("storage-status")).toHaveAttribute("data-phase", "conflict");
  await expect(page.getByTestId("storage-conflict-dialog")).toBeVisible();
  await page.waitForTimeout(3000);
  expect(await termNames(page)).toContain("C-回退旧版时的改动");
  expect(readLib(DATA_B, "default").revision).toBe(saved.revision);
  await page.getByTestId("storage-conflict-dialog").getByRole("button", { name: "关闭" }).click().catch(() => {});
  await page.keyboard.press("Escape");
  const warn = page.getByTestId("stray-legacy-warning");
  await expect(warn).toBeVisible();
  await expect(warn).toContainText("library.json");
  await expect(warn).toContainText("pdfs");
  // 迁移脚本也报告这些残留
  const out = execFileSync(process.execPath, [join(REPO, "scripts", "migrate-projects.mjs"), "--data", DATA_B, "--ports", "none", "--no-process-scan"], { encoding: "utf8" });
  expect(out).toContain("根目录下还有不属于项目结构的条目：library.json、pdfs");
});

test("评审第 11 项：浏览器里有尚未保存到文件夹的内容时不删浏览器里的数据库；可以只删文件夹，之后在\"找不到项目\"页面导出", async ({ page, context }) => {
  const id = await createViaApi(A, "未同步就删除");
  const pu = await newPage(context, `${A}/?project=${id}`);
  pu.on("dialog", (d) => void d.accept());
  await putTerm(pu, "t1", "已保存的");
  await flush(pu);
  // 之后的保存失败（模拟磁盘或权限问题）
  await context.route(`**/__paperlens/p/${id}/storage/library`, (r) =>
    r.request().method() === "PUT" ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"internal","message":"EACCES"}' }) : r.continue(),
  );
  await putTerm(pu, "t2", "没保存上的");
  await expect(pu.getByTestId("storage-status")).toHaveAttribute("data-phase", "error", { timeout: 15_000 });
  await pu.goto("about:blank");
  await pu.close();
  await context.unroute(`**/__paperlens/p/${id}/storage/library`);

  await boot(page, `${A}/?project=default`);
  await page.evaluate(() => (window as unknown as AnyWin).__load("/src/services/projects.ts").then((m: any) => m.refreshProjects()));
  const menu = await openMenu(page);
  await menu.getByRole("menuitem", { name: "管理/删除项目…" }).click();
  const manage = page.getByTestId("project-manage-dialog");
  const row = manage.locator(`li[data-project-id="${id}"]`);
  await row.getByTestId("project-delete").click();
  await row.getByTestId("project-delete-confirm-button").click();
  await expect(manage.getByTestId("project-manage-message")).toContainText("尚未保存到文件夹");
  expect(existsSync(projDir(DATA_A, id))).toBe(true);
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).toContain(`paperlens-p-${id}`);

  // 只删文件夹（移到回收站），保留浏览器里的数据库
  await row.getByTestId("project-delete-keep-browser").click();
  await expect(manage.getByTestId("project-manage-message")).toContainText("数据库已保留");
  expect(existsSync(projDir(DATA_A, id))).toBe(false);
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).toContain(`paperlens-p-${id}`);

  // 打开它的地址：找不到项目，但可以导出浏览器里的数据（含没保存上的那条）
  await page.goto(`${A}/?project=${id}`);
  await expect(page.getByTestId("project-not-found-local")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("project-not-found-export").click()]);
  const doc = JSON.parse(readFileSync((await download.path())!, "utf8"));
  expect(doc.tables.terms.map((t: Row) => t.name).sort()).toEqual(["已保存的", "没保存上的"]);
});

test("评审第 12 项：另一个地址（127.0.0.1）正打开着的项目，在 localhost 上不能删除；那边关闭后可以", async ({ page, context }) => {
  const id = await createViaApi(A, "跨源删除测试");
  const other = await newPage(context, `http://127.0.0.1:5401/?project=${id}`);
  await putTerm(other, "t1", "另一边的");
  await flush(other);
  await boot(page, `${A}/?project=default`);
  await page.evaluate(() => (window as unknown as AnyWin).__load("/src/services/projects.ts").then((m: any) => m.refreshProjects()));
  const menu = await openMenu(page);
  await menu.getByRole("menuitem", { name: "管理/删除项目…" }).click();
  const manage = page.getByTestId("project-manage-dialog");
  const row = manage.locator(`li[data-project-id="${id}"]`);
  await row.getByTestId("project-delete").click();
  await row.getByTestId("project-delete-confirm-button").click();
  await expect(manage.getByTestId("project-manage-message")).toContainText("正在别的窗口中打开");
  expect(existsSync(projDir(DATA_A, id))).toBe(true);
  await other.goto("about:blank");
  await other.close();
  await page.waitForTimeout(500);
  await row.getByTestId("project-delete-confirm-button").click();
  await expect(manage.getByTestId("project-manage-message")).toContainText("已删除「跨源删除测试」");
});

test("迁移脚本预览不改动任何东西（在临时的旧版目录上）", async () => {
  const dir = join(ROOT, "dry", "data");
  mkdirSync(join(dir, "pdfs"), { recursive: true });
  const lib = JSON.stringify({ format: "paperlens", version: 1, revision: 3, tables: { terms: [{ id: "t" }], papers: [] } });
  writeFileSync(join(dir, "library.json"), lib);
  const before = tree(join(ROOT, "dry"));
  const out = execFileSync(process.execPath, [join(REPO, "scripts", "migrate-projects.mjs"), "--data", dir, "--ports", "none", "--no-process-scan"], { encoding: "utf8" });
  expect(out).toContain("预览（dry run，不改动任何文件）");
  expect(tree(join(ROOT, "dry"))).toEqual(before);
});
