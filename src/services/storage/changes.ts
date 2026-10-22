// 把 Dexie 的 storagemutated 事件（本标签页、其他标签页和 Worker 的写入都会收到）归类成需要做的镜像工作。
// kv 里索引器的扫描戳（indexer:）和本模块的记账（storage:）是派生数据，变化时不触发保存。
import Dexie, { RangeSet, rangesOverlap, type ObservabilitySet } from "dexie";

export interface ChangeKinds {
  /** 需要保存到 library.json 的数据变了 */
  data: boolean;
  /** 论文或 PDF 文件变了：重新比对 data/pdfs */
  files: boolean;
  /** 出现位置变了：Markdown 的"出现于"需要更新 */
  occurrences: boolean;
}

const DATA_TABLES = ["domains", "papers", "annotations", "terms", "links", "notes", "boards", "boardNodes"];

let userKv: RangeSet | null = null;
/** kv 主键里非派生的部分：[最小, "indexer:"] ∪ ["indexer;", "storage:"] ∪ ["storage;", 最大]（";" 紧跟在 ":" 之后） */
function userKvRanges(): RangeSet {
  userKv ??= new RangeSet(Dexie.minKey, "indexer:").add({ from: "indexer;", to: "storage:" }).add({ from: "storage;", to: Dexie.maxKey });
  return userKv;
}

export function classifyMutation(parts: ObservabilitySet, dbName: string): ChangeKinds {
  if ((parts as { all?: unknown }).all) return { data: true, files: true, occurrences: true };
  const prefix = `idb://${dbName}/`;
  const out: ChangeKinds = { data: false, files: false, occurrences: false };
  for (const key of Object.keys(parts)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    const table = slash >= 0 ? rest.slice(0, slash) : rest;
    const index = slash >= 0 ? rest.slice(slash + 1) : "";
    if (DATA_TABLES.includes(table)) {
      out.data = true;
      if (table === "papers") out.files = true;
    } else if (table === "files") {
      out.files = true;
    } else if (table === "occurrences") {
      out.occurrences = true;
    } else if (table === "kv" && (index === "" || index === ":dels")) {
      if (rangesOverlap(parts[key], userKvRanges())) out.data = true;
    }
  }
  return out;
}
