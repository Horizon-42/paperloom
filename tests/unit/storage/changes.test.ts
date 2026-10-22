// storagemutated 事件的归类：派生数据（indexer:、storage:、pageTexts）的写入不触发保存
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Dexie, { type ObservabilitySet } from "dexie";
import { PaperLensDB } from "@/db/schema";
import { classifyMutation, type ChangeKinds } from "@/services/storage/changes";

const db = new PaperLensDB("storage-changes-test");
let events: ObservabilitySet[] = [];
const listener = (parts: ObservabilitySet) => void events.push(parts);

beforeAll(async () => {
  await db.open();
  Dexie.on.storagemutated.subscribe(listener);
});
afterAll(async () => {
  Dexie.on.storagemutated.unsubscribe(listener);
  await db.delete();
});

async function kinds(write: () => Promise<unknown>): Promise<ChangeKinds> {
  events = [];
  await write();
  await new Promise((r) => setTimeout(r, 0));
  const out: ChangeKinds = { data: false, files: false, occurrences: false };
  for (const e of events) {
    const k = classifyMutation(e, db.name);
    out.data ||= k.data;
    out.files ||= k.files;
    out.occurrences ||= k.occurrences;
  }
  return out;
}

describe("classifyMutation", () => {
  it("用户数据变化触发保存", async () => {
    expect(await kinds(() => db.terms.put({ id: "t1", name: "x", aliases: [], matchMode: "auto", scope: { kind: "global" }, note: "", createdAt: 1, updatedAt: 1 }))).toEqual({
      data: true,
      files: false,
      occurrences: false,
    });
    expect((await kinds(() => db.kv.put({ key: "termDisplay", value: { hidden: true } }))).data).toBe(true);
    expect((await kinds(() => db.kv.delete("termDisplay"))).data).toBe(true);
  });

  it("论文变化同时要求比对 PDF；PDF 文件只触发比对", async () => {
    expect(await kinds(() => db.papers.put({ id: "p1", fileHash: "h", title: "t", authors: [], domainIds: [], pageCount: 1, addedAt: 1 }))).toEqual({
      data: true,
      files: true,
      occurrences: false,
    });
    expect(await kinds(() => db.files.put({ hash: "h", blob: new Blob(["x"]), size: 1 }))).toEqual({ data: false, files: true, occurrences: false });
  });

  it("索引器的派生数据和本模块的记账不触发保存", async () => {
    expect(await kinds(() => db.kv.put({ key: "indexer:paper:p1", value: {} }))).toEqual({ data: false, files: false, occurrences: false });
    expect((await kinds(() => db.kv.bulkDelete(["indexer:paper:p1", "indexer:termStats"]))).data).toBe(false);
    expect((await kinds(() => db.kv.put({ key: "storage:lastExportAt", value: 1 }))).data).toBe(false);
    expect((await kinds(() => db.pageTexts.put({ paperId: "p1", page: 1, text: "x", fileHash: "h", engineVersion: 1 }))).data).toBe(false);
    expect(await kinds(() => db.occurrences.put({ termId: "t1", paperId: "p1", pages: [1], count: 1, engineVersion: 1 }))).toEqual({
      data: false,
      files: false,
      occurrences: true,
    });
  });

  it("其他数据库的事件忽略；all 视为全部变化", () => {
    expect(classifyMutation({ "idb://other/terms/": new (Dexie as unknown as { RangeSet: new (a: unknown, b: unknown) => never }).RangeSet(1, 2) } as ObservabilitySet, db.name).data).toBe(false);
    expect(classifyMutation({ all: true } as unknown as ObservabilitySet, db.name)).toEqual({ data: true, files: true, occurrences: true });
  });
});
