// 启动时确定语言：?lang= > localStorage > 浏览器语言；Worker 里从 Worker 名解析（workerKind）。
import { afterEach, describe, expect, it, vi } from "vitest";

async function freshI18n() {
  vi.resetModules();
  return import("@/i18n");
}

describe("语言检测", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("本浏览器的选择优先于浏览器语言", async () => {
    localStorage.setItem("paperlens.locale", "en");
    vi.stubGlobal("navigator", { ...navigator, languages: ["zh-CN"], language: "zh-CN" });
    expect((await freshI18n()).locale).toBe("en");
  });

  it("没有选择时按浏览器语言", async () => {
    vi.stubGlobal("navigator", { ...navigator, languages: ["zh-TW", "en"], language: "zh-TW" });
    expect((await freshI18n()).locale).toBe("zh");
  });

  it("?lang= 优先，并记住", async () => {
    localStorage.setItem("paperlens.locale", "zh");
    window.history.replaceState(null, "", "/?project=default&lang=en");
    const m = await freshI18n();
    expect(m.locale).toBe("en");
    expect(m.t.common.ok).toBe("OK");
    expect(localStorage.getItem("paperlens.locale")).toBe("en");
  });

  it("Worker 里从 Worker 名解析语言（workerKind + workerName）", async () => {
    vi.stubGlobal("WorkerGlobalScope", function WorkerGlobalScope() {});
    vi.stubGlobal("name", "paperlens-storage~en@proj-1");
    vi.stubGlobal("navigator", { ...navigator, languages: ["zh-CN"], language: "zh-CN" });
    expect((await freshI18n()).locale).toBe("en");
    vi.stubGlobal("name", "paperlens-indexer~zh@default");
    vi.stubGlobal("navigator", { ...navigator, languages: ["en-US"], language: "en-US" });
    expect((await freshI18n()).locale).toBe("zh");
  });

  it("workerKind 生成的名字仍能解析出项目 id", async () => {
    const { workerKind } = await freshI18n();
    const { workerName, projectIdFromWorkerName } = await import("@/lib/project");
    const name = workerName(workerKind("paperlens-storage"), "proj-1");
    expect(name).toMatch(/^paperlens-storage~(zh|en)@proj-1$/);
    expect(projectIdFromWorkerName(name)).toBe("proj-1");
  });
});
