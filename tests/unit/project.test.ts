// 项目标识（lib/project.ts）：数据库名、localStorage 键、锁名、Worker 名的约定，以及 Worker 里按 Worker 名确定项目。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dbNameFor,
  isProjectId,
  projectApiBase,
  projectIdFromWorkerName,
  projectKey,
  projectScoped,
  workerName,
} from "@/lib/project";
import { generateProjectId } from "@/services/projects";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("lib/project", () => {
  it("default 沿用原来的数据库名和 localStorage 键；其他项目带后缀", () => {
    expect(dbNameFor("default")).toBe("paperlens");
    expect(dbNameFor("roformer-ab12")).toBe("paperlens-p-roformer-ab12");
    expect(projectKey("paperlens.library", "default")).toBe("paperlens.library");
    expect(projectKey("paperlens:storage:sync", "x1")).toBe("paperlens:storage:sync@x1");
    // 锁和频道：default 也带后缀
    expect(projectScoped("paperlens-storage", "default")).toBe("paperlens-storage:default");
    expect(projectScoped("paperlens-indexer", "x1")).toBe("paperlens-indexer:x1");
    expect(projectApiBase("x1")).toBe("/__paperlens/p/x1/storage");
  });

  it("项目 id 规则", () => {
    for (const ok of ["default", "a", "roformer-ab12", "p-2x9k3m", "0abc"]) expect(isProjectId(ok)).toBe(true);
    for (const bad of ["", "-a", "A", "a_b", "a/b", "..", "a".repeat(41), "默认"]) expect(isProjectId(bad)).toBe(false);
  });

  it("Worker 名带项目，可以解析回来", () => {
    expect(workerName("paperlens-storage", "x1")).toBe("paperlens-storage@x1");
    expect(projectIdFromWorkerName("paperlens-indexer@roformer-ab12")).toBe("roformer-ab12");
    expect(projectIdFromWorkerName("paperlens-indexer")).toBeNull();
    expect(projectIdFromWorkerName("paperlens-indexer@Bad")).toBeNull();
    expect(projectIdFromWorkerName(undefined)).toBeNull();
  });

  it("页面上：默认 default，setCurrentProjectId 之后固定不变", async () => {
    const m = await import("@/lib/project");
    m.setCurrentProjectId("proj-1");
    expect(m.currentProjectId()).toBe("proj-1");
    expect(() => m.setCurrentProjectId("other")).toThrow(/重新加载/);
    expect(() => m.setCurrentProjectId("Bad!")).toThrow();
  });

  it("Worker 里：按 Worker 名确定项目，打开的数据库与页面一致；名字里没有项目时报错而不是退回 default", async () => {
    vi.stubGlobal("WorkerGlobalScope", function WorkerGlobalScope() {});
    vi.stubGlobal("name", workerName("paperlens-storage", "roformer-ab12"));
    const schema = await import("@/db/schema");
    expect(schema.db.name).toBe("paperlens-p-roformer-ab12");
    const api = await import("@/services/storage/api");
    expect(api.createStorageApi).toBeTypeOf("function");
    const m = await import("@/lib/project");
    expect(m.projectApiBase()).toBe("/__paperlens/p/roformer-ab12/storage");

    vi.resetModules();
    vi.stubGlobal("name", "paperlens-storage");
    const m2 = await import("@/lib/project");
    expect(() => m2.currentProjectId()).toThrow(/没有项目 id/);
  });

  it("单元测试环境（没有 ?project）下数据库仍是 paperlens", async () => {
    const schema = await import("@/db/schema");
    expect(schema.db.name).toBe("paperlens");
  });

  it("浏览器里新建项目的 id 与服务端同一规则", () => {
    const taken = new Set<string>();
    for (const n of ["RoFormer 精读", "轨迹预测", "default"]) {
      const id = generateProjectId(n, taken);
      expect(isProjectId(id)).toBe(true);
      taken.add(id);
    }
    expect(generateProjectId("RoFormer 精读", taken)).toMatch(/^roformer-[a-z2-9]{4}$/);
  });
});
