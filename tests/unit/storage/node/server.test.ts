// @vitest-environment node
// 本地存储服务：安全检查、library.json 的乐观并发与备份、PDF 校验与回收站、附加文件组。全部在临时目录中进行。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupsToPrune, validateRelativeName } from "../../../../server/storageFs.ts";
import { checkRequest, isLoopbackAddress, isLoopbackHost, type RequestFacts } from "../../../../server/storageHandler.ts";
import { paperlensStorage, resolveStorageSettings } from "../../../../server/storagePlugin.ts";
import { startTestServer, type TestServer } from "./harness.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const H = { "X-PaperLens": "1" };

function lib(revision: number, tables: Record<string, unknown[]> = {}, version = 1) {
  return JSON.stringify({ format: "paperlens", version, exportedAt: new Date().toISOString(), revision, tables });
}

function put(s: TestServer, body: string, base: number) {
  return fetch(`${s.base}/library`, { method: "PUT", body, headers: { ...H, "X-PaperLens-Base-Revision": String(base) } });
}

// ---------------------------------------------------------------------------

describe("checkRequest", () => {
  const ok: RequestFacts = {
    method: "GET",
    remoteAddress: "127.0.0.1",
    localPort: 5173,
    headers: { host: "localhost:5173", "x-paperlens": "1" },
  };
  const with_ = (patch: Partial<RequestFacts>, headers: Record<string, string | undefined> = {}) =>
    checkRequest({ ...ok, ...patch, headers: { ...ok.headers, ...headers } });

  it("接受本机同源请求", () => {
    expect(checkRequest(ok)).toBeNull();
    expect(with_({}, { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" })).toBeNull();
    expect(with_({ remoteAddress: "::1" }, { host: "[::1]:5173", origin: "http://[::1]:5173" })).toBeNull();
    expect(with_({ remoteAddress: "::ffff:127.0.0.1" }, { host: "127.0.0.1:5173" })).toBeNull();
  });

  it("只接受回环地址", () => {
    expect(with_({ remoteAddress: "192.168.1.20" })?.code).toBe("not-loopback");
    expect(with_({ remoteAddress: "::ffff:10.0.0.2" })?.code).toBe("not-loopback");
    expect(with_({ remoteAddress: undefined })?.code).toBe("not-loopback");
    expect(isLoopbackAddress("127.8.9.10")).toBe(true);
    expect(isLoopbackAddress("1270.0.0.1")).toBe(false);
  });

  it("Host 必须是本机名且端口一致（防 DNS 重绑定）", () => {
    expect(with_({}, { host: "evil.example:5173" })?.code).toBe("bad-host");
    expect(with_({}, { host: "localhost.evil.example:5173" })?.code).toBe("bad-host");
    expect(with_({}, { host: "localhost:5174" })?.code).toBe("bad-host");
    expect(with_({}, { host: undefined })?.code).toBe("bad-host");
    expect(isLoopbackHost("localhost", 80)).toBe(true);
    expect(isLoopbackHost("127.0.0.1.nip.io:5173", 5173)).toBe(false);
  });

  it("拒绝其他网站的请求", () => {
    expect(with_({}, { origin: "http://evil.example" })?.code).toBe("bad-origin");
    expect(with_({}, { origin: "http://localhost:3000" })?.code).toBe("bad-origin");
    expect(with_({}, { origin: "null" })?.code).toBe("bad-origin");
    expect(with_({}, { "sec-fetch-site": "cross-site" })?.code).toBe("cross-site");
    expect(with_({}, { "sec-fetch-site": "same-site" })?.code).toBe("cross-site");
  });

  it("必须带自定义请求头；预检一律拒绝", () => {
    expect(with_({}, { "x-paperlens": undefined })?.code).toBe("missing-header");
    expect(with_({}, { "x-paperlens": "0" })?.code).toBe("missing-header");
    expect(with_({ method: "OPTIONS" })?.code).toBe("preflight");
  });
});

describe("validateRelativeName", () => {
  it("接受普通相对路径", () => {
    expect(validateRelativeName("terms/LSTM.md")).toEqual(["terms", "LSTM.md"]);
    expect(validateRelativeName("方法对比.canvas")).toEqual(["方法对比.canvas"]);
  });
  it.each([
    "../x.md",
    "a/../../x.md",
    "/etc/passwd",
    "C:/x.md",
    "a\\b.md",
    "a//b.md",
    ".hidden.md",
    ".paperlens-manifest.json",
    "a/./b.md",
    "bad\u0000.md",
    "bad\n.md",
    "trailing.",
    "trailing ",
    "a:b.md",
    "",
    `${"长".repeat(90)}.md`, // 超过 255 字节
  ])("拒绝 %j", (name) => {
    expect(validateRelativeName(name)).toBeNull();
  });
});

describe("backupsToPrune", () => {
  it("保留最近 N 个，外加最近若干天每天最后一个；带原因的单独计数", () => {
    const names: string[] = [];
    for (let d = 1; d <= 5; d++) for (let h = 0; h < 3; h++) names.push(`library-202610${String(d).padStart(2, "0")}-${String(h * 3).padStart(2, "0")}0000-r${d * 10 + h}.json`);
    names.push("library-20261005-120000-r99-before-import.json", "library-20261004-120000-r98-before-import.json", "notes.txt");
    const del = backupsToPrune(names, 4, 3, 1);
    const kept = names.filter((n) => !del.includes(n));
    // 最近 4 个：10-05 的 3 个 + 10-04 06:00；每天最后一个：10-05、10-04、10-03（各取 06:00）
    expect(kept).toEqual(
      expect.arrayContaining([
        "library-20261005-000000-r50.json",
        "library-20261005-030000-r51.json",
        "library-20261005-060000-r52.json",
        "library-20261004-060000-r42.json",
        "library-20261003-060000-r32.json",
        "library-20261005-120000-r99-before-import.json",
        "notes.txt",
      ]),
    );
    expect(kept).toHaveLength(7);
    expect(del).toContain("library-20261004-120000-r98-before-import.json");
  });
});

describe("paperlensStorage", () => {
  it("数据目录和迁移前的完整备份不需要 Vite 监听，也加入 fs.deny", () => {
    const plugin = paperlensStorage();
    const hook = plugin.config as (c: { root?: string }) => { server: { watch: { ignored: string[] }; fs: { deny: string[] } } };
    const cfg = hook({ root: "/proj" }).server;
    expect(cfg.watch.ignored).toEqual(["/proj/data/**", "/proj/data-backup-before-projects-*/**"]);
    expect(cfg.fs.deny).toEqual(expect.arrayContaining(["/proj/data", "/proj/data/**", "/proj/data-backup-before-projects-*", "/proj/data-backup-before-projects-*/**"]));
  });
});

describe("resolveStorageSettings", () => {
  it("默认 <root>/data；环境变量可覆盖或关闭", () => {
    expect(resolveStorageSettings("/proj", {}, {})).toEqual({ enabled: true, dataDir: "/proj/data" });
    expect(resolveStorageSettings("/proj", {}, { PAPERLENS_DATA_DIR: "/tmp/x" }).dataDir).toBe("/tmp/x");
    expect(resolveStorageSettings("/proj", {}, { PAPERLENS_DATA_DIR: "rel" }).dataDir).toBe("/proj/rel");
    expect(resolveStorageSettings("/proj", {}, { PAPERLENS_STORAGE: "off" }).enabled).toBe(false);
    expect(resolveStorageSettings("/proj", {}, { VITEST: "true" }).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("HTTP 接口", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await startTestServer({ limits: { maxJsonBytes: 64 * 1024, maxPdfBytes: 32 * 1024 } });
  });
  afterEach(() => s.close());

  it("探测状态、列出项目都不创建数据目录", async () => {
    const res = await fetch(`${s.base}/status`, { headers: H });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { service: string; library: { exists: boolean; revision: number }; project: { id: string }; dataDirLabel: string };
    expect(body.service).toBe("paperlens-storage");
    expect(body.library).toMatchObject({ exists: false, revision: 0 });
    expect(body.project.id).toBe("default");
    expect(body.dataDirLabel).toBe("data/projects/default/");
    const list = (await (await fetch(`${s.apiRoot}/projects`, { headers: H })).json()) as { needsMigration: boolean; projects: { id: string; name: string }[] };
    expect(list.needsMigration).toBe(false);
    expect(list.projects.map((p) => [p.id, p.name])).toEqual([["default", "我的项目"]]);
    // 空的附加文件组也不算写入
    expect((await fetch(`${s.base}/files/markdown`, { method: "PUT", headers: H, body: '{"files":[]}' })).status).toBe(200);
    expect(existsSync(s.dataRoot)).toBe(false);
  });

  it("缺少自定义头、外来 Origin、跨站请求、预检都被拒绝，且不带 CORS 头", async () => {
    const r1 = await fetch(`${s.base}/status`);
    expect(r1.status).toBe(403);
    const r2 = await fetch(`${s.base}/library`, { headers: { ...H, Origin: "http://evil.example" } });
    expect(r2.status).toBe(403);
    const r3 = await fetch(`${s.base}/status`, { headers: { ...H, "Sec-Fetch-Site": "cross-site" } });
    expect(r3.status).toBe(403);
    const r4 = await fetch(`${s.base}/library`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "x-paperlens" },
    });
    expect(r4.status).toBe(403);
    expect(r4.headers.get("access-control-allow-origin")).toBeNull();
    // 外来 Origin 写入也不行
    const r5 = await fetch(`${s.base}/library`, { method: "PUT", body: lib(1), headers: { ...H, Origin: "http://evil.example", "X-PaperLens-Base-Revision": "0" } });
    expect(r5.status).toBe(403);
    expect(existsSync(join(s.dataDir, "library.json"))).toBe(false);
  });

  it.skipIf(!Object.values(networkInterfaces()).flat().some((i) => i && i.family === "IPv4" && !i.internal))(
    "用局域网地址访问时拒绝（相当于 --host 启动）",
    async () => {
      const { createServer } = await import("node:http");
      const { createStorageHandler } = await import("../../../../server/storageHandler.ts");
      const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)!.address;
      const handler = createStorageHandler({ registry: s.registry });
      const server = createServer((req, res) => handler(req, res, () => res.end("next")));
      await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
      try {
        const port = (server.address() as { port: number }).port;
        for (const p of ["/__paperlens/p/default/storage/status", "/__paperlens/projects", "/__paperlens/storage/status"]) {
          const res = await fetch(`http://${lan}:${port}${p}`, { headers: H });
          expect(res.status, p).toBe(403);
          expect(((await res.json()) as { error: string }).error).toBe("not-loopback");
        }
      } finally {
        server.closeAllConnections();
        server.close();
      }
    },
  );

  it("路径参数白名单：非法哈希、编码过的路径、未知接口", async () => {
    expect((await fetch(`${s.base}/pdfs/ABC`, { headers: H })).status).toBe(400);
    expect((await fetch(`${s.base}/pdfs/${"A".repeat(64)}`, { headers: H })).status).toBe(400);
    expect((await fetch(`${s.base}/pdfs/..%2F..%2Fetc%2Fpasswd`, { headers: H })).status).toBe(400);
    expect((await fetch(`${s.base}/pdfs/${"a".repeat(64)}/x`, { headers: H })).status).toBe(404);
    // fetch 会把 "files/.." 规范化成上一级路径，同样匹配不到接口
    expect((await fetch(`${s.base}/files/..`, { method: "PUT", headers: H, body: '{"files":[]}' })).status).toBe(404);
    expect((await fetch(`${s.base}/files/a.b`, { method: "PUT", headers: H, body: '{"files":[]}' })).status).toBe(400);
    expect((await fetch(`${s.base}/files/pdfs`, { method: "PUT", headers: H, body: '{"files":[]}' })).status).toBe(400);
    expect((await fetch(`${s.base}/backups?reason=../x`, { method: "POST", headers: H })).status).toBe(400);
    expect((await fetch(`${s.base}/nope`, { headers: H })).status).toBe(404);
    expect((await fetch(`${s.base}/status`, { method: "DELETE", headers: H })).status).toBe(405);
  });

  it("library.json：原子写入、revision 校验、冲突返回 409", async () => {
    const r1 = await put(s, lib(1, { papers: [], terms: [{ id: "t1" }] }), 0);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ revision: 1, hasData: true });

    // 另一个源还以为是 0
    const stale = await put(s, lib(1), 0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "conflict", revision: 1 });

    // base 对了但 revision 没 +1
    expect((await put(s, lib(5), 1)).status).toBe(400);
    expect((await put(s, "{not json", 1)).status).toBe(400);
    expect((await put(s, JSON.stringify({ format: "other", version: 1, tables: {} }), 1)).status).toBe(400);
    expect((await fetch(`${s.base}/library`, { method: "PUT", body: lib(2), headers: H })).status).toBe(400); // 缺 base

    const r2 = await put(s, lib(2, { terms: [{ id: "t1" }, { id: "t2" }] }), 1);
    expect(r2.status).toBe(200);
    const get = await fetch(`${s.base}/library`, { headers: H });
    expect(get.headers.get("x-paperlens-revision")).toBe("2");
    expect(JSON.parse(await get.text()).tables.terms).toHaveLength(2);
    // 没有残留的临时文件
    expect(readdirSync(s.dataDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    // 直接改文件里的 revision（模拟另一个源写入）也能发现
    const file = join(s.dataDir, "library.json");
    writeFileSync(file, lib(7, { terms: [{ id: "x" }] }));
    expect((await put(s, lib(3), 2)).status).toBe(409);
    const st = (await (await fetch(`${s.base}/status`, { headers: H })).json()) as { library: { revision: number; counts: Record<string, number> } };
    expect(st.library.revision).toBe(7);
    expect(st.library.counts.terms).toBe(1);
  });

  it("请求体超过上限返回 413", async () => {
    const big = lib(1, { notes: [{ id: "n", text: "x".repeat(70 * 1024) }] });
    const res = await put(s, big, 0);
    expect(res.status).toBe(413);
    expect(existsSync(join(s.dataDir, "library.json"))).toBe(false);
  });

  it("文件夹里是更新的数据格式时，旧版本不能覆盖", async () => {
    mkdirSync(s.dataDir, { recursive: true });
    writeFileSync(join(s.dataDir, "library.json"), lib(3, { terms: [{ id: "t" }] }, 2));
    const res = await put(s, lib(4), 3);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("newer-format");
  });

  it("PDF：哈希不符拒绝；已存在不重写；不再引用的移到回收站，重新引用时移回", async () => {
    const pdf = Buffer.from("%PDF-1.7\nhello\n%%EOF");
    const hash = sha(pdf);
    const bad = await fetch(`${s.base}/pdfs/${hash}`, { method: "PUT", headers: H, body: Buffer.from("%PDF-1.7\nevil") });
    expect(bad.status).toBe(400);
    expect(existsSync(join(s.dataDir, "pdfs", `${hash}.pdf`))).toBe(false);
    expect(readdirSync(join(s.dataDir, "pdfs"))).toEqual([]); // 临时文件已删

    const ok = await fetch(`${s.base}/pdfs/${hash}`, { method: "PUT", headers: H, body: pdf });
    expect(await ok.json()).toEqual({ stored: true });
    const again = await fetch(`${s.base}/pdfs/${hash}`, { method: "PUT", headers: H, body: pdf });
    expect(await again.json()).toEqual({ stored: false });
    expect(await (await fetch(`${s.base}/pdfs`, { headers: H })).json()).toEqual({ hashes: [hash], trashed: [] });

    const tooBig = Buffer.alloc(40 * 1024, 1);
    expect((await fetch(`${s.base}/pdfs/${sha(tooBig)}`, { method: "PUT", headers: H, body: tooBig })).status).toBe(413);

    // library 不再引用 → 回收站；读取仍可用
    await put(s, lib(1, { papers: [] }), 0);
    expect(await (await fetch(`${s.base}/pdfs`, { headers: H })).json()).toEqual({ hashes: [], trashed: [hash] });
    const got = await fetch(`${s.base}/pdfs/${hash}`, { headers: H });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await got.arrayBuffer()).equals(pdf)).toBe(true);

    // 恢复引用 → 移回 pdfs/
    await put(s, lib(2, { papers: [{ id: "p", fileHash: hash }] }), 1);
    expect(await (await fetch(`${s.base}/pdfs`, { headers: H })).json()).toEqual({ hashes: [hash], trashed: [] });
    expect((await fetch(`${s.base}/pdfs/${"0".repeat(64)}`, { headers: H })).status).toBe(404);
  });

  it("备份：每小时最多一个自动备份；数据骤减时额外备份；手动备份带原因", async () => {
    let now = new Date(2026, 9, 21, 10, 0, 0);
    await s.close();
    s = await startTestServer({ store: { now: () => now } });
    const backups = () => (existsSync(join(s.dataDir, "backups")) ? readdirSync(join(s.dataDir, "backups")).sort() : []);
    const terms = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));

    await put(s, lib(1, { terms: terms(10) }), 0);
    expect(backups()).toEqual([]); // 第一次写入没有旧文件
    await put(s, lib(2, { terms: terms(10) }), 1);
    expect(backups()).toEqual(["library-20261021-100000-r1.json.gz"]);
    now = new Date(2026, 9, 21, 10, 30, 0);
    await put(s, lib(3, { terms: terms(11) }), 2);
    expect(backups()).toHaveLength(1); // 不到一小时
    now = new Date(2026, 9, 21, 10, 40, 0);
    const shrink = await put(s, lib(4, { terms: terms(2) }), 3); // 骤减：留一份，并告诉客户端文件名
    expect(((await shrink.json()) as { backup?: string }).backup).toBe("library-20261021-104000-r3-shrink.json.gz");
    expect(backups()).toContain("library-20261021-104000-r3-shrink.json.gz");
    now = new Date(2026, 9, 21, 11, 5, 0);
    await put(s, lib(5, { terms: terms(2) }), 4);
    expect(backups()).toContain("library-20261021-110500-r4.json.gz");
    // 备份是 gzip 压缩的覆盖前的版本
    expect(JSON.parse(gunzipSync(readFileSync(join(s.dataDir, "backups", "library-20261021-110500-r4.json.gz"))).toString()).revision).toBe(4);

    const m1 = await fetch(`${s.base}/backups?reason=before-overwrite`, { method: "POST", headers: H });
    expect(await m1.json()).toEqual({ name: "library-20261021-110500-r5-before-overwrite.json.gz" });
    const m2 = await fetch(`${s.base}/backups?reason=browser-before-load`, { method: "POST", headers: H, body: lib(9, { terms: terms(1) }) });
    expect(((await m2.json()) as { name: string }).name).toBe("library-20261021-110500-r9-browser-before-load.json.gz");
    expect((await fetch(`${s.base}/backups?reason=x`, { method: "POST", headers: H, body: "nope" })).status).toBe(400);
  });

  it("附加文件组：内容不变不重写，旧文件按清单删除，用户自己的文件不动", async () => {
    const putFiles = (group: string, files: { name: string; content: string }[]) =>
      fetch(`${s.base}/files/${group}`, { method: "PUT", headers: H, body: JSON.stringify({ files }) });
    const dir = join(s.dataDir, "canvas");
    let r = await putFiles("canvas", [
      { name: "方法对比.canvas", content: "{}" },
      { name: "sub/旧画布.canvas", content: "{}" },
    ]);
    expect(await r.json()).toEqual({ written: 2, unchanged: 0, deleted: 0, replaced: 0, missing: [] });
    writeFileSync(join(dir, "我的笔记.md"), "用户自己的文件");
    const mtime = statSync(join(dir, "方法对比.canvas")).mtimeMs;

    r = await putFiles("canvas", [{ name: "方法对比.canvas", content: "{}" }]);
    expect(await r.json()).toEqual({ written: 0, unchanged: 1, deleted: 1, replaced: 0, missing: [] });
    expect(statSync(join(dir, "方法对比.canvas")).mtimeMs).toBe(mtime);
    expect(existsSync(join(dir, "sub"))).toBe(false); // 空目录也删掉
    expect(readFileSync(join(dir, "我的笔记.md"), "utf8")).toBe("用户自己的文件");

    r = await putFiles("canvas", []);
    expect(await r.json()).toEqual({ written: 0, unchanged: 0, deleted: 1, replaced: 0, missing: [] });
    expect(readdirSync(dir).sort()).toEqual([".paperlens-manifest.json", "我的笔记.md"]);

    expect((await putFiles("canvas", [{ name: "../escape.canvas", content: "" }])).status).toBe(400);
    expect((await putFiles("canvas", [{ name: ".paperlens-manifest.json", content: "" }])).status).toBe(400);
    expect((await putFiles("canvas", [{ name: "A.md", content: "" }, { name: "a.md", content: "" }])).status).toBe(400);
    expect((await putFiles("Canvas", [])).status).toBe(400);
    expect(existsSync(join(s.dataDir, "escape.canvas"))).toBe(false);
  });

  it("不能通过静态文件服务直接读取数据目录（含 projects.json、trash/ 和迁移备份）", async () => {
    mkdirSync(s.dataDir, { recursive: true });
    writeFileSync(join(s.dataDir, "library.json"), lib(1));
    writeFileSync(join(s.dataRoot, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "default", name: "x", createdAt: 1, updatedAt: 1 }] }));
    mkdirSync(join(s.dataRoot, "trash", "projects", "old-1"), { recursive: true });
    writeFileSync(join(s.dataRoot, "trash", "projects", "old-1", "library.json"), lib(1));
    mkdirSync(join(s.root, "data-backup-before-projects-20261021-120000"), { recursive: true });
    writeFileSync(join(s.root, "data-backup-before-projects-20261021-120000", "library.json"), lib(1));
    for (const p of [
      "/data/library.json",
      "/data/",
      "/DATA/library.json",
      "/%64ata/library.json",
      "/x/../data/library.json",
      `/@fs${s.dataDir}/library.json`,
      "/data/projects.json",
      "/data/projects/default/library.json",
      "/data/trash/projects/old-1/library.json",
      "/Data/Projects.json?import",
      "/data-backup-before-projects-20261021-120000/library.json",
      "/DATA-BACKUP-before-projects-20261021-120000/library.json?raw",
      `/@fs${s.root}/data-backup-before-projects-20261021-120000/library.json`,
      // 存储服务未挂载时 /__paperlens 也不能成为绕过的入口
      "/__paperlens/../data/projects.json",
      "/__paperlens/storage/../../data/library.json",
    ]) {
      const res = await fetch(`${s.origin}${p}`);
      expect(res.status, p).toBe(403);
    }
    expect(await (await fetch(`${s.origin}/index.html`)).text()).toBe("fallthrough");
    // 名字相近但不是备份目录的不受影响
    expect(await (await fetch(`${s.origin}/data-backups.txt`)).text()).toBe("fallthrough");
  });
});

// ---------------------------------------------------------------------------
// 评审 M4 的回归测试（服务端）
// ---------------------------------------------------------------------------

describe("评审回归：服务端", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await startTestServer();
  });
  afterEach(() => s.close());

  const putFiles = (group: string, files: unknown[]) =>
    fetch(`${s.base}/files/${group}`, { method: "PUT", headers: H, body: JSON.stringify({ files }) }).then((r) => r.json() as Promise<Record<string, unknown>>);
  const sha1 = (t: string) => createHash("sha1").update(t).digest("hex");

  it("第 9 项：用户放进来的同名文件、生成后被改过的文件不覆盖也不删除，移到 .paperlens-replaced/", async () => {
    const dir = join(s.dataDir, "markdown");
    mkdirSync(join(dir, "terms"), { recursive: true });
    writeFileSync(join(dir, "terms", "LSTM.md"), "我在 Obsidian 里写的长笔记");
    const r1 = await putFiles("markdown", [{ name: "terms/LSTM.md", content: "# LSTM\n生成的内容" }]);
    expect(r1).toMatchObject({ written: 1, replaced: 1 });
    expect(readFileSync(join(dir, "terms", "LSTM.md"), "utf8")).toBe("# LSTM\n生成的内容");
    const aside = () => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(readFileSync(join(d, e.name), "utf8"));
      };
      if (existsSync(join(dir, ".paperlens-replaced"))) walk(join(dir, ".paperlens-replaced"));
      return out;
    };
    expect(aside()).toEqual(["我在 Obsidian 里写的长笔记"]);

    // 用户编辑了生成的文件，之后术语改名：旧文件不直接删除
    writeFileSync(join(dir, "terms", "LSTM.md"), "# LSTM\n生成的内容\n\n我追加的内容");
    const r2 = await putFiles("markdown", [{ name: "terms/Long Short-Term Memory.md", content: "# x" }]);
    expect(r2).toMatchObject({ written: 1, deleted: 1, replaced: 1 });
    expect(existsSync(join(dir, "terms", "LSTM.md"))).toBe(false);
    expect(aside().sort()).toEqual(["# LSTM\n生成的内容\n\n我追加的内容", "我在 Obsidian 里写的长笔记"].sort());

    // 没改过的生成文件照常删除
    const r3 = await putFiles("markdown", []);
    expect(r3).toMatchObject({ deleted: 1, replaced: 0 });
  });

  it("第 13 项：只给哈希的文件对上清单就不重写；清单没变不重写；对不上的列为 missing", async () => {
    const dir = join(s.dataDir, "canvas");
    await putFiles("canvas", [{ name: "a.canvas", content: "A" }]);
    const manifest = join(dir, ".paperlens-manifest.json");
    const m1 = statSync(manifest).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const r = await putFiles("canvas", [
      { name: "a.canvas", sha: sha1("A") },
      { name: "b.canvas", sha: sha1("B") },
    ]);
    expect(r).toMatchObject({ unchanged: 1, written: 0, missing: ["b.canvas"] });
    expect(existsSync(join(dir, "b.canvas"))).toBe(false);
    expect(statSync(manifest).mtimeMs).toBe(m1);
    expect((await fetch(`${s.base}/files/canvas`, { method: "PUT", headers: H, body: JSON.stringify({ files: [{ name: "x", sha: "nothex" }] }) })).status).toBe(400);
  });

  it("第 8 项：持锁的进程变慢（超过 lockStaleMs）时锁不会被接管，不会丢更新", async () => {
    const { DataStore } = await import("../../../../server/storageFs.ts");
    const a = new DataStore({ dir: s.dataDir, lockStaleMs: 100 });
    const b = new DataStore({ dir: s.dataDir, lockStaleMs: 100 });
    await a.putLibrary(Buffer.from(lib(1, { terms: [{ id: "base" }] })), 0);
    const slow = a as unknown as { maybeAutoBackup: (cur: unknown) => Promise<void> };
    const orig = slow.maybeAutoBackup.bind(a);
    slow.maybeAutoBackup = async (cur) => {
      await new Promise((r) => setTimeout(r, 400));
      return orig(cur);
    };
    const pa = a.putLibrary(Buffer.from(lib(2, { terms: [{ id: "base" }, { id: "A" }] })), 1).then(
      () => "A ok",
      (e: { code: string }) => `A ${e.code}`,
    );
    await new Promise((r) => setTimeout(r, 150));
    const pb = b.putLibrary(Buffer.from(lib(2, { terms: [{ id: "base" }, { id: "B" }] })), 1).then(
      () => "B ok",
      (e: { code: string }) => `B ${e.code}`,
    );
    expect(await Promise.all([pa, pb])).toEqual(["A ok", "B conflict"]);
    expect(JSON.parse(readFileSync(join(s.dataDir, "library.json"), "utf8")).tables.terms.map((t: { id: string }) => t.id)).toEqual(["base", "A"]);
    expect(existsSync(join(s.dataDir, ".lock"))).toBe(false);
  });

  it("持锁的进程崩溃（心跳停止）后锁会被接管", async () => {
    mkdirSync(join(s.dataDir, ".lock"), { recursive: true });
    writeFileSync(join(s.dataDir, ".lock", "owner"), "dead-process");
    const old = new Date(Date.now() - 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(s.dataDir, ".lock", "owner"), old, old);
    expect((await put(s, lib(1), 0)).status).toBe(200);
  });

  it("第 5 项：状态和 409 里带内容哈希（只有与文件内容相符时才采信）", async () => {
    // 与前端 serializeDataFile 相同的形状：{...,"tables":<tablesJson>}\n
    const tablesJson = '{\n"terms":[\n{"id":"t"}\n]\n}';
    const hash = sha(tablesJson);
    const body = `{"format":"paperlens","version":1,"exportedAt":"x","revision":1,"contentHash":"${hash}","tables":${tablesJson}}\n`;
    expect((await put(s, body, 0)).status).toBe(200);
    const st = (await (await fetch(`${s.base}/status`, { headers: H })).json()) as { library: { contentHash: string } };
    expect(st.library.contentHash).toBe(hash);
    const c = await put(s, lib(1), 0);
    expect(c.status).toBe(409);
    expect(await c.json()).toMatchObject({ error: "conflict", revision: 1, contentHash: hash });
    // 手工改过内容（哈希对不上）：当作不知道
    writeFileSync(join(s.dataDir, "library.json"), body.replace('{"id":"t"}', '{"id":"edited"}'));
    const st2 = (await (await fetch(`${s.base}/status`, { headers: H })).json()) as { library: { contentHash: string | null } };
    expect(st2.library.contentHash).toBeNull();
  });

  it("第 6 项：library.json 无法解析时不覆盖，显式确认后先另存再覆盖", async () => {
    mkdirSync(s.dataDir, { recursive: true });
    const broken = '{"format":"paperlens","version":1,"revision":7,"tables":{"terms":[{"id":"t"';
    writeFileSync(join(s.dataDir, "library.json"), broken);
    const r1 = await put(s, lib(1), 0);
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as { error: string }).error).toBe("unreadable");
    expect(readFileSync(join(s.dataDir, "library.json"), "utf8")).toBe(broken);
    expect((await fetch(`${s.base}/library/recover`, { method: "POST", headers: H })).status).toBe(404); // 没有备份
    const r2 = await fetch(`${s.base}/library`, {
      method: "PUT",
      body: lib(1, { terms: [{ id: "new" }] }),
      headers: { ...H, "X-PaperLens-Base-Revision": "0", "X-PaperLens-Overwrite-Unreadable": "1" },
    });
    expect(r2.status).toBe(200);
    const saved = readdirSync(join(s.dataDir, "backups")).find((n) => n.includes("-unreadable"))!;
    expect(gunzipSync(readFileSync(join(s.dataDir, "backups", saved))).toString()).toBe(broken);
    // 现在可读：恢复接口拒绝
    expect((await fetch(`${s.base}/library/recover`, { method: "POST", headers: H })).status).toBe(409);
  });

  it("第 11 项：已存在但损坏的 PDF 用校验通过的上传替换；完好的不重写", async () => {
    const pdf = Buffer.from("%PDF-1.7\nintact\n%%EOF");
    const hash = sha(pdf);
    mkdirSync(join(s.dataDir, "pdfs"), { recursive: true });
    writeFileSync(join(s.dataDir, "pdfs", `${hash}.pdf`), "truncated");
    expect(await (await fetch(`${s.base}/pdfs/${hash}`, { method: "PUT", headers: H, body: pdf })).json()).toEqual({ stored: true });
    expect(readFileSync(join(s.dataDir, "pdfs", `${hash}.pdf`)).equals(pdf)).toBe(true);
    expect(await (await fetch(`${s.base}/pdfs/${hash}`, { method: "PUT", headers: H, body: pdf })).json()).toEqual({ stored: false });
  });

  it("第 13 项：备份按总大小封顶（至少保留最新 3 个）；占用空间接口", async () => {
    let now = new Date(2026, 9, 21, 10, 0, 0);
    await s.close();
    s = await startTestServer({ store: { now: () => now, maxBackupBytes: 2500, backupIntervalMs: 0 } });
    const noise = (n: number) => Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, note: createHash("sha256").update(`${n}-${i}`).digest("hex") }));
    for (let r = 1; r <= 8; r++) {
      now = new Date(2026, 9, 21, 10, r, 0);
      expect((await put(s, lib(r, { terms: noise(r) }), r - 1)).status).toBe(200);
    }
    const names = readdirSync(join(s.dataDir, "backups")).sort();
    const total = names.reduce((n, f) => n + statSync(join(s.dataDir, "backups", f)).size, 0);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names.length).toBeLessThan(7);
    expect(names.at(-1)).toBe("library-20261021-100800-r7.json.gz");
    expect(total).toBeLessThanOrEqual(2500 + statSync(join(s.dataDir, "backups", names[0])).size * 3);
    const usage = (await (await fetch(`${s.base}/usage`, { headers: H })).json()) as { library: number; backups: number; total: number };
    expect(usage.library).toBe(statSync(join(s.dataDir, "library.json")).size);
    expect(usage.backups).toBe(total);
    expect(usage.total).toBeGreaterThanOrEqual(usage.library + usage.backups);
  });
});
