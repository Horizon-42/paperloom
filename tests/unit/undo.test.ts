import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import { canRedo, canUndo, flushUndoStepForTest, installUndo, redo, resetUndoForTest, skipUndo, undo } from "@/db/undo";
import type { Domain, Paper } from "@/types/models";

installUndo();

const domain = (id: string, name: string): Domain => ({ id, name, parentId: null, color: "#3b82f6", order: 0 });
const paper = (id: string, extra: Partial<Paper> = {}): Paper => ({ id, fileHash: `h-${id}`, title: id, authors: [], domainIds: [], pageCount: 1, addedAt: 1, ...extra });

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetUndoForTest();
});

describe("撤销 / 重做", () => {
  it("新建、修改、删除各是一步；撤销恢复原样，重做再做一遍", async () => {
    await db.domains.add(domain("d1", "A"));
    flushUndoStepForTest();
    await db.domains.update("d1", { name: "B" });
    flushUndoStepForTest();
    await db.domains.delete("d1");
    flushUndoStepForTest();

    expect(await undo()).toBe(true);
    expect((await db.domains.get("d1"))?.name).toBe("B");
    expect(await undo()).toBe(true);
    expect((await db.domains.get("d1"))?.name).toBe("A");
    expect(await undo()).toBe(true);
    expect(await db.domains.get("d1")).toBeUndefined();
    expect(await undo()).toBe(false);

    expect(await redo()).toBe(true);
    expect((await db.domains.get("d1"))?.name).toBe("A");
    expect(await redo()).toBe(true);
    expect((await db.domains.get("d1"))?.name).toBe("B");
    expect(await redo()).toBe(true);
    expect(await db.domains.get("d1")).toBeUndefined();
    expect(await redo()).toBe(false);
  });

  it("间隔很短的连续写入（含跨表、同一条多次）算一步", async () => {
    await db.papers.add(paper("p1"));
    flushUndoStepForTest();
    await db.domains.add(domain("d1", "A"));
    await db.papers.update("p1", { domainIds: ["d1"] });
    await db.papers.update("p1", { title: "renamed" });
    flushUndoStepForTest();
    await undo();
    expect(await db.domains.get("d1")).toBeUndefined();
    expect(await db.papers.get("p1")).toMatchObject({ title: "p1", domainIds: [] });
    await redo();
    expect(await db.papers.get("p1")).toMatchObject({ title: "renamed", domainIds: ["d1"] });
  });

  it("只改了自动维护的字段（打开时间、页数）不算一步", async () => {
    await db.papers.add(paper("p1"));
    flushUndoStepForTest();
    await db.papers.update("p1", { lastOpenedAt: 5 });
    await db.papers.update("p1", { pageCount: 9 });
    flushUndoStepForTest();
    await undo(); // 撤销的是新建
    expect(await db.papers.get("p1")).toBeUndefined();
  });

  it("标了 skipUndo 的事务不记录；撤销后有新操作时重做作废", async () => {
    await db.transaction("rw", db.domains, async () => {
      skipUndo();
      await db.domains.add(domain("d0", "restored"));
    });
    flushUndoStepForTest();
    expect(canUndo()).toBe(false);

    await db.domains.add(domain("d1", "A"));
    flushUndoStepForTest();
    await undo();
    expect(canRedo()).toBe(true);
    await db.domains.add(domain("d2", "C"));
    flushUndoStepForTest();
    expect(canRedo()).toBe(false);
    expect(await redo()).toBe(false);
    expect(await db.domains.get("d0")).toBeDefined();
  });

  it("put 覆盖已有记录：撤销回到覆盖前", async () => {
    await db.domains.add(domain("d1", "A"));
    flushUndoStepForTest();
    await db.domains.put(domain("d1", "Z"));
    flushUndoStepForTest();
    await undo();
    expect((await db.domains.get("d1"))?.name).toBe("A");
  });
});
