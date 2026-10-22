// 读取项目列表的结果分类（评审第 17 项）：没有本地服务、列表读不了（projects.json 损坏、没有响应）要分开，后者不能当作"没有服务"
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjectList } from "@/services/projects";

afterEach(() => vi.unstubAllGlobals());

const respond = (status: number, body: string, type = "application/json") =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "Content-Type": type } })));

describe("fetchProjectList", () => {
  it("正常：列出项目", async () => {
    respond(200, JSON.stringify({ service: "paperlens-storage", needsMigration: false, projects: [{ id: "default", name: "我的项目", createdAt: 1, updatedAt: 1 }, { id: "Bad!", name: "x" }] }));
    expect(await fetchProjectList()).toMatchObject({ kind: "ok", projects: [{ id: "default" }] });
  });

  it("没有本地服务：开发服务器回退到 index.html、静态部署的 404、连接被拒", async () => {
    respond(200, "<!doctype html>", "text/html");
    expect((await fetchProjectList()).kind).toBe("none");
    respond(404, "Not Found", "text/plain");
    expect((await fetchProjectList()).kind).toBe("none");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect((await fetchProjectList()).kind).toBe("none");
  });

  it("服务在但列表读不了：projects.json 损坏（500）、没有响应（超时）", async () => {
    respond(500, JSON.stringify({ error: "registry-unreadable", message: "data/projects.json 无法读取：Unexpected token" }));
    expect(await fetchProjectList()).toEqual({ kind: "error", message: "data/projects.json 无法读取：Unexpected token" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      ),
    );
    expect(await fetchProjectList(50)).toEqual({ kind: "error", message: "本地服务没有响应" });
  });
});
