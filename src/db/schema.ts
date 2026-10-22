import Dexie, { type EntityTable, type Table } from "dexie";
import { currentProjectId, dbNameFor } from "@/lib/project";
import type {
  Annotation,
  Board,
  BoardNode,
  Domain,
  FileRecord,
  KvRecord,
  Link,
  Note,
  Occurrence,
  PageText,
  Paper,
  Term,
} from "@/types/models";

/** 导出文件 / 未来桌面版共用的数据格式版本。表结构有不兼容变化时 +1 */
export const DATA_FORMAT_VERSION = 1;

export class PaperLensDB extends Dexie {
  domains!: EntityTable<Domain, "id">;
  papers!: EntityTable<Paper, "id">;
  files!: EntityTable<FileRecord, "hash">;
  annotations!: EntityTable<Annotation, "id">;
  terms!: EntityTable<Term, "id">;
  occurrences!: Table<Occurrence, [string, string]>;
  pageTexts!: Table<PageText, [string, number]>;
  links!: EntityTable<Link, "id">;
  notes!: EntityTable<Note, "id">;
  boards!: EntityTable<Board, "id">;
  boardNodes!: EntityTable<BoardNode, "id">;
  kv!: EntityTable<KvRecord, "key">;

  constructor(name = "paperlens") {
    super(name);
    // 版本迁移：新增版本时追加 this.version(n).stores({...}).upgrade(...)，不要改旧版本
    this.version(1).stores({
      domains: "id, parentId",
      papers: "id, &fileHash, *domainIds, addedAt, lastOpenedAt",
      files: "hash",
      annotations: "id, paperId, [paperId+page], termId",
      terms: "id, name, *aliases",
      occurrences: "[termId+paperId], paperId, termId",
      pageTexts: "[paperId+page], paperId",
      // M5 预留
      links: "id, from.id, to.id",
      notes: "id",
      boards: "id",
      boardNodes: "id, boardId, ref.id",
      kv: "key",
    });
  }
}

/** 当前项目的数据库（每个项目一个，名字见 lib/project.ts 的 dbNameFor；页面和 Worker 打开的是同一个） */
export const db = new PaperLensDB(dbNameFor(currentProjectId()));

/** 申请持久化存储，降低浏览器清理站点数据的风险。返回是否已持久化 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
