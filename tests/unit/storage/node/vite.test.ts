// @vitest-environment node
// 在真实的 Vite 开发服务器上（带模块转换中间件、/@fs/、/@id/、?import 等处理）检查数据目录读不到：
// 单元测试里的简易服务器没有这些中间件，抓不到这类绕过（评审 M4 第 1 项）。
// 数据目录是项目结构（projects.json、projects/<id>/、trash/projects/），旁边还有迁移脚本留下的完整备份；
// 另起一个服务器测旧版结构（需要迁移）时什么都不写。
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { paperlensStorage, VITE_DEFAULT_FS_DENY } from "../../../../server/storagePlugin.ts";

const SECRET = "SECRET-LIBRARY-CONTENT-7f3a";
const PDF_SECRET = "SECRET-PDF-CONTENT-91bc";
const REG_SECRET = "SECRET-PROJECT-NAME-4d2e";
const TRASH_SECRET = "SECRET-TRASHED-PROJECT-88a1";
const BACKUP_SECRET = "SECRET-MIGRATION-BACKUP-c0de";
const pdfBytes = Buffer.from(`%PDF-1.7\n${PDF_SECRET}\n%%EOF`);
const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
const BACKUP = "data-backup-before-projects-20261021-120000";
const libText = (name: string, revision = 1) => JSON.stringify({ format: "paperlens", version: 1, revision, tables: { terms: [{ id: "t", name }] } });

let root: string;
let server: ViteDevServer;
let port: number;

type Res = { status: number; body: string; headers: Record<string, unknown> };
function send(p: number, rawPath: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: p, path: rawPath, method, headers: { Host: `localhost:${p}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
const get = (rawPath: string, headers: Record<string, string> = {}, method = "GET") => send(port, rawPath, headers, method);

async function startVite(dir: string): Promise<ViteDevServer> {
  const s = await createServer({
    root: dir,
    configFile: false,
    logLevel: "silent",
    appType: "spa",
    plugins: [paperlensStorage({ enabled: true })],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
  });
  await s.listen();
  return s;
}

function writeSite(dir: string) {
  writeFileSync(join(dir, "index.html"), '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
  writeFileSync(join(dir, "main.js"), "export const ok = 1;\n");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "paperlens-vite-guard-"));
  writeSite(root);
  const proj = join(root, "data", "projects", "default");
  mkdirSync(join(proj, "pdfs"), { recursive: true });
  writeFileSync(join(root, "data", "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "default", name: REG_SECRET, createdAt: 1, updatedAt: 1 }] }));
  writeFileSync(join(proj, "library.json"), libText(SECRET));
  writeFileSync(join(proj, "pdfs", `${pdfHash}.pdf`), pdfBytes);
  mkdirSync(join(root, "data", "trash", "projects", "old-1"), { recursive: true });
  writeFileSync(join(root, "data", "trash", "projects", "old-1", "library.json"), libText(TRASH_SECRET));
  // 迁移脚本放在数据目录旁边的完整备份
  mkdirSync(join(root, BACKUP), { recursive: true });
  writeFileSync(join(root, BACKUP, "library.json"), libText(BACKUP_SECRET));
  // 迁移脚本回滚说明里让用户把失败的数据目录改名成这个（评审第 7 项）
  mkdirSync(join(root, `${BACKUP}-failed`, "projects", "default"), { recursive: true });
  writeFileSync(join(root, `${BACKUP}-failed`, "projects", "default", "library.json"), libText(BACKUP_SECRET));
  // 项目里指向数据目录的符号链接也不能绕过
  symlinkSync(join(root, "data"), join(root, "link"));
  server = await startVite(root);
  port = (server.httpServer!.address() as { port: number }).port;
}, 30_000);

afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const SECRETS = [SECRET, PDF_SECRET, REG_SECRET, TRASH_SECRET, BACKUP_SECRET];
const leaked = (r: Res) => SECRETS.some((x) => r.body.includes(x)) || r.body.includes(pdfBytes.toString("base64").slice(0, 24));

describe("真实 Vite：数据目录不能经静态文件服务读到", () => {
  it("插件把数据目录和迁移备份加入 server.fs.deny（保留 Vite 的默认值）并关闭 CORS", () => {
    expect(server.config.server.fs.deny).toEqual(
      expect.arrayContaining([...VITE_DEFAULT_FS_DENY, `${root}/data/**`, `${root}/data-backup-before-projects-*/**`]),
    );
    expect(server.config.server.cors).toBe(false);
    expect(server.config.preview.cors).toBe(false);
  });

  it("正常页面和模块不受影响", async () => {
    expect((await get("/")).status).toBe(200);
    const js = await get("/main.js");
    expect(js.status).toBe(200);
    expect(js.body).toContain("ok");
  });

  const lib = "data/projects/default/library.json";
  const pdf = `data/projects/default/pdfs/${pdfHash}.pdf`;
  const variants = (abs: string) => [
    "/data/projects.json",
    "//data/projects.json?raw&import",
    "/data/projects.json?import",
    "/Data/Projects.json?raw",
    "/%64ata/projects.json?import",
    `/@fs${abs}/data/projects.json?raw`,
    "/link/projects.json?raw",
    "/data/trash/projects/old-1/library.json",
    "//data/trash/projects/old-1/library.json?raw&import",
    `/@fs${abs}/data/trash/projects/old-1/library.json?import`,
    `/${BACKUP}/library.json`,
    `//${BACKUP}/library.json?raw&import`,
    `/${BACKUP}/library.json?import`,
    `/${BACKUP.toUpperCase()}/library.json?raw`,
    `/%64ata-backup-before-projects-20261021-120000/library.json?import`,
    `/@fs${abs}/${BACKUP}/library.json?raw`,
    `/@id${abs}/${BACKUP}/library.json?import`,
    `/x/../${BACKUP}/library.json?import`,
    `/${BACKUP}-failed/projects/default/library.json`,
    `//${BACKUP}-failed/projects/default/library.json?raw&import`,
    `/@fs${abs}/${BACKUP}-failed/projects/default/library.json?raw`,
    // 存储接口前缀后面接 ".."：由存储接口处理（404），不能落到静态文件服务
    "/__paperlens/../data/projects.json?raw",
    "/__paperlens/storage/../../data/projects/default/library.json?raw",
    "/__paperlens/p/default/storage/../../../../data/projects.json?import",
    `/__paperlens/p/default/storage/pdfs/../../../../../${pdf}`,
    `/${lib}`,
    `//${lib}`,
    `///${lib}`,
    `//${lib}?raw&import`,
    `//${lib}?import`,
    `/${lib}?import`,
    `/${lib}?raw`,
    `/${lib}?url`,
    `/${lib}?inline`,
    `/${lib}?url&import`,
    `/DATA/library.json?import`,
    `/Data/Library.json`,
    `/%64ata/library.json?import`,
    `/%2564ata/library.json?import`,
    `/data%2flibrary.json?import`,
    `/data%5clibrary.json?import`,
    `/x/../${lib}?import`,
    `/x/%2e%2e/${lib}?import`,
    `/./${lib}`,
    `/@fs${abs}/${lib}`,
    `/@fs${abs}/${lib}?import`,
    `/@fs${abs}/${lib}?raw&import`,
    `//@fs${abs}/${lib}?import`,
    `/@fs/${abs}/${lib}?import`,
    `/@id${abs}/${lib}?import`,
    `/@id/__x00__${abs}/${lib}?import`,
    `/@id/__x00__/${lib}`,
    `/@id/@fs${abs}/${lib}?import`,
    `/${pdf}`,
    `//${pdf}?inline&import`,
    `//${pdf}?url&import`,
    `/${pdf}?raw`,
    `/@fs${abs}/${pdf}?inline&import`,
    `/@id${abs}/${pdf}?import`,
    `/link/library.json?import`,
    `/link/pdfs/${pdfHash}.pdf?inline&import`,
    `/@fs${abs}/link/library.json?raw`,
  ];

  it("各种路径变体都读不到 library.json 和 PDF", async () => {
    const leaks: string[] = [];
    const statuses = new Set<number>();
    for (const p of variants(root)) {
      // 带上自定义头：即使通过了存储接口的安全检查也读不到
      for (const h of [{}, { "X-PaperLens": "1" }] as Record<string, string>[]) {
        const r = await get(p, h);
        statuses.add(r.status);
        if (leaked(r) || r.status === 200) leaks.push(`${r.status} ${p}`);
      }
    }
    expect(leaks).toEqual([]);
    // 410：落在旧版接口前缀下（由存储接口拒绝）
    expect([...statuses].filter((x) => x !== 403 && x !== 404 && x !== 410)).toEqual([]);
  });

  it("其他 localhost 源发来的请求拿不到 CORS 许可", async () => {
    const r = await get("/main.js", { Origin: "http://localhost:3000" });
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await get("/main.js", { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" }, "OPTIONS");
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    const leak = await get(`//${lib}?import`, { Origin: "http://localhost:3000" });
    expect(leak.headers["access-control-allow-origin"]).toBeUndefined();
    expect(leak.body).not.toContain(SECRET);
  });

  it("存储接口本身照常工作；旧版接口一律 410；安全检查覆盖所有新路由", async () => {
    const H = { "X-PaperLens": "1" };
    const r = await get("/__paperlens/p/default/storage/status", H);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).library.revision).toBe(1);
    const list = await get("/__paperlens/projects", H);
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).projects.map((p: { id: string }) => p.id)).toEqual(["default"]);
    expect((await get("/__paperlens/p/nope/storage/status", H)).status).toBe(404);
    for (const old of ["/__paperlens/storage/status", "/__paperlens/storage/library", `/__paperlens/storage/pdfs/${pdfHash}`]) {
      const res = await get(old, H);
      expect(res.status, old).toBe(410);
      expect(leaked(res)).toBe(false);
    }
    const evil = { ...H, Origin: "http://localhost:3000" };
    for (const p of ["/__paperlens/p/default/storage/status", "/__paperlens/p/default/storage/library", "/__paperlens/projects", "/__paperlens/storage/status"]) {
      expect((await get(p, evil)).status, p).toBe(403);
      expect((await get(p, { ...H, "Sec-Fetch-Site": "cross-site" })).status, p).toBe(403);
      expect((await get(p)).status, p).toBe(403); // 缺少 X-PaperLens
      expect((await get(p, { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" }, "OPTIONS")).status, p).toBe(403);
    }
    // 外来 Origin 不能新建、删除项目
    expect((await send(port, "/__paperlens/projects", { ...evil, "Content-Type": "application/json" }, "POST", '{"name":"x"}')).status).toBe(403);
    expect((await get("/__paperlens/projects/default", evil, "DELETE")).status).toBe(403);
    expect(JSON.parse(readFileSync(join(root, "data", "projects.json"), "utf8")).projects).toHaveLength(1);
  });
});

describe("真实 Vite：旧版目录结构（需要迁移）时什么都不写", () => {
  let legacyRoot: string;
  let legacy: ViteDevServer;
  let lport: number;
  const H = { "X-PaperLens": "1" };
  const snapshot = (dir: string) => {
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const n of readdirSync(d).sort()) {
        const st = statSync(join(d, n));
        if (st.isDirectory()) walk(join(d, n), `${rel}${n}/`);
        else out.push(`${rel}${n}:${st.size}:${st.mtimeMs}`);
      }
    };
    walk(dir, "");
    return out;
  };

  beforeAll(async () => {
    legacyRoot = mkdtempSync(join(tmpdir(), "paperlens-vite-legacy-"));
    writeSite(legacyRoot);
    mkdirSync(join(legacyRoot, "data", "pdfs"), { recursive: true });
    writeFileSync(join(legacyRoot, "data", "library.json"), libText(SECRET, 3));
    writeFileSync(join(legacyRoot, "data", "pdfs", `${pdfHash}.pdf`), pdfBytes);
    legacy = await startVite(legacyRoot);
    lport = (legacy.httpServer!.address() as { port: number }).port;
  }, 30_000);
  afterAll(async () => {
    await legacy?.close();
    rmSync(legacyRoot, { recursive: true, force: true });
  });

  it("列表和状态报告 needsMigration；所有写入拒绝（409 needs-migration）；目录内容一点不变", async () => {
    const before = snapshot(join(legacyRoot, "data"));
    const list = JSON.parse((await send(lport, "/__paperlens/projects", H)).body);
    expect(list).toMatchObject({ needsMigration: true, projects: [] });
    const st = JSON.parse((await send(lport, "/__paperlens/p/default/storage/status", H)).body);
    expect(st.needsMigration).toBe(true);
    expect(st.library.exists).toBe(false);
    const body = libText("new", 4);
    const writes: [string, string, string?][] = [
      ["PUT", "/__paperlens/p/default/storage/library", body],
      ["PUT", `/__paperlens/p/default/storage/pdfs/${pdfHash}`, pdfBytes.toString()],
      ["PUT", "/__paperlens/p/default/storage/files/markdown", '{"files":[{"name":"a.md","content":"x"}]}'],
      ["POST", "/__paperlens/p/default/storage/backups?reason=manual", ""],
      ["POST", "/__paperlens/p/default/storage/library/recover", ""],
      ["POST", "/__paperlens/projects", '{"name":"新项目"}'],
      ["PATCH", "/__paperlens/projects/default", '{"name":"改名"}'],
      ["DELETE", "/__paperlens/projects/default", ""],
    ];
    for (const [method, p, b] of writes) {
      const res = await send(lport, p, { ...H, "X-PaperLens-Base-Revision": "3", "Content-Type": "application/json" }, method, b);
      expect(res.status, `${method} ${p}`).toBe(409);
      expect(JSON.parse(res.body).error, `${method} ${p}`).toBe("needs-migration");
    }
    // 读取同样拒绝（数据还在根目录，不按项目提供）
    expect((await send(lport, "/__paperlens/p/default/storage/library", H)).status).toBe(409);
    // 旧版接口同样 410：旧页面写不进来
    expect((await send(lport, "/__paperlens/storage/library", { ...H, "X-PaperLens-Base-Revision": "3" }, "PUT", body)).status).toBe(410);
    expect(snapshot(join(legacyRoot, "data"))).toEqual(before);
    for (const p of ["/data/library.json", "//data/library.json?raw&import", `/data/pdfs/${pdfHash}.pdf?inline&import`]) {
      const r = await send(lport, p);
      expect([403, 404], p).toContain(r.status);
      expect(r.body).not.toContain(SECRET);
    }
  });
});
