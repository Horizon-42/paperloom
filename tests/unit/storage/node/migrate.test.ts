// @vitest-environment node
// 迁移脚本 scripts/migrate-projects.mjs：预览不改动、执行后结构正确且有逐个文件核对过的完整备份、可重复运行、
// 非旧版结构/非 Paperloom 目录/符号链接/项目目录拒绝、核对在写 projects.json 之前且失败时自动移回、移动中途失败自动移回、
// 执行期间持有 data/.lock 并放迁移标记、备份之后目录有变化时取消、有服务在写或无法确认时拒绝。
// 全部在临时目录中进行；端口检查只用测试自己起的服务器，进程扫描只看本进程。
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkServices, migrate, MIGRATING_MARKER, parseArgs } from "../../../../scripts/migrate-projects.mjs";
import { ProjectRegistry } from "../../../../server/projects.ts";

let root: string;
let data: string;
let lines: string[];
const log = (l: string) => lines.push(l);
const out = () => lines.join("\n");
const NOW = new Date(2026, 9, 21, 15, 30, 0);
const BACKUP = "data-backup-before-projects-20261021-153000";

const pdf = (s: string) => Buffer.from(`%PDF-1.7\n${s}\n%%EOF`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** 旧版结构：library.json、pdfs/、trash/、markdown/（含 .paperlens-replaced）、canvas/、backups/、空目录、中文与 NFD 名字、符号链接 */
function makeLegacy(dir: string) {
  mkdirSync(join(dir, "pdfs"), { recursive: true });
  mkdirSync(join(dir, "trash"), { recursive: true });
  mkdirSync(join(dir, "markdown", "terms"), { recursive: true });
  mkdirSync(join(dir, "markdown", ".paperlens-replaced", "20261020-100000"), { recursive: true });
  mkdirSync(join(dir, "canvas"), { recursive: true });
  mkdirSync(join(dir, "backups"), { recursive: true });
  mkdirSync(join(dir, "empty dir 空目录", "nested empty"), { recursive: true });
  const a = pdf("a");
  const b = pdf("b");
  const t = pdf("trashed");
  writeFileSync(join(dir, "pdfs", `${sha(a)}.pdf`), a);
  writeFileSync(join(dir, "pdfs", `${sha(b)}.pdf`), b);
  writeFileSync(join(dir, "trash", `${sha(t)}.pdf`), t);
  const tables = {
    domains: [{ id: "d1" }],
    papers: [
      { id: "p1", fileHash: sha(a) },
      { id: "p2", fileHash: sha(b) },
    ],
    annotations: [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
    terms: [{ id: "t1" }],
    links: [],
    notes: [],
    boards: [{ id: "b1" }],
    boardNodes: [],
    kv: [],
  };
  writeFileSync(join(dir, "library.json"), JSON.stringify({ format: "paperlens", version: 1, revision: 42, tables }));
  writeFileSync(join(dir, "markdown", "terms", "LSTM.md"), "# LSTM");
  writeFileSync(join(dir, "markdown", ".paperlens-manifest.json"), "{}");
  writeFileSync(join(dir, "markdown", ".paperlens-replaced", "20261020-100000", "x.md"), "用户的文件");
  writeFileSync(join(dir, "markdown", "用户 自己的 笔记.md"), "用户放的");
  writeFileSync(join(dir, "NFD-é.txt".normalize("NFD")), "nfd");
  writeFileSync(join(dir, "canvas", "方法对比.canvas"), "{}");
  writeFileSync(join(dir, "backups", "library-20261020-100000-r41.json.gz"), Buffer.from([1, 2, 3]));
  writeFileSync(join(dir, ".DS_Store"), "x");
  // 相对链接迁移后照样有效（两端一起移动）
  symlinkSync("../pdfs", join(dir, "markdown", "pdf-link-rel"));
}

/** 目录树：类型、大小、内容哈希、链接目标 */
function tree(dir: string): string[] {
  const res: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d).sort()) {
      const abs = join(d, n);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) res.push(`L ${rel}${n} -> ${readlinkSync(abs)}`);
      else if (st.isDirectory()) {
        res.push(`D ${rel}${n}`);
        walk(abs, `${rel}${n}/`);
      } else res.push(`F ${rel}${n}:${st.size}:${createHash("sha1").update(readFileSync(abs)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return res;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paperlens-migrate-test-"));
  data = join(root, "data");
  mkdirSync(data);
  lines = [];
});
afterEach(() => {
  // 某些用例会把目录设成只读
  for (const d of [data, join(data, "projects", "default")]) if (existsSync(d)) chmodSync(d, 0o755);
  rmSync(root, { recursive: true, force: true });
});

const run = (extra: Partial<Parameters<typeof migrate>[0]> = {}) => migrate({ dataDir: data, ports: [], scan: false, now: NOW, log, ...extra });

describe("migrate-projects：基本流程", () => {
  it("预览（不加 --apply）不改动任何文件，并列出将要做的事", async () => {
    makeLegacy(data);
    const before = tree(root);
    expect(await run()).toBe(0);
    expect(tree(root)).toEqual(before);
    expect(out()).toContain("预览（dry run");
    expect(out()).toContain("revision 42");
    expect(out()).toContain("papers 2");
    expect(out()).toContain("PDF：2 个");
    expect(out()).toContain(BACKUP);
    expect(out()).toMatch(/最后写入 projects\.json/);
  });

  it("执行：完整备份（逐个文件核对）→ 移进 projects/default/ → 核对 → 最后写 projects.json；不留锁和标记；服务能直接读到", async () => {
    makeLegacy(data);
    const before = tree(data);
    expect(await run({ apply: true, name: "论文精读" })).toBe(0);
    expect(tree(join(root, BACKUP))).toEqual(before);
    expect(lstatSync(join(root, BACKUP)).isDirectory()).toBe(true);
    expect(statSync(join(root, BACKUP)).ino).not.toBe(statSync(data).ino);
    expect(readdirSync(data).sort()).toEqual(["projects", "projects.json"]);
    expect(tree(join(data, "projects", "default"))).toEqual(before);
    const reg = JSON.parse(readFileSync(join(data, "projects.json"), "utf8"));
    expect(reg).toEqual({ version: 1, projects: [{ id: "default", name: "论文精读", createdAt: NOW.getTime(), updatedAt: NOW.getTime() }] });
    expect(out()).toContain("迁移完成");
    expect(out()).toContain("data/projects/default/markdown"); // Obsidian 提醒
    expect(out()).toContain(`${BACKUP}-failed`); // 回滚说明用静态服务已拦住的名字

    const registry = new ProjectRegistry({ dir: data });
    expect(await registry.list()).toMatchObject({ needsMigration: false, projects: [{ id: "default", name: "论文精读" }] });
    const { store, release } = await registry.open("default");
    try {
      expect((await store.libraryInfo()).revision).toBe(42);
      expect(await store.listPdfs()).toHaveLength(2);
      expect(await store.listPdfs("trash")).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("可重复运行：已迁移时报告并以 0 退出，不再改动", async () => {
    makeLegacy(data);
    expect(await run({ apply: true })).toBe(0);
    const after = tree(root);
    lines = [];
    expect(await run({ apply: true })).toBe(0);
    expect(out()).toContain("已经是项目结构");
    expect(tree(root)).toEqual(after);
  });

  it("不是旧版结构时不动手：空目录、不存在、状态不一致", async () => {
    expect(await run({ apply: true })).toBe(0);
    expect(out()).toContain("无需迁移");
    expect(readdirSync(data)).toEqual([]);

    lines = [];
    expect(await run({ apply: true, dataDir: join(root, "nope") })).toBe(1);
    expect(out()).toContain("找不到");

    makeLegacy(data);
    mkdirSync(join(data, "projects", "default"), { recursive: true });
    const before = tree(root);
    lines = [];
    expect(await run({ apply: true })).toBe(1);
    expect(out()).toContain("状态不一致");
    expect(tree(root)).toEqual(before);
  });

  it("第 9 项：projects.json 损坏时报错并以非 0 退出", async () => {
    mkdirSync(join(data, "projects", "default"), { recursive: true });
    writeFileSync(join(data, "projects.json"), "{broken");
    expect(await run({ apply: true })).toBe(1);
    expect(out()).toContain("无法读取");
  });

  it("上次在写 projects.json 前中断（只有 projects/default/）：补写登记表", async () => {
    mkdirSync(join(data, "projects", "default"), { recursive: true });
    writeFileSync(join(data, "projects", "default", "library.json"), "{}");
    expect(await run()).toBe(0);
    expect(existsSync(join(data, "projects.json"))).toBe(false);
    expect(await run({ apply: true, name: "补上" })).toBe(0);
    expect(JSON.parse(readFileSync(join(data, "projects.json"), "utf8")).projects).toMatchObject([{ id: "default", name: "补上" }]);
  });
});

describe("migrate-projects：评审问题", () => {
  it("第 1 项：data 本身是符号链接时拒绝（否则备份只复制了链接）", async () => {
    const real = join(root, "real-data");
    mkdirSync(real);
    makeLegacy(real);
    rmSync(data, { recursive: true });
    symlinkSync(real, data);
    const before = tree(root);
    expect(await run({ apply: true })).toBe(1);
    expect(out()).toContain("符号链接");
    expect(tree(root)).toEqual(before);
    // 直接指定真实目录就可以
    lines = [];
    expect(await run({ apply: true, dataDir: real })).toBe(0);
    expect(lstatSync(join(root, BACKUP)).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(root, BACKUP))).toContain("library.json");
  });

  it("第 6 项：看起来不是 Paperloom 数据目录时要 --force；只有按哈希命名的 pdfs/ 也算；projects/ 下的目录拒绝", async () => {
    writeFileSync(join(data, "notes.txt"), "随便什么目录");
    mkdirSync(join(data, "photos"));
    const before = tree(root);
    expect(await run({ apply: true })).toBe(1);
    expect(out()).toContain("不是 Paperloom 的数据目录");
    expect(tree(root)).toEqual(before);
    writeFileSync(join(data, "library.json"), JSON.stringify({ format: "zotero", tables: {} }));
    lines = [];
    expect(await run({ apply: true })).toBe(1);
    lines = [];
    expect(await run({ apply: true, force: true })).toBe(0);

    const only = join(root, "only-pdfs");
    mkdirSync(join(only, "pdfs"), { recursive: true });
    writeFileSync(join(only, "pdfs", `${sha(pdf("x"))}.pdf`), pdf("x"));
    lines = [];
    expect(await run({ apply: true, dataDir: only, now: new Date(2026, 9, 21, 16, 0, 0) })).toBe(0);

    const nested = join(root, "x", "projects", "default");
    mkdirSync(nested, { recursive: true });
    makeLegacy(nested);
    lines = [];
    expect(await run({ apply: true, dataDir: nested })).toBe(1);
    expect(out()).toContain("位于 projects/ 下");
  });

  it("第 5 项：核对在写 projects.json 之前；核对失败时自动移回、不写登记表（备份完好）", async () => {
    makeLegacy(data);
    const before = tree(data);
    const code = await run({
      apply: true,
      hooks: {
        afterMove: async () => {
          const dir = join(data, "projects", "default", "pdfs");
          rmSync(join(dir, readdirSync(dir)[0]));
        },
      },
    });
    expect(code).toBe(1);
    expect(out()).toContain("核对失败");
    expect(out()).toContain("PDF 数量不一致");
    expect(out()).toContain("已自动把移动过的");
    expect(existsSync(join(data, "projects.json"))).toBe(false);
    expect(existsSync(join(data, "projects"))).toBe(false);
    expect(existsSync(join(data, MIGRATING_MARKER))).toBe(false);
    expect(existsSync(join(data, "library.json"))).toBe(true);
    expect(tree(join(root, BACKUP))).toEqual(before);
  });

  it("第 5 项：迁移期间 Finder 写进来的 .DS_Store 不算核对失败", async () => {
    makeLegacy(data);
    const code = await run({
      apply: true,
      hooks: {
        afterMove: async () => {
          writeFileSync(join(data, ".DS_Store"), "finder");
          writeFileSync(join(data, "projects", "default", "markdown", ".DS_Store"), "finder");
        },
      },
    });
    expect(code).toBe(0);
    expect(existsSync(join(data, "projects.json"))).toBe(true);
  });

  it("核对能发现 library.json 被改动", async () => {
    makeLegacy(data);
    const code = await run({
      apply: true,
      hooks: {
        afterMove: async () => {
          writeFileSync(join(data, "projects", "default", "library.json"), JSON.stringify({ format: "paperlens", version: 1, tables: { papers: [] } }));
        },
      },
    });
    expect(code).toBe(1);
    expect(out()).toContain("library.json 内容与迁移前不一致");
    expect(existsSync(join(data, "projects.json"))).toBe(false);
  });

  it("第 4 项：移动中途失败时按相反顺序自动移回，恢复成迁移前的样子", async () => {
    makeLegacy(data);
    const before = tree(data);
    const code = await run({
      apply: true,
      hooks: {
        beforeMoveEntry: async (n) => {
          if (n === "markdown") throw Object.assign(new Error("模拟：EXDEV 跨设备"), { code: "EXDEV" });
        },
      },
    });
    expect(code).toBe(1);
    expect(out()).toContain("已自动把移动过的");
    expect(tree(data)).toEqual(before);
    expect(existsSync(join(root, BACKUP))).toBe(true);
  });

  it("第 4 项：自动移回也失败时给出从备份恢复的方法", async () => {
    makeLegacy(data);
    let n = 0;
    const code = await run({
      apply: true,
      hooks: {
        beforeMoveEntry: async () => {
          // 第 3 项之前把目标目录设成只读：这一项移不进去，已移进去的也移不出来
          if (++n === 3) chmodSync(join(data, "projects", "default"), 0o555);
        },
      },
    });
    expect(code).toBe(1);
    expect(out()).toContain("自动移回也失败了");
    expect(out()).toContain(`mv "${data}" "${join(root, `${BACKUP}-failed`)}"`);
    expect(out()).toContain(`mv "${join(root, BACKUP)}" "${data}"`);
  });

  it("第 3 项：执行期间持有 data/.lock、放着迁移标记（新版服务视为旧版结构，不写入）；结束后释放", async () => {
    makeLegacy(data);
    let seen: { owner: string; age: number; layout: string } | null = null;
    const code = await run({
      apply: true,
      hooks: {
        afterMove: async () => {
          const st = statSync(join(data, ".lock", "owner"));
          seen = {
            owner: readFileSync(join(data, ".lock", "owner"), "utf8"),
            age: Date.now() - st.mtimeMs,
            layout: (await new ProjectRegistry({ dir: data }).layout()).kind,
          };
        },
      },
    });
    expect(code).toBe(0);
    expect(seen).not.toBeNull();
    expect(seen!.owner).toMatch(/^[0-9a-f]{24}$/);
    expect(seen!.age).toBeLessThan(15_000);
    expect(seen!.layout).toBe("legacy");
    expect(existsSync(join(data, ".lock"))).toBe(false);
    expect(existsSync(join(data, MIGRATING_MARKER))).toBe(false);
  });

  it("第 3 项：备份之后目录有变化（有程序在写）时取消，不动数据、删掉刚做的备份", async () => {
    makeLegacy(data);
    const code = await run({
      apply: true,
      hooks: {
        afterBackup: async () => {
          writeFileSync(join(data, "markdown", "terms", "LSTM.md"), "# 改过");
        },
      },
    });
    expect(code).toBe(1);
    expect(out()).toContain("备份之后目录有变化");
    expect(existsSync(join(root, BACKUP))).toBe(false);
    expect(existsSync(join(data, "projects"))).toBe(false);
    expect(existsSync(join(data, ".lock"))).toBe(false);
  });

  it("上次迁移在中途被杀掉（留着迁移标记）：拒绝并给出从备份恢复的方法", async () => {
    makeLegacy(data);
    mkdirSync(join(data, "projects", "default"), { recursive: true });
    writeFileSync(join(data, MIGRATING_MARKER), JSON.stringify({ startedAt: "2026-10-21T07:00:00Z", backupDir: join(root, BACKUP) }));
    expect(await run({ apply: true })).toBe(1);
    expect(out()).toContain("上次迁移没有完成");
    expect(out()).toContain(`mv "${join(root, BACKUP)}" "${data}"`);
  });

  it("有进程正持有 .lock 时拒绝；过期的锁接管并清掉", async () => {
    makeLegacy(data);
    mkdirSync(join(data, ".lock"));
    writeFileSync(join(data, ".lock", "owner"), "token");
    const before = tree(root);
    expect(await run({ apply: true })).toBe(1);
    expect(out()).toContain("正被持有");
    expect(tree(root)).toEqual(before);

    const old = new Date(Date.now() - 60_000);
    utimesSync(join(data, ".lock", "owner"), old, old);
    lines = [];
    expect(await run({ apply: true })).toBe(0);
    expect(out()).toContain("过期的锁");
    expect(readdirSync(data).sort()).toEqual(["projects", "projects.json"]);
  });

  it("第 8 项：预览时提示迁移后会失效的符号链接、没有读权限的文件", async () => {
    makeLegacy(data);
    symlinkSync(join(data, "library.json"), join(data, "abs-link-to-library.json"));
    symlinkSync("../outside.txt", join(data, "rel-link-outside"));
    expect(await run()).toBe(0);
    expect(out()).toContain("迁移后会失效");
    expect(out()).toContain("abs-link-to-library.json");
    expect(out()).toContain("rel-link-outside");
    expect(out()).not.toContain("pdf-link-rel");

    chmodSync(join(data, "canvas", "方法对比.canvas"), 0o000);
    lines = [];
    try {
      expect(await run()).toBe(1);
      expect(out()).toContain("没有读取权限");
      lines = [];
      // 执行时同样在动手之前失败
      expect(await run({ apply: true })).toBe(1);
      expect(existsSync(join(root, BACKUP))).toBe(false);
      expect(existsSync(join(data, "projects"))).toBe(false);
    } finally {
      chmodSync(join(data, "canvas", "方法对比.canvas"), 0o644);
    }
  });
});

describe("migrate-projects：端口与进程上的服务（第 2 项）", () => {
  let servers: (Server | TcpServer)[];
  const sockets: Socket[] = [];
  beforeEach(() => {
    servers = [];
  });
  afterEach(async () => {
    sockets.forEach((s) => s.destroy());
    for (const s of servers) {
      (s as Server).closeAllConnections?.();
      await new Promise((r) => s.close(r));
    }
  });
  const listen = async (s: Server | TcpServer) => {
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "localhost", r));
    return (s.address() as { port: number }).port;
  };
  const jsonServer = (reply: (url: string) => { status: number; body: unknown } | null) =>
    listen(
      createHttpServer((req, res) => {
        const r = reply(req.url ?? "");
        if (!r || req.headers["x-paperlens"] !== "1") {
          res.statusCode = 404;
          res.end("nope");
          return;
        }
        res.statusCode = r.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(r.body));
      }),
    );
  /** 接受连接但从不回应（例如被 SIGSTOP 挂起的旧版服务） */
  const silentServer = () =>
    listen(
      createTcpServer((sock) => {
        sockets.push(sock);
      }),
    );
  const closeLast = () => new Promise((r) => servers.pop()!.close(r));

  it("旧版服务正在使用这个目录：拒绝，不做任何改动", async () => {
    makeLegacy(data);
    const port = await jsonServer((url) => (url === "/__paperlens/storage/status" ? { status: 200, body: { service: "paperlens-storage", dataDir: data } } : null));
    const before = tree(root);
    expect(await run({ apply: true, ports: [port] })).toBe(1);
    expect(out()).toContain(`旧版 Paperloom 服务（localhost:${port}）正在使用这个目录`);
    expect(tree(root)).toEqual(before);
  });

  it("端口连得上但不回应（被挂起）或回应不像 Paperloom：拒绝，--force 可以继续", async () => {
    makeLegacy(data);
    const silent = await silentServer();
    const before = tree(root);
    expect(await run({ apply: true, ports: [silent], timeoutMs: 500 })).toBe(1);
    expect(out()).toContain("超时");
    expect(tree(root)).toEqual(before);

    const html = await listen(createHttpServer((_req, res) => res.end("<html>other app</html>")));
    expect((await checkServices(data, { ports: [html], scan: false })).unsure).toHaveLength(1);
    expect((await checkServices(data, { ports: [html], scan: false, force: true })).unsure).toHaveLength(0);

    lines = [];
    expect(await run({ apply: true, ports: [silent], timeoutMs: 500, force: true })).toBe(0);
    expect(out()).toContain("--force");
  });

  it("旧版服务用的是别的目录、或新版服务（迁移前不写）正在运行：照常迁移；没人监听的端口不拦", async () => {
    makeLegacy(data);
    const other = await jsonServer((url) => (url === "/__paperlens/storage/status" ? { status: 200, body: { service: "paperlens-storage", dataDir: join(root, "other") } } : null));
    expect(await checkServices(data, { ports: [other], scan: false })).toMatchObject({ blocking: [], unsure: [] });
    const fresh = await jsonServer((url) =>
      url === "/__paperlens/storage/status"
        ? { status: 410, body: { error: "gone" } }
        : url === "/__paperlens/projects"
          ? { status: 200, body: { service: "paperlens-storage", dataDir: data, needsMigration: true, projects: [] } }
          : null,
    );
    const svc = await checkServices(data, { ports: [fresh], scan: false });
    expect(svc).toMatchObject({ blocking: [], unsure: [] });
    expect(svc.notes.join("\n")).toContain("新版 Paperloom 服务");
    const closed = await silentServer();
    await closeLast();
    expect(await checkServices(data, { ports: [closed], scan: false })).toMatchObject({ blocking: [], unsure: [] });
    expect(await run({ apply: true, ports: [fresh] })).toBe(0);
  });

  it("其他端口上的进程：用 lsof 找到本进程监听的端口——旧版服务在用这个目录则拒绝；工作目录是本仓库、又不回应的也拒绝", async () => {
    makeLegacy(data);
    const scan = { pids: [process.pid] };
    const old = await jsonServer((url) => (url === "/__paperlens/storage/status" ? { status: 200, body: { service: "paperlens-storage", dataDir: data } } : null));
    const svc = await checkServices(data, { ports: [], scan });
    expect(svc.blocking.join("\n")).toContain(`localhost:${old}（进程 ${process.pid}`);
    await closeLast();

    const silent = await silentServer();
    // 工作目录不是本仓库：不回应也不拦
    expect((await checkServices(data, { ports: [], scan, timeoutMs: 500 })).unsure).toEqual([]);
    const r = await checkServices(data, { ports: [], scan, repoRoots: [process.cwd()], timeoutMs: 500 });
    expect(r.unsure.join("\n")).toContain(`localhost:${silent}`);
    expect(await run({ apply: true, scan, repoRoots: [process.cwd()], timeoutMs: 500 })).toBe(1);
  });

  it("命令行参数", () => {
    expect(parseArgs([], "/repo")).toMatchObject({ dataDir: "/repo/data", name: "我的项目", apply: false, force: false, ports: [5173, 4173], scan: true, repoRoots: ["/repo"] });
    expect(parseArgs(["--data", "/x", "--name", "N", "--apply", "--ports", "none", "--no-process-scan", "--force"], "/repo")).toMatchObject({
      dataDir: "/x",
      name: "N",
      apply: true,
      ports: [],
      scan: false,
      force: true,
    });
    expect(parseArgs(["--ports", "5401,5402"], "/repo").ports).toEqual([5401, 5402]);
    expect(() => parseArgs(["--bogus"], "/repo")).toThrow();
    expect(() => parseArgs(["--ports", "abc"], "/repo")).toThrow();
  });
});
