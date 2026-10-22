// @vitest-environment node
// 项目注册表与项目接口：空目录虚拟 default、首次写入才建目录、新建/重命名/删除（移到回收站）、项目之间互不可见、
// 未知项目 404 且不建目录、旧版结构拒绝写入、旧接口 410。全部在临时目录中进行。
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateProjectId, PRESENCE_TTL_MS, PROJECT_ID_RE, ProjectRegistry } from "../../../../server/projects.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const H = { "X-PaperLens": "1" };
const lib = (revision: number, tables: Record<string, unknown[]> = {}) =>
  JSON.stringify({ format: "paperlens", version: 1, exportedAt: new Date().toISOString(), revision, tables });

let s: TestServer;
beforeEach(async () => {
  s = await startTestServer();
});
afterEach(() => s.close());

const api = (path: string, init: RequestInit = {}) => fetch(`${s.apiRoot}${path}`, { ...init, headers: { ...H, ...(init.headers as Record<string, string>) } });
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const listProjects = () => json<{ needsMigration: boolean; projects: { id: string; name: string }[] }>(api("/projects"));
const create = (name: string, id?: string) => api("/projects", { method: "POST", body: JSON.stringify({ name, ...(id ? { id } : {}) }) });
const putLib = (id: string, body: string, base: number) =>
  api(`/p/${id}/storage/library`, { method: "PUT", body, headers: { "X-PaperLens-Base-Revision": String(base) } });
const registry = () => JSON.parse(readFileSync(join(s.dataRoot, "projects.json"), "utf8")) as { version: number; projects: { id: string; name: string }[] };

describe("项目注册表", () => {
  it("空目录：虚拟出 default（我的项目），第一次真正写入时才建 projects.json 和 projects/default/", async () => {
    expect((await listProjects()).projects.map((p) => p.id)).toEqual(["default"]);
    expect(existsSync(s.dataRoot)).toBe(false);
    expect((await putLib("default", lib(1, { terms: [{ id: "t" }] }), 0)).status).toBe(200);
    expect(registry()).toMatchObject({ version: 1, projects: [{ id: "default", name: "我的项目" }] });
    expect(existsSync(join(s.dataDir, "library.json"))).toBe(true);
    expect(readdirSync(s.dataRoot).sort()).toEqual(["projects", "projects.json"]);
  });

  it("新建项目：按名字生成 id、建好目录；各项目的数据互不可见", async () => {
    const r = await create("RoFormer 精读");
    expect(r.status).toBe(200);
    const { project } = (await r.json()) as { project: { id: string; name: string } };
    expect(project.name).toBe("RoFormer 精读");
    expect(project.id).toMatch(/^roformer-[a-z2-9]{4}$/);
    expect(existsSync(join(s.dataRoot, "projects", project.id))).toBe(true);
    // 新建时空目录里的 default 也一起登记
    expect(registry().projects.map((p) => p.id)).toEqual(["default", project.id]);

    expect((await putLib(project.id, lib(1, { terms: [{ id: "only-in-b" }] }), 0)).status).toBe(200);
    expect((await putLib("default", lib(1, { terms: [{ id: "only-in-a" }] }), 0)).status).toBe(200);
    const a = JSON.parse(await (await api("/p/default/storage/library")).text());
    const b = JSON.parse(await (await api(`/p/${project.id}/storage/library`)).text());
    expect(a.tables.terms).toEqual([{ id: "only-in-a" }]);
    expect(b.tables.terms).toEqual([{ id: "only-in-b" }]);
    const st = await json<{ project: { id: string }; dataDirLabel: string; dataDir: string; dataRoot: string }>(api(`/p/${project.id}/storage/status`));
    expect(st.project.id).toBe(project.id);
    expect(st.dataDirLabel).toBe(`data/projects/${project.id}/`);
    expect(st.dataDir).toBe(join(s.dataRoot, "projects", project.id));
    expect(st.dataRoot).toBe(s.dataRoot);

    // 名字里没有英文字母和数字时用随机 id；可以带着浏览器里的 id 登记
    const zh = await json<{ project: { id: string } }>(create("轨迹预测"));
    expect(zh.project.id).toMatch(/^p-[a-z2-9]{6}$/);
    expect((await create("浏览器里建的", "local-abc1")).status).toBe(200);
    expect((await create("重复", "local-abc1")).status).toBe(409);
    expect((await create("", undefined)).status).toBe(400);
    expect((await create("x".repeat(61))).status).toBe(400);
    expect((await create("坏 id", "../x")).status).toBe(400);
  });

  it("未知项目：所有接口 404，不会悄悄建目录", async () => {
    await create("A");
    const before = readdirSync(join(s.dataRoot, "projects")).sort();
    expect((await api("/p/nope/storage/status")).status).toBe(404);
    expect((await putLib("nope", lib(1), 0)).status).toBe(404);
    expect((await api(`/p/nope/storage/pdfs/${"a".repeat(64)}`, { method: "PUT", body: "x" })).status).toBe(404);
    expect((await api("/p/nope/storage/files/markdown", { method: "PUT", body: '{"files":[{"name":"a.md","content":"x"}]}' })).status).toBe(404);
    expect((await api("/p/NOPE/storage/status")).status).toBe(404);
    expect((await api("/p/def%61ult/storage/status")).status).toBe(404);
    expect((await api("/projects/nope", { method: "PATCH", body: '{"name":"x"}' })).status).toBe(404);
    expect((await api("/projects/nope", { method: "DELETE" })).status).toBe(404);
    expect(readdirSync(join(s.dataRoot, "projects")).sort()).toEqual(before);
  });

  it("已登记但目录被手工删掉的项目：写入失败（不重建目录）", async () => {
    const { project } = await json<{ project: { id: string } }>(create("B"));
    rmSync(join(s.dataRoot, "projects", project.id), { recursive: true });
    const r = await putLib(project.id, lib(1, { terms: [{ id: "t" }] }), 0);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe("project-dir-missing");
    expect(existsSync(join(s.dataRoot, "projects", project.id))).toBe(false);
  });

  it("重命名只改名字", async () => {
    const { project } = await json<{ project: { id: string } }>(create("旧名"));
    const r = await json<{ project: { id: string; name: string } }>(api(`/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ name: " 新名 " }) }));
    expect(r.project).toMatchObject({ id: project.id, name: "新名" });
    expect(registry().projects.find((p) => p.id === project.id)?.name).toBe("新名");
    expect((await api(`/projects/${project.id}`, { method: "PATCH", body: '{"name":""}' })).status).toBe(400);
    expect((await api(`/projects/${project.id}`, { method: "PUT", body: '{"name":"x"}' })).status).toBe(405);
  });

  it("删除：目录整个移到 trash/projects/<id>-<时间>/，从列表中去掉；之后 404；不能删最后一个", async () => {
    const { project } = await json<{ project: { id: string } }>(create("要删的"));
    expect((await putLib(project.id, lib(1, { terms: [{ id: "keep-me" }] }), 0)).status).toBe(200);
    const r = await json<{ trashedTo: string }>(api(`/projects/${project.id}`, { method: "DELETE" }));
    expect(r.trashedTo).toMatch(new RegExp(`^trash/projects/${project.id}-\\d{8}-\\d{6}$`));
    const moved = join(s.dataRoot, r.trashedTo);
    expect(JSON.parse(readFileSync(join(moved, "library.json"), "utf8")).tables.terms).toEqual([{ id: "keep-me" }]);
    expect(existsSync(join(moved, ".lock"))).toBe(false);
    expect(existsSync(join(s.dataRoot, "projects", project.id))).toBe(false);
    expect((await listProjects()).projects.map((p) => p.id)).toEqual(["default"]);
    expect((await api(`/p/${project.id}/storage/status`)).status).toBe(404);
    expect((await putLib(project.id, lib(2), 1)).status).toBe(404);
    expect(existsSync(join(s.dataRoot, "projects", project.id))).toBe(false);

    const last = await api("/projects/default", { method: "DELETE" });
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: string }).error).toBe("last-project");
    // 空目录（只有虚拟的 default）同样不能删
    rmSync(s.dataRoot, { recursive: true });
    expect((await api("/projects/default", { method: "DELETE" })).status).toBe(409);
  });

  it("删除等进行中的请求结束后再移动目录", async () => {
    const { project } = await json<{ project: { id: string } }>(create("忙"));
    const held = await s.registry.open(project.id);
    let done = false;
    const removing = s.registry.remove(project.id).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    expect(existsSync(join(s.dataRoot, "projects", project.id))).toBe(true);
    // 删除进行中：新请求已经看不到这个项目
    expect((await api(`/p/${project.id}/storage/status`)).status).toBe(404);
    held.release();
    expect((await removing).trashedTo).toContain(project.id);
  });

  it("上次迁移在写 projects.json 前中断（只有 projects/）：按空目录处理，登记时带上已有的项目目录", async () => {
    mkdirSync(join(s.dataRoot, "projects", "default"), { recursive: true });
    writeFileSync(join(s.dataRoot, "projects", "default", "library.json"), lib(4, { terms: [{ id: "t" }] }));
    mkdirSync(join(s.dataRoot, "projects", "orphan-1"), { recursive: true });
    const st = await json<{ library: { revision: number }; needsMigration: boolean }>(api("/p/default/storage/status"));
    expect(st).toMatchObject({ needsMigration: false, library: { revision: 4 } });
    expect((await putLib("default", lib(5, { terms: [{ id: "t" }] }), 4)).status).toBe(200);
    // 写 library.json 时目录已存在，不必建登记表；新建项目时才登记（含 orphan-1）
    await create("C");
    expect(registry().projects.map((p) => p.id).slice(0, 2)).toEqual(["default", "orphan-1"]);
  });

  it("旧版结构：needsMigration，所有写入 409；projects.json 损坏：500，不写入", async () => {
    mkdirSync(s.dataRoot, { recursive: true });
    writeFileSync(join(s.dataRoot, "library.json"), lib(3, { terms: [{ id: "legacy" }] }));
    expect(await listProjects()).toMatchObject({ needsMigration: true, projects: [] });
    expect(((await json<{ needsMigration: boolean }>(api("/p/default/storage/status"))) as { needsMigration: boolean }).needsMigration).toBe(true);
    for (const r of [await putLib("default", lib(4), 3), await create("x"), await api("/projects/default", { method: "PATCH", body: '{"name":"x"}' })]) {
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe("needs-migration");
    }
    expect(readdirSync(s.dataRoot)).toEqual(["library.json"]);

    rmSync(s.dataRoot, { recursive: true });
    mkdirSync(s.dataRoot, { recursive: true });
    writeFileSync(join(s.dataRoot, "projects.json"), "{broken");
    const r = await api("/projects");
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toBe("registry-unreadable");
    expect((await putLib("default", lib(1), 0)).status).toBe(500);
    expect(readdirSync(s.dataRoot)).toEqual(["projects.json"]);
  });

  it("旧版不分项目的接口一律 410（旧页面写不进来）", async () => {
    for (const [method, p] of [
      ["GET", "/storage/status"],
      ["PUT", "/storage/library"],
      ["PUT", `/storage/pdfs/${"a".repeat(64)}`],
      ["PUT", "/storage/files/markdown"],
      ["GET", "/storage"],
    ]) {
      const r = await api(p, { method, body: method === "PUT" ? lib(1) : undefined, headers: { "X-PaperLens-Base-Revision": "0" } });
      expect(r.status, p).toBe(410);
      expect(((await r.json()) as { error: string }).error).toBe("gone");
    }
    expect(existsSync(s.dataRoot)).toBe(false);
    expect((await api("/nope")).status).toBe(404);
    // 安全检查在路由之前：缺少自定义头时旧接口也是 403
    expect((await fetch(`${s.apiRoot}/storage/status`)).status).toBe(403);
    expect((await fetch(`${s.apiRoot}/projects`)).status).toBe(403);
    expect((await fetch(`${s.apiRoot}/projects`, { method: "POST", headers: { ...H, Origin: "http://evil.example" }, body: '{"name":"x"}' })).status).toBe(403);
  });

  it("评审第 13 项：旧版结构下新建/重命名项目不往 data/ 里写任何东西（连 .lock 都不建）", async () => {
    mkdirSync(s.dataRoot, { recursive: true });
    writeFileSync(join(s.dataRoot, "library.json"), lib(3));
    for (const r of [await create("x"), await api("/projects/default", { method: "PATCH", body: '{"name":"y"}' })]) expect(r.status).toBe(409);
    // 旧版结构下 .lock 被别人拿着时也不会等锁或动它
    mkdirSync(join(s.dataRoot, ".lock"));
    writeFileSync(join(s.dataRoot, ".lock", "owner"), "someone");
    const t0 = Date.now();
    expect((await create("z")).status).toBe(409);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(readFileSync(join(s.dataRoot, ".lock", "owner"), "utf8")).toBe("someone");
    rmSync(join(s.dataRoot, ".lock"), { recursive: true });
    expect(readdirSync(s.dataRoot)).toEqual(["library.json"]);
    // 迁移脚本的标记同样按旧版结构处理
    rmSync(join(s.dataRoot, "library.json"));
    mkdirSync(join(s.dataRoot, "projects", "default"), { recursive: true });
    writeFileSync(join(s.dataRoot, ".paperlens-migrating"), "{}");
    expect((await putLib("default", lib(1), 0)).status).toBe(409);
    expect((await listProjects()).needsMigration).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("评审第 14 项：读目录出错（权限）不当作不存在：500，不写入", async () => {
    mkdirSync(s.dataRoot, { recursive: true });
    chmodSync(s.dataRoot, 0o000);
    try {
      const r = await api("/projects");
      expect(r.status).toBe(500);
      expect((await putLib("default", lib(1), 0)).status).toBe(500);
      expect((await create("x")).status).toBe(500);
    } finally {
      chmodSync(s.dataRoot, 0o755);
    }
    expect(readdirSync(s.dataRoot)).toEqual([]);
  });

  it("评审第 15 项：空目录里不带内容的备份、从备份恢复都不算写入，不建项目", async () => {
    expect(await json(api("/p/default/storage/backups?reason=manual", { method: "POST" }))).toEqual({ name: null });
    expect((await api("/p/default/storage/library/recover", { method: "POST" })).status).toBe(404);
    expect(existsSync(s.dataRoot)).toBe(false);
  });

  it("评审第 10 项：有 projects.json 时根目录下又出现旧版文件，状态接口报告 strayLegacyFiles", async () => {
    expect((await putLib("default", lib(1, { terms: [{ id: "t" }] }), 0)).status).toBe(200);
    expect((await json<{ strayLegacyFiles: string[] }>(api("/p/default/storage/status"))).strayLegacyFiles).toEqual([]);
    // 模拟迁移后又运行了旧版本：它在根目录写了 library.json、pdfs/，把 PDF 移进了根目录的 trash/
    writeFileSync(join(s.dataRoot, "library.json"), lib(1));
    mkdirSync(join(s.dataRoot, "pdfs"));
    mkdirSync(join(s.dataRoot, "trash"));
    writeFileSync(join(s.dataRoot, "trash", `${"a".repeat(64)}.pdf`), "x");
    const st = await json<{ strayLegacyFiles: string[]; library: { revision: number } }>(api("/p/default/storage/status"));
    expect(st.strayLegacyFiles).toEqual(["library.json", "pdfs", `trash/${"a".repeat(64)}.pdf`]);
    expect(st.library.revision).toBe(1); // 读的仍是项目目录
    // 删除的项目放在 trash/projects/：不算
    await create("B");
    const { project } = await json<{ project: { id: string } }>(create("C"));
    await api(`/projects/${project.id}`, { method: "DELETE" });
    expect((await json<{ strayLegacyFiles: string[] }>(api("/p/default/storage/status"))).strayLegacyFiles).not.toContain("trash/projects");
  });

  it("评审第 12 项：其他页面（任何源）最近报告过正在使用的项目不能删除；页面关闭（leave）或超时后可以", async () => {
    const { project } = await json<{ project: { id: string } }>(create("在别处打开"));
    const presence = (method: string, client = "abcdef12") => api(`/p/${project.id}/presence`, { method, headers: { "X-PaperLens-Client": client } });
    expect((await presence("POST")).status).toBe(200);
    expect((await api(`/p/${project.id}/presence`, { method: "POST" })).status).toBe(400); // 缺少页面标识
    expect((await api(`/p/nope/presence`, { method: "POST", headers: { "X-PaperLens-Client": "abcdef12" } })).status).toBe(404);
    const r = await api(`/projects/${project.id}`, { method: "DELETE" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("project-active");
    expect(existsSync(join(s.dataRoot, "projects", project.id))).toBe(true);
    expect((await presence("DELETE")).status).toBe(200);
    expect((await api(`/projects/${project.id}`, { method: "DELETE" })).status).toBe(200);

    // 超时：用可控的时钟
    let now = new Date(2026, 9, 21, 10, 0, 0);
    const reg = new ProjectRegistry({ dir: join(s.root, "data2"), now: () => now });
    const p2 = await reg.create("X");
    await reg.create("Y");
    await reg.touch(p2.id, "client0001");
    await expect(reg.remove(p2.id)).rejects.toMatchObject({ code: "project-active" });
    now = new Date(now.getTime() + PRESENCE_TTL_MS + 1000);
    expect((await reg.remove(p2.id)).trashedTo).toContain(p2.id);
  });

  it("generateProjectId：符合 id 规则、不与已有的重复", () => {
    const taken = new Set<string>();
    for (const name of ["RoFormer 精读", "轨迹预测", "Ünïcödé Ñame", "---", "a".repeat(80), "default"]) {
      const id = generateProjectId(name, taken);
      expect(id).toMatch(PROJECT_ID_RE);
      expect(taken.has(id)).toBe(false);
      expect(id).not.toBe("default");
      taken.add(id);
    }
    expect(generateProjectId("Ünïcödé Ñame", taken)).toMatch(/^unicode-name-/);
  });
});
