import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/schema";
import { canRedo, canUndo, flushUndoStepForTest, installUndo, redo, resetUndoForTest, skipUndo, undo } from "@/db/undo";
import type { Domain, Paper } from "@/types/models";

installUndo();

const domain = (id: string, name: string): Domain => ({ id, name, parentId: null, color: "#3b82f6", order: 0 });
const paper = (id: string, extra: Partial<Paper> = {}): Paper => ({ id, fileHash: `h-${id}`, title: id, authors: [], domainIds: [], pageCount: 1, addedAt: 1, ...extra });

/** 不进撤销记录地准备数据 */
const quietly = (fn: () => Promise<unknown>) =>
  db.transaction("rw", db.domains, db.papers, async () => {
    skipUndo();
    await fn();
  });
/** 等事务的 complete 事件（提交后才记录），再结束这一步 */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushUndoStepForTest();
};

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  resetUndoForTest();
});

describe("撤销 / 重做", () => {
  it("修改、删除各是一步；撤销恢复原样，重做再做一遍", async () => {
    await quietly(() => db.domains.add(domain("d1", "A")));
    await db.domains.update("d1", { name: "B" });
    await settle();
    await db.domains.delete("d1");
    await settle();

    expect(await undo()).toBe(true);
    expect((await db.domains.get("d1"))?.name).toBe("B");
    expect(await undo()).toBe(true);
    expect((await db.domains.get("d1"))?.name).toBe("A");
    expect(await undo()).toBe(false);

    expect(await redo()).toBe(true);
    expect((await db.domains.get("d1"))?.name).toBe("B");
    expect(await redo()).toBe(true);
    expect(await db.domains.get("d1")).toBeUndefined();
    expect(await redo()).toBe(false);
  });

  it("新建后很快又改了它（新建领域后改名）：并成一步", async () => {
    await db.domains.add(domain("d1", "新领域"));
    await settle();
    await db.domains.update("d1", { name: "轨迹预测" });
    await settle();
    expect(await undo()).toBe(true);
    expect(await db.domains.get("d1")).toBeUndefined();
    expect(await undo()).toBe(false);
  });

  it("连按两次撤销：依次执行，重做两次都能回来", async () => {
    await quietly(() => db.domains.bulkAdd([domain("a", "A"), domain("b", "B")]));
    await db.domains.update("a", { name: "A2" });
    await settle();
    await db.domains.update("b", { name: "B2" });
    await settle();
    await Promise.all([undo(), undo()]);
    expect((await db.domains.get("a"))?.name).toBe("A");
    expect((await db.domains.get("b"))?.name).toBe("B");
    expect(canUndo()).toBe(false);
    await redo();
    await redo();
    expect((await db.domains.get("a"))?.name).toBe("A2");
    expect((await db.domains.get("b"))?.name).toBe("B2");
  });

  it("中止的事务不算", async () => {
    await quietly(() => db.domains.add(domain("d1", "A")));
    await db.transaction("rw", db.domains, async () => {
      await db.domains.update("d1", { name: "X" });
      throw new Error("abort");
    }).catch(() => undefined);
    await settle();
    expect(canUndo()).toBe(false);
  });

  it("间隔很短的连续写入（含跨表、同一条多次）算一步", async () => {
    await db.papers.add(paper("p1"));
    await settle();
    await db.domains.add(domain("d1", "A"));
    await db.papers.update("p1", { domainIds: ["d1"] });
    await db.papers.update("p1", { title: "renamed" });
    await settle();
    await undo();
    expect(await db.domains.get("d1")).toBeUndefined();
    expect(await db.papers.get("p1")).toMatchObject({ title: "p1", domainIds: [] });
    await redo();
    expect(await db.papers.get("p1")).toMatchObject({ title: "renamed", domainIds: ["d1"] });
  });

  it("只改了自动维护的字段（打开时间、页数）不算一步", async () => {
    await db.papers.add(paper("p1"));
    await settle();
    await db.papers.update("p1", { lastOpenedAt: 5 });
    await db.papers.update("p1", { pageCount: 9 });
    await settle();
    await undo(); // 撤销的是新建
    expect(await db.papers.get("p1")).toBeUndefined();
  });

  it("标了 skipUndo 的事务不记录；撤销后有新操作时重做作废", async () => {
    await db.transaction("rw", db.domains, async () => {
      skipUndo();
      await db.domains.add(domain("d0", "restored"));
    });
    await settle();
    expect(canUndo()).toBe(false);

    await db.domains.add(domain("d1", "A"));
    await settle();
    await undo();
    expect(canRedo()).toBe(true);
    await db.domains.add(domain("d2", "C"));
    await settle();
    expect(canRedo()).toBe(false);
    expect(await redo()).toBe(false);
    expect(await db.domains.get("d0")).toBeDefined();
  });

  it("put 覆盖已有记录：撤销回到覆盖前", async () => {
    await quietly(() => db.domains.add(domain("d1", "A")));
    await db.domains.put(domain("d1", "Z"));
    await settle();
    await undo();
    expect((await db.domains.get("d1"))?.name).toBe("A");
  });
});
