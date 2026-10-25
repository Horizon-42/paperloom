// 撤销 / 重做（D20）：在数据库这一层统一记录，不必每个操作各写一套。
// 每次写库前（Dexie 的 creating / updating / deleting 钩子）记下被改动的记录原来的样子；
// 间隔很短的连续写入算一步操作。撤销时把这些记录放回原样（放回前先读出当时的样子，留作重做）。
// 不记录：派生数据（全文缓存、出现位置）、设置（kv）、只改了自动维护字段的更新（打开时间、页数、高亮矩形补算），
// 以及标了 skipUndo 的事务（从文件夹或备份恢复整个数据库）。
import Dexie, { type Transaction } from "dexie";
import { db } from "./schema";

/** 记录哪些表 */
const TABLES = ["domains", "papers", "files", "annotations", "terms", "links", "notes", "boards", "boardNodes"] as const;
type TableName = (typeof TABLES)[number];

/** 只改了这些字段的更新是程序自动维护的，不算一步操作 */
const AUTO_FIELDS = new Set(["lastOpenedAt", "pageCount", "rects", "anchorStatus"]);
/** 停止写入这么久之后，下一次写入算新的一步 */
const GROUP_GAP_MS = 300;
const MAX_STEPS = 50;

interface Step {
  /** 表 → 主键 → 改动前的记录（undefined：原来不存在） */
  before: Map<TableName, Map<unknown, unknown>>;
}

const undoStack: Step[] = [];
const redoStack: Step[] = [];
let open: Step | null = null;
let closeTimer = 0;
/** 正在执行撤销 / 重做：这时的写入不记录 */
let applying = false;
const skipped = new WeakSet<object>();
const listeners = new Set<() => void>();

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

function closeStep() {
  window.clearTimeout(closeTimer);
  if (!open) return;
  const step = open;
  open = null;
  if (![...step.before.values()].some((m) => m.size)) return;
  undoStack.push(step);
  if (undoStack.length > MAX_STEPS) undoStack.shift();
  emit();
}

function note(table: TableName, key: unknown, before: unknown, trans: Transaction) {
  if (applying || skipped.has(trans)) return;
  if (!open) {
    open = { before: new Map() };
    // 新的操作：重做记录作废
    if (redoStack.length) redoStack.length = 0;
  }
  let m = open.before.get(table);
  if (!m) open.before.set(table, (m = new Map()));
  // 同一步里同一条记录只记第一次改动前的样子
  if (!m.has(key)) m.set(key, before === undefined ? undefined : structuredClone(before));
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(closeStep, GROUP_GAP_MS);
  emit();
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
      note(name, key, obj, trans);
    });
  }
}

/** 把一步里的记录放回原样，返回放回前的样子（反方向的一步） */
async function apply(step: Step): Promise<Step> {
  const reverse: Step = { before: new Map() };
  applying = true;
  try {
    await db.transaction("rw", TABLES.map((n) => db.table(n)), async () => {
      for (const [name, entries] of step.before) {
        const table = db.table(name);
        const keys = [...entries.keys()];
        const current = await table.bulkGet(keys as never[]);
        reverse.before.set(name, new Map(keys.map((k, i) => [k, current[i]])));
        const puts = keys.filter((k) => entries.get(k) !== undefined).map((k) => entries.get(k));
        const dels = keys.filter((k) => entries.get(k) === undefined);
        if (dels.length) await table.bulkDelete(dels as never[]);
        if (puts.length) await table.bulkPut(puts as never[]);
      }
    });
  } finally {
    applying = false;
  }
  return reverse;
}

/** 撤销上一步，返回是否撤销了 */
export async function undo(): Promise<boolean> {
  closeStep();
  const step = undoStack.pop();
  if (!step) return false;
  try {
    redoStack.push(await apply(step));
  } catch (e) {
    undoStack.push(step);
    throw e;
  } finally {
    emit();
  }
  return true;
}

/** 重做刚撤销的一步，返回是否重做了 */
export async function redo(): Promise<boolean> {
  closeStep();
  const step = redoStack.pop();
  if (!step) return false;
  try {
    undoStack.push(await apply(step));
  } catch (e) {
    redoStack.push(step);
    throw e;
  } finally {
    emit();
  }
  return true;
}

/** 测试用：清空记录 */
export function resetUndoForTest() {
  window.clearTimeout(closeTimer);
  open = null;
  undoStack.length = 0;
  redoStack.length = 0;
}

/** 测试用：立即结束正在记录的一步 */
export const flushUndoStepForTest = closeStep;
