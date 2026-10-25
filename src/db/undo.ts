// 撤销 / 重做（D20）：在数据库这一层统一记录，不必每个操作各写一套。
// 每次写库前（Dexie 的 creating / updating / deleting 钩子）记下被改动的记录原来的样子，按事务收集，事务提交后才算数（中止的丢掉）；
// 间隔很短的连续提交算一步。撤销时把这些记录放回原样（放回前先读出当时的样子，留作重做）。
// 不记录：派生数据（全文缓存、出现位置）、设置（kv）、只改了自动维护字段的更新（打开时间、页数、高亮矩形补算），
// 以及标了 skipUndo 的事务（整库恢复、自动重新定位、查询引用数、撤销 / 重做本身）。整库被替换后清空记录（resetUndo）。
import Dexie, { type Transaction } from "dexie";
import { db } from "./schema";

/** 记录哪些表 */
const TABLES = ["domains", "papers", "files", "annotations", "terms", "links", "notes", "boards", "boardNodes"] as const;
type TableName = (typeof TABLES)[number];

/** 只改了这些字段的更新是程序自动维护的，不算一步操作 */
const AUTO_FIELDS = new Set(["lastOpenedAt", "pageCount", "rects", "anchorStatus"]);
/** 停止写入这么久之后，下一次写入算新的一步 */
const GROUP_GAP_MS = 300;
/** 下一步只改了上一步刚新建的记录（新建领域后改名、新建笔记后输入），这么久以内并进上一步 */
const MERGE_CREATED_MS = 3000;
const MAX_STEPS = 50;

/** 表 → 主键 → 改动前的记录（undefined：原来不存在） */
type Before = Map<TableName, Map<unknown, unknown>>;

interface Step {
  before: Before;
  closedAt: number;
}

const undoStack: Step[] = [];
const redoStack: Step[] = [];
/** 正在收集的一步：最近提交的事务的改动 */
let open: Before | null = null;
let closeTimer = 0;
/** 还没提交的事务各自的改动 */
const buffers = new Map<Transaction, Before>();
const skipped = new WeakSet<object>();
const listeners = new Set<() => void>();
/** 撤销、重做排队依次执行（连按 ⌘Z 不会交错） */
let queue: Promise<unknown> = Promise.resolve();

/** 在事务里调用：这个事务的写入不进撤销记录 */
export function skipUndo(trans: Transaction | null = Dexie.currentTransaction) {
  if (trans) skipped.add(trans);
}

function emit() {
  for (const l of listeners) l();
}

export function subscribeUndo(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const canUndo = () => undoStack.length > 0 || !!open;
export const canRedo = () => redoStack.length > 0 && !open;

const size = (b: Before) => [...b.values()].reduce((n, m) => n + m.size, 0);

/** 把 from 的改动并进 into：同一条记录保留更早的"改动前" */
function mergeInto(into: Before, from: Before) {
  for (const [table, entries] of from) {
    let m = into.get(table);
    if (!m) into.set(table, (m = new Map()));
    for (const [k, v] of entries) if (!m.has(k)) m.set(k, v);
  }
}

/** b 只改了 step 里新建的记录 */
function onlyTouchesCreated(b: Before, step: Step): boolean {
  for (const [table, entries] of b) {
    const created = step.before.get(table);
    for (const k of entries.keys()) if (!created?.has(k) || created.get(k) !== undefined) return false;
  }
  return true;
}

function closeStep() {
  window.clearTimeout(closeTimer);
  if (!open) return;
  const before = open;
  open = null;
  if (!size(before)) return;
  const last = undoStack[undoStack.length - 1];
  const now = Date.now();
  if (last && now - last.closedAt < MERGE_CREATED_MS && onlyTouchesCreated(before, last)) {
    mergeInto(last.before, before);
    last.closedAt = now;
  } else {
    undoStack.push({ before, closedAt: now });
    if (undoStack.length > MAX_STEPS) undoStack.shift();
  }
  emit();
}

/** 事务提交：它的改动并进正在收集的一步 */
function commit(trans: Transaction) {
  const b = buffers.get(trans);
  buffers.delete(trans);
  if (!b || !size(b)) return;
  if (!open) {
    open = new Map();
    // 新的操作：重做记录作废
    redoStack.length = 0;
  }
  mergeInto(open, b);
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(closeStep, GROUP_GAP_MS);
  emit();
}

function note(table: TableName, key: unknown, before: unknown, trans: Transaction) {
  if (skipped.has(trans)) return;
  let b = buffers.get(trans);
  if (!b) {
    buffers.set(trans, (b = new Map()));
    trans.on("complete", () => commit(trans));
    const drop = () => buffers.delete(trans);
    trans.on("abort", drop);
    trans.on("error", drop);
  }
  let m = b.get(table);
  if (!m) b.set(table, (m = new Map()));
  // 同一事务里同一条记录只记第一次改动前的样子
  if (!m.has(key)) m.set(key, before === undefined ? undefined : structuredClone(before));
}

const getPath = (obj: unknown, path: string) => path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
const sameValue = (a: unknown, b: unknown) => a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

let installed = false;

/** 挂上钩子（启动时调用一次） */
export function installUndo() {
  if (installed) return;
  installed = true;
  for (const name of TABLES) {
    const table = db.table(name);
    table.hook("creating", function (key, _obj, trans) {
      // 主键由数据给出（本应用都是字符串 id 或文件哈希）
      if (key !== undefined) note(name, key, undefined, trans);
    });
    table.hook("updating", function (mods, key, obj, trans) {
      // Dexie 给的 mods 里常带着没变的数组字段：逐个比较，只看真正变了的
      const changed = Object.entries(mods as Record<string, unknown>)
        .filter(([path, v]) => !sameValue(getPath(obj, path), v))
        .map(([path]) => path.split(".")[0]);
      if (!changed.length || changed.every((f) => AUTO_FIELDS.has(f))) return;
      note(name, key, obj, trans);
    });
    table.hook("deleting", function (key, obj, trans) {
      // 删除不存在的记录：没有改动
      if (obj !== undefined) note(name, key, obj, trans);
    });
  }
}

/** 把一步里的记录放回原样，返回放回前的样子（反方向的一步） */
async function apply(step: Step): Promise<Step> {
  const reverse: Before = new Map();
  await db.transaction("rw", TABLES.map((n) => db.table(n)), async () => {
    skipUndo();
    for (const [name, entries] of step.before) {
      const table = db.table(name);
      const keys = [...entries.keys()];
      const current = await table.bulkGet(keys as never[]);
      reverse.set(name, new Map(keys.map((k, i) => [k, current[i]])));
      const puts = keys.filter((k) => entries.get(k) !== undefined).map((k) => entries.get(k));
      const dels = keys.filter((k) => entries.get(k) === undefined);
      if (dels.length) await table.bulkDelete(dels as never[]);
      if (puts.length) await table.bulkPut(puts as never[]);
    }
  });
  return { before: reverse, closedAt: Date.now() };
}

function run(from: Step[], to: Step[]): Promise<boolean> {
  const next = queue.then(async () => {
    closeStep();
    const step = from.pop();
    if (!step) return false;
    try {
      to.push(await apply(step));
    } catch (e) {
      // 放不回去（例如这期间同一个 PDF 又被导入）：丢掉这一步，免得之后每次都卡在它上面
      console.error(e);
      throw e;
    } finally {
      emit();
    }
    return true;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** 撤销上一步，返回是否撤销了 */
export const undo = () => run(undoStack, redoStack);
/** 重做刚撤销的一步，返回是否重做了 */
export const redo = () => run(redoStack, undoStack);

/** 清空记录：整个数据库被替换后（从文件夹恢复、导入备份、载入别的窗口的改动），旧的记录对不上了 */
export function resetUndo() {
  if (typeof window !== "undefined") window.clearTimeout(closeTimer);
  open = null;
  undoStack.length = 0;
  redoStack.length = 0;
  emit();
}

/** 测试用 */
export const resetUndoForTest = resetUndo;
/** 测试用：立即结束正在记录的一步 */
export const flushUndoStepForTest = closeStep;
