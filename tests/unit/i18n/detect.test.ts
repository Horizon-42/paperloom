// 启动时确定语言：?lang= > localStorage > 第一次运行时的语言（新使用者英文、与浏览器语言无关；多语言之前就在用的中文）；
// Worker 里从 Worker 名解析（workerKind）。
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

  it("第一次运行时记下语言：之后写入的其他记录不会让它变成中文", async () => {
    expect((await freshI18n()).locale).toBe("en");
    expect(localStorage.getItem("paperlens.locale")).toBe("en");
    localStorage.setItem("paperlens.lastProject", "default");
    expect((await freshI18n()).locale).toBe("en");
  });

  it("多语言之前就在用（已有 PaperLens 的记录、没有语言选择）：保持中文并记住", async () => {
    localStorage.setItem("paperlens.lastProject", "default");
    localStorage.setItem("paperlens:storage:sync", "{}");
    expect((await freshI18n()).locale).toBe("zh");
    expect(localStorage.getItem("paperlens.locale")).toBe("zh");
  });

  it("其他网站的记录不算", async () => {
    localStorage.setItem("other-app", "1");
    expect((await freshI18n()).locale).toBe("en");
  });

  it("默认语言的环境变量可以带地区（zh-CN 等）", async () => {
    const { parseLocale } = await freshI18n();
    expect(["zh", "zh-CN", "zh_Hans", " ZH-tw ", "en-US", "EN"].map(parseLocale)).toEqual(["zh", "zh", "zh", "zh", "en", "en"]);
    expect(["fr", "", "chinese", undefined, null].map(parseLocale)).toEqual([undefined, undefined, undefined, undefined, undefined]);
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
    // 记住之后从地址里去掉，其他参数不变
    expect(window.location.search).toBe("?project=default");
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
