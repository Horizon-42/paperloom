#!/usr/bin/env node
// 把旧版的 data/（根目录下直接是 library.json、pdfs/、markdown/…）迁移到项目结构：
//   data/projects.json              项目登记表
//   data/projects/default/...       原来根目录下的全部内容（原样移动，不改任何文件）
// 用法：npm run migrate:projects -- [--data <目录>] [--name <项目名>] [--apply] [--ports 5173,4173|none] [--no-process-scan] [--force]
//   不加 --apply 只预览（dry run），不改动任何文件。
// 执行顺序：拿 data/.lock（与存储服务同一格式，持有期间旧版服务写不了 library.json）→ ① 完整备份到
// <data 的上级目录>/data-backup-before-projects-<时间>/ 并逐个文件核对内容 → 再查一次服务、确认备份后没有变化 →
// 放 .paperlens-migrating 标记（新版服务见到它一律不写）→ ② ③ 用 rename 移进 projects/default/ → ④ 核对 →
// ⑤ 最后写 projects.json（提交点）。⑤ 之前任何一步失败都自动把移动过的条目移回原处。
// 纯 Node，无依赖（服务端的 server/projects.ts 是同一格式的另一份实现）。
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MIGRATION_BACKUP_PREFIX = "data-backup-before-projects-";
export const DEFAULT_PROJECT_ID = "default";
export const DEFAULT_PROJECT_NAME = "我的项目";
/** 迁移进行中的标记：服务端把有它的目录当作旧版结构（不写入），中断时据此提示从备份恢复 */
export const MIGRATING_MARKER = ".paperlens-migrating";
const REGISTRY_FILE = "projects.json";
const PROJECTS_DIR = "projects";
const LOCK_DIR = ".lock";
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PDF_NAME_RE = /^[0-9a-f]{64}\.pdf$/;
const LOCK_STALE_MS = 15_000;
export const DEFAULT_PORTS = [5173, 4173];

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const errText = (e) => (e instanceof Error ? e.message : String(e));
const errCode = (e) => e?.code;

/** 与 server/projects.ts 的 isIgnorableRootEntry 相同：锁、临时文件、.DS_Store 不算数据 */
function isIgnorable(name) {
  return name === ".DS_Store" || name === LOCK_DIR || name.startsWith(".lock.stale-") || /^\..+\.tmp$/.test(name);
}

/** 存在与否；只有 ENOENT 算不存在，其他错误（权限等）照常抛出 */
async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch (e) {
    if (errCode(e) === "ENOENT") return false;
    throw e;
  }
}

async function sha256File(p) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk);
  return h.digest("hex");
}

/**
 * 目录清单：相对路径 → { type: dir|file|link|other, size, mtimeMs, sha?, link? }。符号链接不跟随（记录链接本身）。
 * skipTop：顶层要跳过的条目（锁、迁移标记）；hash：是否计算每个文件内容的 SHA-256
 */
async function manifest(dir, { hash = false, skipTop = [] } = {}) {
  const out = new Map();
  const walk = async (d, rel) => {
    for (const name of (await fsp.readdir(d)).sort()) {
      if (!rel && skipTop.includes(name)) continue;
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) out.set(r, { type: "link", size: st.size, mtimeMs: st.mtimeMs, link: await fsp.readlink(abs) });
      else if (st.isDirectory()) {
        out.set(r, { type: "dir", size: 0, mtimeMs: 0 });
        await walk(abs, r);
      } else if (st.isFile()) out.set(r, { type: "file", size: st.size, mtimeMs: st.mtimeMs, ...(hash ? { sha: await sha256File(abs) } : {}) });
      else out.set(r, { type: "other", size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  await walk(dir, "");
  return out;
}

/** 两份清单的差异（最多列出几条）；fields 为要比较的字段 */
function diffManifests(a, b, fields) {
  const out = [];
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w) out.push(`少了 ${k}`);
    else {
      const f = fields.find((x) => (x === "mtimeMs" ? v.type === "file" && v.mtimeMs !== w.mtimeMs : v[x] !== w[x]));
      if (f) out.push(`${k} 的 ${f === "sha" ? "内容" : f === "mtimeMs" ? "修改时间" : f === "link" ? "链接目标" : f} 不同`);
    }
    if (out.length >= 5) return out;
  }
  for (const k of b.keys()) {
    if (!a.has(k)) out.push(`多了 ${k}`);
    if (out.length >= 5) return out;
  }
  return out;
}

function totals(m) {
  let count = 0;
  let bytes = 0;
  for (const v of m.values()) {
    if (v.type === "dir") continue;
    count++;
    bytes += v.size;
  }
  return { count, bytes };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** library.json 的摘要：revision、各表记录数、内容哈希 */
async function inspectLibrary(file) {
  if (!(await exists(file))) return { exists: false };
  const sha = await sha256File(file);
  try {
    const doc = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!doc || doc.format !== "paperlens" || typeof doc.tables !== "object" || !doc.tables) throw new Error("不是 Paperloom 数据文件");
    const counts = {};
    for (const [k, v] of Object.entries(doc.tables)) if (Array.isArray(v)) counts[k] = v.length;
    return { exists: true, sha, revision: Number.isInteger(doc.revision) ? doc.revision : 0, counts };
  } catch (e) {
    return { exists: true, sha, error: errText(e) };
  }
}

async function countPdfs(dir) {
  try {
    return (await fsp.readdir(dir)).filter((n) => PDF_NAME_RE.test(n)).length;
  } catch (e) {
    if (errCode(e) === "ENOENT") return 0;
    throw e;
  }
}

function countsText(c) {
  return Object.entries(c ?? {})
    .map(([k, v]) => `${k} ${v}`)
    .join("，");
}

/** 与 server/projects.ts 的 parseRegistry 相同的校验 */
function parseRegistry(text) {
  const doc = JSON.parse(text);
  const ok = (p) => p && PROJECT_ID_RE.test(String(p.id)) && typeof p.name === "string" && Number.isFinite(p.createdAt) && Number.isFinite(p.updatedAt);
  if (!doc || doc.version !== 1 || !Array.isArray(doc.projects) || !doc.projects.every(ok)) throw new Error("不是有效的 projects.json");
  if (new Set(doc.projects.map((p) => p.id)).size !== doc.projects.length) throw new Error("有重复的项目 id");
  return doc;
}

/**
 * data/ 的状态：missing 不存在；symlink 本身是符号链接；not-dir 不是目录；nested 位于 projects/ 下（是某个项目的目录）；
 * empty 没有数据；migrated 已有 projects.json；registry-broken projects.json 无法读取；in-progress 有迁移标记（上次迁移没完成）；
 * interrupted 只有 projects/（上次迁移在写 projects.json 前中断，旧版本脚本）；inconsistent 既有 projects/ 又有旧版文件；legacy 旧版结构
 */
export async function inspectDataDir(dataDir) {
  let st;
  try {
    st = await fsp.lstat(dataDir);
  } catch (e) {
    if (errCode(e) === "ENOENT") return { state: "missing", entries: [] };
    throw e;
  }
  if (st.isSymbolicLink()) return { state: "symlink", entries: [], target: await fsp.realpath(dataDir).catch(() => fsp.readlink(dataDir)) };
  if (!st.isDirectory()) return { state: "not-dir", entries: [] };
  if (path.basename(path.dirname(dataDir)) === PROJECTS_DIR) return { state: "nested", entries: [] };
  const all = (await fsp.readdir(dataDir)).sort();
  const entries = all.filter((n) => !isIgnorable(n));
  if (all.includes(REGISTRY_FILE)) {
    try {
      parseRegistry(await fsp.readFile(path.join(dataDir, REGISTRY_FILE), "utf8"));
    } catch (e) {
      return { state: "registry-broken", entries: all, error: errText(e) };
    }
    const strays = entries.filter((n) => n !== REGISTRY_FILE && n !== PROJECTS_DIR && n !== "trash" && n !== MIGRATING_MARKER);
    return { state: "migrated", entries: all, strays };
  }
  if (all.includes(MIGRATING_MARKER)) {
    let marker = null;
    try {
      marker = JSON.parse(await fsp.readFile(path.join(dataDir, MIGRATING_MARKER), "utf8"));
    } catch {
      // 标记内容无法读取
    }
    return { state: "in-progress", entries: all, marker };
  }
  if (!entries.length) return { state: "empty", entries: all };
  if (entries.every((n) => n === PROJECTS_DIR)) return { state: "interrupted", entries: all };
  if (entries.includes(PROJECTS_DIR)) return { state: "inconsistent", entries: all };
  return { state: "legacy", entries: all };
}

/** 像不像 Paperloom 的数据目录：library.json 是 Paperloom 数据文件，或 pdfs/ 里是按哈希命名的 PDF */
async function looksLikePaperLens(dataDir) {
  try {
    const doc = JSON.parse(await fsp.readFile(path.join(dataDir, "library.json"), "utf8"));
    if (doc && doc.format === "paperlens") return true;
  } catch {
    // 没有或不是 JSON
  }
  try {
    const names = (await fsp.readdir(path.join(dataDir, "pdfs"))).filter((n) => !n.startsWith("."));
    return names.length > 0 && names.every((n) => PDF_NAME_RE.test(n));
  } catch {
    return false;
  }
}

/** 迁移后会失效的符号链接：指向 data/ 内的绝对链接，以及指向 data/ 外的相对链接（目录多了两层） */
function brokenLinks(dataDir, inventory) {
  const target = path.join(dataDir, PROJECTS_DIR, DEFAULT_PROJECT_ID);
  const inside = (p) => p === dataDir || p.startsWith(dataDir + path.sep);
  const out = [];
  for (const [rel, v] of inventory) {
    if (v.type !== "link") continue;
    const from = path.join(dataDir, rel);
    if (path.isAbsolute(v.link)) {
      if (inside(path.resolve(v.link))) out.push(`${rel} -> ${v.link}`);
      continue;
    }
    const before = path.resolve(path.dirname(from), v.link);
    const after = path.resolve(path.dirname(path.join(target, rel)), v.link);
    const expected = inside(before) ? path.join(target, path.relative(dataDir, before)) : before;
    if (after !== expected) out.push(`${rel} -> ${v.link}`);
  }
  return out;
}

// ---------- 正在写这个目录的服务 ----------

/** 端口上有没有程序在监听：closed 连不上；open 连上了 */
function tcpProbe(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "localhost", port });
    const done = (r) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => done("timeout"));
    sock.once("connect", () => done("open"));
    sock.once("error", () => done("closed"));
  });
}

async function httpJson(port, p, timeoutMs, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://localhost:${port}${p}`, { headers: { "X-PaperLens": "1" }, signal: ctrl.signal });
    const body = (res.headers.get("content-type") ?? "").includes("application/json") ? await res.json().catch(() => null) : (await res.text().catch(() => ""), null);
    return { status: res.status, body };
  } catch (e) {
    return { error: ctrl.signal.aborted ? "没有响应（超时）" : errText(e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 看一个端口上的程序是不是在用这个目录：old 旧版服务用的就是它；new 新版服务（迁移前不写）；other 是 Paperloom 但用别的目录；
 * unknown 有程序在监听但回应不像 Paperloom（可能被挂起、或是别的程序）；closed 没有程序
 */
async function classifyPort(port, target, real, fetchImpl, timeoutMs) {
  const tcp = await tcpProbe(port);
  if (tcp === "closed") return { kind: "closed" };
  const old = await httpJson(port, "/__paperlens/storage/status", timeoutMs, fetchImpl);
  if (old.status === 200 && old.body?.service === "paperlens-storage" && typeof old.body.dataDir === "string") {
    return (await real(old.body.dataDir)) === target ? { kind: "old" } : { kind: "other", dataDir: old.body.dataDir };
  }
  if (old.status === 410) {
    const cur = await httpJson(port, "/__paperlens/projects", timeoutMs, fetchImpl);
    if (cur.body?.service === "paperlens-storage" && typeof cur.body.dataDir === "string") {
      return (await real(cur.body.dataDir)) === target ? { kind: "new" } : { kind: "other", dataDir: cur.body.dataDir };
    }
  }
  return { kind: "unknown", detail: old.error ?? `返回 ${old.status}，不是 Paperloom 存储服务的回应` };
}

/** 本机正在监听 TCP 端口的 node 进程（pid → 端口）及其工作目录；lsof 不可用时返回 null */
async function nodeListeners(pids) {
  const args = ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-F", "pn"];
  if (pids?.length) args.push("-p", pids.join(","));
  else args.push("-c", "node");
  let out;
  try {
    out = (await execFileAsync("lsof", args, { timeout: 5000 })).stdout;
  } catch (e) {
    // 没有匹配的进程时 lsof 以 1 退出、输出为空
    if (e && typeof e.stdout === "string" && e.code === 1) out = e.stdout;
    else return null;
  }
  const ports = new Map();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const m = /:(\d+)$/.exec(line);
      if (m) {
        const set = ports.get(pid) ?? new Set();
        set.add(Number(m[1]));
        ports.set(pid, set);
      }
    }
  }
  const cwds = new Map();
  if (ports.size) {
    try {
      const r = await execFileAsync("lsof", ["-a", "-d", "cwd", "-p", [...ports.keys()].join(","), "-F", "pn"], { timeout: 5000 });
      let p = 0;
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("p")) p = Number(line.slice(1));
        else if (line.startsWith("n") && p) cwds.set(p, line.slice(1));
      }
    } catch {
      // 拿不到工作目录：只按端口上的回应判断
    }
  }
  return [...ports].map(([p, set]) => ({ pid: p, ports: [...set].sort((a, b) => a - b), cwd: cwds.get(p) ?? null }));
}

/**
 * 有没有服务在写这个目录。blocking：确定在写或无法排除（--force 时降为警告）；notes：说明。
 * opts: { ports, scan（false 不扫描其他进程；{ pids } 只看这些进程）, repoRoots, force, fetch, timeoutMs, ownLock（锁是自己拿着的） }
 */
export async function checkServices(dataDir, opts = {}) {
  const ports = opts.ports ?? DEFAULT_PORTS;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const blocking = [];
  const unsure = [];
  const notes = [];
  const lockOwner = path.join(dataDir, LOCK_DIR, "owner");
  // 本脚本自己拿着锁时（执行中再查一次）不看锁
  const lockSt = opts.ownLock ? null : ((await fsp.stat(lockOwner).catch(() => null)) ?? (await fsp.stat(path.join(dataDir, LOCK_DIR)).catch(() => null)));
  if (lockSt) {
    if (Date.now() - lockSt.mtimeMs < LOCK_STALE_MS) blocking.push(`${path.join(dataDir, LOCK_DIR)} 正被持有：有进程正在写入这个目录`);
    else notes.push("发现过期的锁 .lock（之前的进程没有正常退出），执行时会接管它");
  }
  const real = async (p) => fsp.realpath(p).catch(() => path.resolve(p));
  const target = await real(dataDir);
  /** blockUnknown：回应不像 Paperloom 时是否拦下（指定的端口、工作目录就是本仓库的进程） */
  const judge = (where, r, blockUnknown) => {
    if (r.kind === "old") blocking.push(`旧版 Paperloom 服务（${where}）正在使用这个目录：请先停止它（在运行 npm run dev 的终端按 Ctrl+C）`);
    else if (r.kind === "new") notes.push(`新版 Paperloom 服务（${where}）正在使用这个目录：迁移完成前它不会写入，迁移后刷新页面即可`);
    else if (r.kind === "other") notes.push(`${where} 上的 Paperloom 服务使用的是另一个目录（${r.dataDir}），不受影响`);
    else if (r.kind === "unknown" && blockUnknown)
      unsure.push(`${where} 有程序在监听，但${r.detail}：可能是被挂起的旧版服务。请停止它，或确认与此无关后加 --force`);
  };
  const checked = new Set();
  for (const port of ports) {
    checked.add(port);
    judge(`localhost:${port}`, await classifyPort(port, target, real, fetchImpl, timeoutMs), true);
  }
  if (opts.scan !== false) {
    const list = await nodeListeners(typeof opts.scan === "object" ? opts.scan.pids : undefined);
    if (!list) notes.push(`无法列出本机其他端口上的 node 进程（lsof 不可用）：只检查了端口 ${ports.join("、") || "（无）"}`);
    else {
      const roots = await Promise.all([...(opts.repoRoots ?? []), path.dirname(dataDir)].map(real));
      for (const l of list) {
        const cwdMatches = l.cwd ? roots.includes(await real(l.cwd)) : null;
        for (const port of l.ports) {
          if (checked.has(port)) continue;
          checked.add(port);
          const r = await classifyPort(port, target, real, fetchImpl, Math.min(timeoutMs, 1500));
          const where = `localhost:${port}（进程 ${l.pid}${l.cwd ? `，工作目录 ${l.cwd}` : ""}）`;
          // 工作目录不是本仓库的进程回应不像 Paperloom：多半是无关的程序，不拦；工作目录拿不到时说明一下
          judge(where, r, cwdMatches === true);
          if (r.kind === "unknown" && cwdMatches === null) notes.push(`无法确认 ${where} 的工作目录，它也没有按 Paperloom 的方式回应：如果它是 Paperloom，请先停止`);
        }
      }
    }
  }
  if (opts.force && unsure.length) {
    for (const u of unsure) notes.push(`（--force）${u}`);
    return { blocking, notes, unsure: [] };
  }
  return { blocking, notes, unsure };
}

// ---------- 锁 ----------

/** 拿 data/.lock（与 server/storageFs.ts 的 withDirLock 同一格式：目录 + owner 令牌，定期刷新 mtime 作为心跳） */
async function acquireLock(dataDir) {
  const lockDir = path.join(dataDir, LOCK_DIR);
  const owner = path.join(lockDir, "owner");
  const token = randomBytes(12).toString("hex");
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.mkdir(lockDir);
      await fsp.writeFile(owner, token);
      break;
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
      const st = (await fsp.stat(owner).catch(() => null)) ?? (await fsp.stat(lockDir).catch(() => null));
      if (st && Date.now() - st.mtimeMs <= LOCK_STALE_MS) throw new Error(`${lockDir} 正被持有：有进程正在写入这个目录`);
      const grave = `${lockDir}.stale-${randomBytes(4).toString("hex")}`;
      if (await fsp.rename(lockDir, grave).then(() => true, () => false)) await fsp.rm(grave, { recursive: true, force: true });
      if (i === 2) throw new Error(`无法接管过期的锁 ${lockDir}`);
    }
  }
  const beat = setInterval(() => {
    const t = new Date();
    void fsp.utimes(owner, t, t).catch(() => {});
  }, Math.floor(LOCK_STALE_MS / 3));
  beat.unref?.();
  const owned = async () => (await fsp.readFile(owner, "utf8").catch(() => "")) === token;
  return {
    owned,
    async release() {
      clearInterval(beat);
      if (await owned()) await fsp.rm(lockDir, { recursive: true, force: true });
    },
  };
}

// ---------- 迁移 ----------

function rollbackText(dataDir, backupDir, now) {
  const failed = path.join(path.dirname(dataDir), `${MIGRATION_BACKUP_PREFIX}${stamp(now)}-failed`);
  return [
    "从备份恢复到迁移前：",
    "  1. 停止 Paperloom 服务（Ctrl+C）",
    `  2. 把现在的数据目录改名留作排查：mv "${dataDir}" "${failed}"`,
    `  3. 用备份恢复：mv "${backupDir}" "${dataDir}"`,
  ];
}

async function writeRegistry(dataDir, name, now) {
  const t = now.getTime();
  const projects = [{ id: DEFAULT_PROJECT_ID, name, createdAt: t, updatedAt: t }];
  // 上次中断时 projects/ 下可能已有其他目录（正常迁移只有 default）
  for (const d of await fsp.readdir(path.join(dataDir, PROJECTS_DIR), { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== DEFAULT_PROJECT_ID && PROJECT_ID_RE.test(d.name)) projects.push({ id: d.name, name: d.name, createdAt: t, updatedAt: t });
  }
  const file = path.join(dataDir, REGISTRY_FILE);
  const tmp = path.join(dataDir, `.${REGISTRY_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(`${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
    await fh.datasync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
  return projects;
}

/**
 * 迁移。返回退出码（0 成功或无需迁移，1 失败或拒绝执行）。
 * opts: { dataDir, name, apply, force, ports, scan, repoRoots, now, log, fetch,
 *         hooks: { afterBackup, beforeMoveEntry(name), afterMove } }（hooks 仅供测试注入故障）
 */
export async function migrate(opts) {
  const log = opts.log ?? ((s) => console.log(s));
  const dataDir = path.resolve(opts.dataDir);
  const name = (opts.name ?? DEFAULT_PROJECT_NAME).trim();
  const now = opts.now ?? new Date();
  const apply = !!opts.apply;
  const hooks = opts.hooks ?? {};
  const svcOpts = { ports: opts.ports ?? DEFAULT_PORTS, scan: opts.scan, repoRoots: opts.repoRoots, force: opts.force, fetch: opts.fetch, timeoutMs: opts.timeoutMs };
  if (!name || [...name].length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
    log("项目名称需为 1–60 个字符");
    return 1;
  }

  log(`数据目录：${dataDir}`);
  let info;
  try {
    info = await inspectDataDir(dataDir);
  } catch (e) {
    log(`✗ 无法读取数据目录：${errText(e)}`);
    return 1;
  }
  switch (info.state) {
    case "missing":
      log("找不到这个目录（用 --data 指定数据目录）");
      return 1;
    case "symlink":
      log(`✗ 这个路径是符号链接（指向 ${info.target}）：请用 --data 直接指定真实目录，备份才会是完整的数据而不是一个链接`);
      return 1;
    case "not-dir":
      log("这不是一个目录");
      return 1;
    case "nested":
      log(`✗ 这个目录位于 ${PROJECTS_DIR}/ 下，是某个项目的目录：不能再迁移（迁移的是 data/ 本身）`);
      return 1;
    case "empty":
      log("目录里没有数据，无需迁移（服务第一次保存时会自动建立项目结构）");
      return 0;
    case "registry-broken":
      log(`✗ 有 ${REGISTRY_FILE} 但无法读取（${info.error}）：已经迁移过但登记表损坏，请检查或从备份恢复这个文件`);
      return 1;
    case "migrated":
      log(`已经是项目结构（有 ${REGISTRY_FILE}），无需迁移`);
      if (info.strays.length)
        log(`注意：根目录下还有不属于项目结构的条目：${info.strays.join("、")}（未处理；可能是迁移后又启动过旧版本写入的，见页面上的提示）`);
      return 0;
    case "in-progress":
      log(`✗ 发现 ${MIGRATING_MARKER}：上次迁移没有完成（开始于 ${info.marker?.startedAt ?? "未知时间"}）。`);
      if (info.marker?.backupDir) for (const l of rollbackText(dataDir, info.marker.backupDir, now)) log(l);
      else log("请从上次迁移时的备份目录（data-backup-before-projects-*）恢复后再运行。");
      return 1;
    case "inconsistent":
      log(`状态不一致：既有 ${PROJECTS_DIR}/，根目录下又有旧版文件（${info.entries.filter((n) => n !== PROJECTS_DIR && !isIgnorable(n)).join("、")}）`);
      log("可能是上次迁移中途失败。请按上次迁移输出的方法从备份恢复后再运行。");
      return 1;
    default:
      break;
  }

  // 上次（旧版本脚本）迁移在最后一步（写 projects.json）之前中断：数据都已在 projects/ 下，只差登记表
  if (info.state === "interrupted") {
    if (!(await exists(path.join(dataDir, PROJECTS_DIR, DEFAULT_PROJECT_ID)))) {
      log(`只有空的 ${PROJECTS_DIR}/，无需迁移（服务第一次保存时会自动建立项目结构）`);
      return 0;
    }
    log(`${PROJECTS_DIR}/ 已就位但缺少 ${REGISTRY_FILE}（上次迁移在最后一步中断）`);
    if (!apply) {
      log(`预览：将写入 ${REGISTRY_FILE}（default 项目名称：${name}）。加 --apply 执行。`);
      return 0;
    }
    const projects = await writeRegistry(dataDir, name, now);
    log(`已写入 ${REGISTRY_FILE}：${projects.map((p) => `${p.id}（${p.name}）`).join("、")}`);
    return 0;
  }

  // ---------- 旧版结构：盘点 ----------
  if (!(await looksLikePaperLens(dataDir))) {
    if (!opts.force) {
      log("✗ 这个目录看起来不是 Paperloom 的数据目录（没有 Paperloom 的 library.json，pdfs/ 里也不是按哈希命名的 PDF）。");
      log("  确认没有指错目录后加 --force 再运行。");
      return 1;
    }
    log("· 注意（--force）：这个目录看起来不是 Paperloom 的数据目录");
  }
  const libPath = path.join(dataDir, "library.json");
  const skipTop = [LOCK_DIR, MIGRATING_MARKER];
  let before;
  let inventory;
  let pdfsBefore;
  try {
    before = await inspectLibrary(libPath);
    pdfsBefore = await countPdfs(path.join(dataDir, "pdfs"));
    if (apply) log("正在计算每个文件的校验值…");
    inventory = await manifest(dataDir, { hash: apply, skipTop });
    if (!apply) {
      const unreadable = [];
      for (const [rel, v] of inventory) {
        if (v.type === "file" && !(await fsp.access(path.join(dataDir, rel), fsp.constants.R_OK).then(() => true, () => false))) unreadable.push(rel);
      }
      if (unreadable.length) throw new Error(`以下文件没有读取权限，备份会失败：${unreadable.slice(0, 5).join("、")}${unreadable.length > 5 ? " 等" : ""}`);
    }
  } catch (e) {
    log(`✗ 盘点失败：${errText(e)}。未做任何改动。`);
    return 1;
  }
  const sum = totals(inventory);
  const moving = info.entries.filter((n) => n !== PROJECTS_DIR && !skipTop.includes(n));
  const backupDir = path.join(path.dirname(dataDir), `${MIGRATION_BACKUP_PREFIX}${stamp(now)}`);
  const target = path.join(dataDir, PROJECTS_DIR, DEFAULT_PROJECT_ID);

  log("当前是旧版目录结构，需要迁移。");
  if (!before.exists) log("· 注意：没有 library.json（只有其他文件）");
  else if (before.error) log(`· 注意：library.json 无法解析（${before.error}），会原样移动`);
  else log(`· library.json：revision ${before.revision}；${countsText(before.counts)}`);
  log(`· PDF：${pdfsBefore} 个；全部文件 ${sum.count} 个，共 ${fmtBytes(sum.bytes)}`);
  const links = brokenLinks(dataDir, inventory);
  if (links.length) log(`· 注意：以下符号链接迁移后会失效（目录多了 projects/default/ 两层）：${links.join("；")}`);

  const svc = await checkServices(dataDir, svcOpts);
  for (const n of svc.notes) log(`· ${n}`);
  if (svc.blocking.length || svc.unsure.length) {
    for (const b of [...svc.blocking, ...svc.unsure]) log(`✗ ${b}`);
    log("未做任何改动。");
    return 1;
  }

  log("");
  log(apply ? "执行：" : "预览（dry run，不改动任何文件）：");
  log(`  ① 完整备份 ${dataDir}/ → ${backupDir}/ 并逐个文件核对内容`);
  log(`  ② 新建 ${PROJECTS_DIR}/${DEFAULT_PROJECT_ID}/`);
  log(`  ③ 移动（rename）到 ${PROJECTS_DIR}/${DEFAULT_PROJECT_ID}/：${moving.join("、")}`);
  log("  ④ 核对：library.json 内容与记录数、PDF 数、完整文件清单与迁移前一致（不一致则自动移回）");
  log(`  ⑤ 最后写入 ${REGISTRY_FILE}：default（${name}）`);
  log(`  全程持有 data/${LOCK_DIR}（旧版服务写不了 library.json）；②–⑤ 期间放着 ${MIGRATING_MARKER}（新版服务不写入）`);
  if (!apply) {
    log("");
    log("确认无误后加上 --apply 再运行一次（npm run migrate:projects -- --apply，其余参数照旧）");
    return 0;
  }
  if (await exists(backupDir)) {
    log(`✗ 备份目录已存在：${backupDir}（稍后再试）`);
    return 1;
  }
  // 完整备份要再占一份空间
  const fsInfo = await fsp.statfs(path.dirname(dataDir)).catch(() => null);
  const free = fsInfo ? fsInfo.bavail * fsInfo.bsize : Infinity;
  if (free < sum.bytes * 1.05 + 64 * 1024 * 1024) {
    log(`✗ 磁盘空间不足：备份需要约 ${fmtBytes(sum.bytes)}，${path.dirname(dataDir)} 所在磁盘只剩 ${fmtBytes(free)}。未做任何改动。`);
    return 1;
  }

  let lock;
  try {
    lock = await acquireLock(dataDir);
  } catch (e) {
    log(`✗ ${errText(e)}。未做任何改动。`);
    return 1;
  }
  try {
    return await applyMigration();
  } finally {
    await lock.release();
  }

  async function applyMigration() {
    log("");
    // ① 备份
    let backupMade = false;
    const dropBackup = async () => {
      if (backupMade) await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    };
    try {
      backupMade = true;
      const skip = new Set(skipTop.map((n) => path.join(dataDir, n)));
      await fsp.cp(dataDir, backupDir, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true, filter: (src) => !skip.has(src) });
      // cp 只保留文件的时间：目录在写入文件时被改过，按原目录补回（由深到浅，免得改子目录时又碰到上级）
      const dirs = [...inventory].filter(([, v]) => v.type === "dir").map(([k]) => k);
      dirs.sort((a, b) => b.split("/").length - a.split("/").length);
      for (const rel of [...dirs, ""]) {
        const st = await fsp.lstat(path.join(dataDir, rel));
        await fsp.utimes(path.join(backupDir, rel), st.atime, st.mtime);
      }
      const [bst, dst] = await Promise.all([fsp.lstat(backupDir), fsp.stat(dataDir)]);
      if (!bst.isDirectory() || bst.isSymbolicLink()) throw new Error("备份不是一个真实的目录");
      if (bst.dev === dst.dev && bst.ino === dst.ino) throw new Error("备份与原目录是同一个目录");
      const copied = await manifest(backupDir, { hash: true });
      const d = diffManifests(inventory, copied, ["type", "size", "sha", "link"]);
      if (d.length) throw new Error(`备份核对失败：${d.join("；")}`);
    } catch (e) {
      log(`✗ ① 备份失败：${errText(e)}`);
      await dropBackup();
      log("数据目录没有改动，不完整的备份已删除。");
      return 1;
    }
    log(`✓ ① 已备份并逐个文件核对：${backupDir}（${sum.count} 个文件，${fmtBytes(sum.bytes)}）`);
    await hooks.afterBackup?.();

    // 备份花了一段时间：动手之前再确认一次没有服务在写、目录也没变过
    const again = await checkServices(dataDir, { ...svcOpts, ownLock: true });
    const stillOwned = await lock.owned();
    const changed = diffManifests(inventory, await manifest(dataDir, { skipTop }), ["type", "size", "mtimeMs", "link"]);
    if (again.blocking.length || again.unsure.length || !stillOwned || changed.length) {
      const why = [...again.blocking, ...again.unsure, ...(stillOwned ? [] : [`${LOCK_DIR} 被别的进程接管了`]), ...(changed.length ? [`备份之后目录有变化：${changed.join("；")}`] : [])];
      for (const w of why) log(`✗ ${w}`);
      await dropBackup();
      log("已取消：数据目录没有改动，刚做的备份已删除。");
      return 1;
    }

    const moved = [];
    const markerPath = path.join(dataDir, MIGRATING_MARKER);
    let committed = false;
    try {
      // ② ③
      await fsp.writeFile(markerPath, `${JSON.stringify({ startedAt: now.toISOString(), backupDir, pid: process.pid })}\n`);
      await fsp.mkdir(path.join(dataDir, PROJECTS_DIR));
      await fsp.mkdir(target);
      log(`✓ ② 已新建 ${PROJECTS_DIR}/${DEFAULT_PROJECT_ID}/`);
      for (const n of moving) {
        await hooks.beforeMoveEntry?.(n);
        await fsp.rename(path.join(dataDir, n), path.join(target, n));
        moved.push(n);
      }
      log(`✓ ③ 已移动 ${moved.length} 项：${moved.join("、")}`);
      await hooks.afterMove?.();

      // ④ 核对（写 projects.json 之前：核对不过时目录还能原样移回）
      const problems = [];
      const left = (await fsp.readdir(dataDir)).filter((n) => n !== PROJECTS_DIR && !skipTop.includes(n) && !isIgnorable(n));
      if (left.length) problems.push(`根目录下还有：${left.join("、")}`);
      const after = await inspectLibrary(path.join(target, "library.json"));
      if (before.exists) {
        if (!after.exists) problems.push("迁移后找不到 library.json");
        else if (after.sha !== before.sha) problems.push("library.json 内容与迁移前不一致");
        else if (!before.error && JSON.stringify(after.counts) !== JSON.stringify(before.counts)) problems.push("library.json 的记录数与迁移前不一致");
      }
      const pdfsAfter = await countPdfs(path.join(target, "pdfs"));
      if (pdfsAfter !== pdfsBefore) problems.push(`PDF 数量不一致：迁移前 ${pdfsBefore}，迁移后 ${pdfsAfter}`);
      // Finder 等写进来的 .DS_Store 之类不算
      const movedManifest = new Map([...(await manifest(target))].filter(([k]) => !k.split("/").some((seg) => seg === ".DS_Store")));
      const expected = new Map([...inventory].filter(([k]) => !k.split("/").some((seg) => seg === ".DS_Store")));
      const d = diffManifests(expected, movedManifest, ["type", "size", "mtimeMs", "link"]);
      if (d.length) problems.push(`文件清单不一致：${d.join("；")}`);
      if (problems.length) throw new Error(`核对失败：${problems.join("；")}`);
      log(`✓ ④ 核对通过${before.exists && !before.error ? `：${countsText(after.counts)}` : ""}；PDF ${pdfsAfter} 个；文件 ${totals(movedManifest).count} 个`);

      // ⑤ 提交点
      await writeRegistry(dataDir, name, now);
      committed = true;
      log(`✓ ⑤ 已写入 ${REGISTRY_FILE}`);
      await fsp.rm(markerPath, { force: true });
    } catch (e) {
      if (committed) {
        // projects.json 已写入：迁移已完成，只是没能删掉标记
        log(`· 注意：迁移已完成，但没能删除 ${markerPath}（${errText(e)}），请手动删除它`);
      } else {
        log(`✗ 迁移失败：${errText(e)}`);
        const restored = await rollBack(moved, markerPath);
        if (restored) {
          log(`已自动把移动过的 ${moved.length} 项移回原处，数据目录恢复为迁移前的结构。备份保留在：${backupDir}`);
        } else {
          log(`✗ 自动移回也失败了。已移动到 ${target}/ 的条目：${moved.join("、") || "（无）"}`);
          for (const l of rollbackText(dataDir, backupDir, now)) log(l);
        }
        return 1;
      }
    }

    log("");
    log("迁移完成。");
    log(`  数据现在在：${target}/`);
    log(`  项目登记表：${path.join(dataDir, REGISTRY_FILE)}`);
    log(`  完整备份：${backupDir}/（确认一切正常后可以删除）`);
    log("  接下来：启动（或刷新）Paperloom，原来的数据就是项目「" + name + "」");
    log(`  如果你把 Obsidian 指向了 data/markdown，请改为 data/projects/${DEFAULT_PROJECT_ID}/markdown`);
    for (const l of rollbackText(dataDir, backupDir, now)) log(l);
    return 0;
  }

  /** 按相反顺序把移动过的条目移回根目录，删掉空的 projects/default/、projects/ 和标记；全部成功返回 true */
  async function rollBack(moved, markerPath) {
    let ok = true;
    for (const n of [...moved].reverse()) {
      try {
        await fsp.rename(path.join(target, n), path.join(dataDir, n));
      } catch (e) {
        ok = false;
        log(`  移回 ${n} 失败：${errText(e)}`);
      }
    }
    if (!ok) return false;
    try {
      // 目录里只剩 Finder 之类写进来的 .DS_Store 时一起删掉
      await fsp.rm(path.join(target, ".DS_Store"), { force: true });
      await fsp.rmdir(target).catch((e) => (errCode(e) === "ENOENT" ? undefined : Promise.reject(e)));
      await fsp.rm(path.join(dataDir, PROJECTS_DIR, ".DS_Store"), { force: true });
      await fsp.rmdir(path.join(dataDir, PROJECTS_DIR)).catch((e) => (errCode(e) === "ENOENT" ? undefined : Promise.reject(e)));
      await fsp.rm(markerPath, { force: true });
      return true;
    } catch (e) {
      log(`  清理 ${PROJECTS_DIR}/ 失败：${errText(e)}`);
      return false;
    }
  }
}

export function parseArgs(argv, repoRoot) {
  const out = { dataDir: path.join(repoRoot, "data"), name: DEFAULT_PROJECT_NAME, apply: false, force: false, ports: DEFAULT_PORTS, scan: true, repoRoots: [repoRoot] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 需要一个值`);
      return v;
    };
    if (a === "--apply") out.apply = true;
    else if (a === "--force") out.force = true;
    else if (a === "--no-process-scan") out.scan = false;
    else if (a === "--data") out.dataDir = path.resolve(val());
    else if (a === "--name") out.name = val();
    else if (a === "--ports") {
      const v = val();
      out.ports =
        v === "none"
          ? []
          : v.split(",").map((p) => {
              const n = Number(p);
              if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`无效的端口：${p}`);
              return n;
            });
    } else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

const HELP = `用法：npm run migrate:projects -- [选项]
  --data <目录>       数据目录（默认 <仓库>/data）
  --name <名称>       迁移后的项目名称（默认"${DEFAULT_PROJECT_NAME}"）
  --apply             真正执行（不加时只预览）
  --ports <列表>      检查这些本机端口上是否有旧版服务在写这个目录（默认 ${DEFAULT_PORTS.join(",")}；none 不检查）
  --no-process-scan   不检查其他端口上的 node 进程（默认用 lsof 检查）
  --force             端口上的程序无法确认身份、或目录看起来不是 Paperloom 数据时仍然执行`;

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let args;
  try {
    args = parseArgs(process.argv.slice(2), repoRoot);
  } catch (e) {
    console.error(errText(e));
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  process.exitCode = await migrate(args);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
