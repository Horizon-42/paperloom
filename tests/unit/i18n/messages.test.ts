// 文案配置：各语言结构一致、英文里没有中文、函数文案能正常生成文字。
import { describe, expect, it } from "vitest";
import { localeFromLanguages, messagesFor } from "@/i18n";
import { interpolate } from "@/i18n/Trans";

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

type Leaf = { path: string; value: unknown };

function leaves(obj: unknown, prefix = ""): Leaf[] {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [{ path: prefix, value: obj }];
}

/** 函数文案的参数类型运行时不知道：依次试几组样例参数，收集能生成的文字 */
const SAMPLES: unknown[][] = [
  [],
  ["Alpha", "Beta", "Gamma", "Delta"],
  [1, 1, 1, 1],
  [3, 7, 2, 5],
  [["Alpha", "Beta", "Gamma"]],
  [new Date(2026, 9, 20, 14, 5), true],
  [new Date(2026, 9, 20, 14, 5), false],
  ["Alpha", 3, 7],
  [3, "Alpha", "Beta"],
  [{ name: "Alpha", count: 3 }],
];

function render(fn: (...a: unknown[]) => unknown): string[] {
  const out: string[] = [];
  for (const args of SAMPLES) {
    try {
      const r = fn(...args);
      if (typeof r === "string") out.push(r);
      else if (Array.isArray(r)) out.push(r.filter((x) => typeof x === "string").join(""));
    } catch {
      // 参数类型不对：换下一组
    }
  }
  return out;
}

describe("文案配置", () => {
  const zh = leaves(messagesFor("zh"));
  const en = leaves(messagesFor("en"));

  it("中英文结构一致，同一条文案的类型（文字 / 函数）相同", () => {
    expect(en.map((l) => l.path)).toEqual(zh.map((l) => l.path));
    const enBy = new Map(en.map((l) => [l.path, l.value]));
    const mismatched = zh.filter((l) => typeof l.value !== typeof enBy.get(l.path)).map((l) => l.path);
    expect(mismatched).toEqual([]);
  });

  it("英文文案里没有中文字符（含函数文案生成的文字）", () => {
    const bad: string[] = [];
    for (const { path, value } of en) {
      const texts = typeof value === "function" ? render(value as (...a: unknown[]) => unknown) : typeof value === "string" ? [value] : [];
      for (const s of texts) if (CJK.test(s)) bad.push(`${path}: ${s}`);
    }
    expect(bad).toEqual([]);
  });

  it("没有空文案；函数文案至少能用一组样例参数生成文字", () => {
    const bad: string[] = [];
    for (const locale of ["zh", "en"] as const) {
      for (const { path, value } of leaves(messagesFor(locale))) {
        if (typeof value === "string" && !value.trim()) bad.push(`${locale}:${path} 为空`);
        if (typeof value === "function" && render(value as (...a: unknown[]) => unknown).length === 0) bad.push(`${locale}:${path} 无法生成`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("浏览器语言 → 界面语言", () => {
    expect(localeFromLanguages(["zh-CN", "en"])).toBe("zh");
    expect(localeFromLanguages(["zh-TW"])).toBe("zh");
    expect(localeFromLanguages(["de-DE", "en-US"])).toBe("en");
    expect(localeFromLanguages(["de-DE", "fr"])).toBe("en");
    expect(localeFromLanguages([])).toBe("en");
  });

  it("interpolate 只替换给出的占位符", () => {
    expect(interpolate("用 {cmd} 启动，{other} 保留", { cmd: "X" })).toEqual(["用 ", expect.anything(), " 启动，{other} 保留"]);
  });
});
