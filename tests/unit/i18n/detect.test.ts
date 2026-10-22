// 启动时确定语言：?lang= > localStorage > 默认（英文，与浏览器语言无关）；Worker 里从 Worker 名解析（workerKind）。
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

  it("本浏览器的选择优先于默认语言", async () => {
    localStorage.setItem("paperlens.locale", "zh");
    expect((await freshI18n()).locale).toBe("zh");
  });

  it("没有选择时默认英文，即使浏览器是中文", async () => {
    vi.stubGlobal("navigator", { ...navigator, languages: ["zh-CN", "zh"], language: "zh-CN" });
    const m = await freshI18n();
    expect(m.DEFAULT_LOCALE).toBe("en");
    expect(m.locale).toBe("en");
  });

  it("切换按钮的顺序和缩写来自语言配置", async () => {
    const { LOCALES } = await freshI18n();
    expect(LOCALES.map((l) => l.short)).toEqual(["EN", "CN"]);
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
    vi.stubGlobal("name", "paperlens-indexer~zh@default");
    expect((await freshI18n()).locale).toBe("zh");
    vi.stubGlobal("name", "paperlens-storage~en@proj-1");
    expect((await freshI18n()).locale).toBe("en");
    // 名字里没有语言（旧的 Worker 名）：默认语言
    vi.stubGlobal("name", "paperlens-storage@proj-1");
    expect((await freshI18n()).locale).toBe("en");
  });

  it("workerKind 生成的名字仍能解析出项目 id", async () => {
    const { workerKind } = await freshI18n();
    const { workerName, projectIdFromWorkerName } = await import("@/lib/project");
    const name = workerName(workerKind("paperlens-storage"), "proj-1");
    expect(name).toMatch(/^paperlens-storage~(zh|en)@proj-1$/);
    expect(projectIdFromWorkerName(name)).toBe("proj-1");
  });
});
