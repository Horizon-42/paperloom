import { describe, expect, it } from "vitest";
import { PaperLensDB } from "@/db/schema";

describe("db schema", () => {
  it("opens and supports the declared indexes", async () => {
    const db = new PaperLensDB("schema-test");
    await db.papers.add({
      id: "p1",
      fileHash: "h1",
      title: "T",
      authors: [],
      domainIds: ["d1", "d2"],
      pageCount: 1,
      addedAt: 1,
    });
    expect(await db.papers.where("domainIds").equals("d2").count()).toBe(1);
    await db.links.add({
      id: "l1",
      from: { kind: "annotation", id: "a1" },
      to: { kind: "term", id: "t1" },
      relation: "supports",
      createdAt: 1,
    });
    expect(await db.links.where("to.id").equals("t1").count()).toBe(1);
    await db.pageTexts.put({ paperId: "p1", page: 2, text: "x", fileHash: "h1", engineVersion: 1 });
    expect(await db.pageTexts.where("paperId").equals("p1").count()).toBe(1);
    await db.delete();
  });
});
