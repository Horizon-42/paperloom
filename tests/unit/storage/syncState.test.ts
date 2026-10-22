// 同步记录按项目分开存；default 项目沿用迁移前的记录（以 data/ 根目录为标识）
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.resetModules();
});

describe("syncState", () => {
  it("default：键不变；迁移前以 data/ 根目录为标识的记录，只有 revision 和内容哈希都与项目文件夹一致时才沿用", async () => {
    const m = await import("@/services/storage/syncState");
    const P = "/repo/data/projects/default";
    localStorage.setItem("paperlens:storage:sync", JSON.stringify({ dataDir: "/repo/data", revision: 57, hash: "h" }));
    const unknown = { dataDir: P, revision: 0, hash: null };
    expect(m.loadSyncRecord(P)).toEqual(unknown);
    expect(m.loadSyncRecord(P, { dataDir: "/repo/data", revision: 57, contentHash: "h" })).toEqual({ dataDir: P, revision: 57, hash: "h" });
    // 评审第 10 项：迁移后又运行过旧版本——旧版在根目录写出 r1，文件夹里是 r60：对不上就当作不知道（走冲突），不会快进覆盖
    expect(m.loadSyncRecord(P, { dataDir: "/repo/data", revision: 60, contentHash: "x" })).toEqual(unknown);
    expect(m.loadSyncRecord(P, { dataDir: "/repo/data", revision: 57, contentHash: "other" })).toEqual(unknown);
    expect(m.loadSyncRecord(P, { dataDir: "/repo/data", revision: 57, contentHash: null })).toEqual(unknown);
    expect(m.loadSyncRecord(P, { dataDir: "/elsewhere", revision: 57, contentHash: "h" })).toEqual(unknown);
    // 已经按项目目录记过的照常沿用
    localStorage.setItem("paperlens:storage:sync", JSON.stringify({ dataDir: P, revision: 61, hash: "y" }));
    expect(m.loadSyncRecord(P, { dataDir: "/repo/data", revision: 70, contentHash: "z" })).toEqual({ dataDir: P, revision: 61, hash: "y" });
    m.saveSyncRecord({ dataDir: "/repo/data/projects/default", revision: 58, hash: "h2" });
    expect(JSON.parse(localStorage.getItem("paperlens:storage:sync")!)).toMatchObject({ dataDir: "/repo/data/projects/default", revision: 58 });
    m.saveDbInstance("abc");
    expect(localStorage.getItem("paperlens:storage:dbInstance")).toBe("abc");
  });

  it("其他项目：键带 @<id>，互不影响", async () => {
    history.replaceState(null, "", "/?project=roformer-ab12");
    const m = await import("@/services/storage/syncState");
    localStorage.setItem("paperlens:storage:sync", JSON.stringify({ dataDir: "/repo/data", revision: 57, hash: "h" }));
    localStorage.setItem("paperlens:storage:dbInstance", "default-instance");
    expect(m.loadSyncRecord("/repo/data/projects/roformer-ab12").revision).toBe(0);
    expect(m.loadDbInstance()).toBeNull();
    m.saveSyncRecord({ dataDir: "/repo/data/projects/roformer-ab12", revision: 3, hash: null });
    m.saveDbInstance("b-instance");
    expect(JSON.parse(localStorage.getItem("paperlens:storage:sync@roformer-ab12")!).revision).toBe(3);
    expect(localStorage.getItem("paperlens:storage:dbInstance@roformer-ab12")).toBe("b-instance");
    // default 的记录没被动过
    expect(JSON.parse(localStorage.getItem("paperlens:storage:sync")!).revision).toBe(57);
    expect(localStorage.getItem("paperlens:storage:dbInstance")).toBe("default-instance");
    const schema = await import("@/db/schema");
    expect(schema.db.name).toBe("paperlens-p-roformer-ab12");
  });
});
