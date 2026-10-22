// 论文里哪些批注"在画布上或有连线"：角注栏的色条上据此画一个小点（没有笔记的批注平时只显示色条）。不依赖 React Flow。
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/schema";

const EMPTY: ReadonlySet<string> = new Set();

export async function loadCanvasPresence(paperId: string): Promise<ReadonlySet<string>> {
  const ids = (await db.annotations.where("paperId").equals(paperId).primaryKeys()) as string[];
  if (!ids.length) return EMPTY;
  const [nodes, out, inc] = await Promise.all([
    db.boardNodes.where("ref.id").anyOf(ids).toArray(),
    db.links.where("from.id").anyOf(ids).toArray(),
    db.links.where("to.id").anyOf(ids).toArray(),
  ]);
  const own = new Set(ids);
  const hit = new Set<string>();
  for (const n of nodes) if (n.ref.kind === "annotation" && own.has(n.ref.id)) hit.add(n.ref.id);
  for (const l of [...out, ...inc]) for (const r of [l.from, l.to]) if (r.kind === "annotation" && own.has(r.id)) hit.add(r.id);
  return hit;
}

export function usePaperCanvasPresence(paperId: string): ReadonlySet<string> {
  return useLiveQuery(() => loadCanvasPresence(paperId), [paperId]) ?? EMPTY;
}
