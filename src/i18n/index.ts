// 界面语言（见 docs/decisions.md D13）。文案都在 locales/<语言>/<模块>.ts，组件里不写死任何一种语言。
// 语言在页面启动时确定一次（URL 的 ?lang= > 本浏览器的选择 > 浏览器语言 > 英文），切换语言 = 保存后重新加载页面，
// 所以模块加载时就可以读 t，运行中不会变。用法：t.library.importButton、t.library.paperCount(3)。
// Worker 读不到 localStorage：创建 Worker 时用 workerKind(kind) 把语言带进 Worker 名，Worker 里从 self.name 解析。
import { en } from "./locales/en";
import { zh, type Messages } from "./locales/zh";

export type { Messages };
export type Locale = "zh" | "en";

/** 可选的语言；label 用该语言自己的写法，不随界面语言变化 */
export const LOCALES: readonly { value: Locale; label: string; htmlLang: string }[] = [
  { value: "zh", label: "中文", htmlLang: "zh-CN" },
  { value: "en", label: "English", htmlLang: "en" },
];

/** 本浏览器选择的界面语言（与项目无关，所有项目共用） */
export const LOCALE_KEY = "paperlens.locale";

const DICTS: Record<Locale, Messages> = { zh, en };

export function isLocale(v: unknown): v is Locale {
  return v === "zh" || v === "en";
}

/** 浏览器语言列表里第一个能对应上的；都对应不上时用英文 */
export function localeFromLanguages(langs: readonly string[]): Locale {
  for (const l of langs) {
    const base = l.toLowerCase().split("-")[0];
    if (isLocale(base)) return base;
  }
  return "en";
}

const WORKER_TAG = /~(zh|en)(?=@|$)/;

function inWorker(): boolean {
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined";
}

function detectLocale(): Locale {
  if (inWorker()) {
    const m = WORKER_TAG.exec((globalThis as { name?: string }).name ?? "");
    if (m && isLocale(m[1])) return m[1];
  } else {
    // ?lang=：切换语言时带上（存不了 localStorage 时也能生效），也便于分享指定语言的链接
    const q = globalThis.location ? new URL(globalThis.location.href).searchParams.get("lang") : null;
    try {
      if (isLocale(q)) {
        globalThis.localStorage?.setItem(LOCALE_KEY, q);
        return q;
      }
      const saved = globalThis.localStorage?.getItem(LOCALE_KEY);
      if (isLocale(saved)) return saved;
    } catch {
      if (isLocale(q)) return q;
      // 读不到 localStorage（隐私模式等）：按浏览器语言
    }
  }
  const nav = globalThis.navigator;
  return localeFromLanguages(nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : []);
}

export let locale: Locale = detectLocale();
/** 当前语言的全部文案 */
export let t: Messages = DICTS[locale];

/** 指定语言的文案（需要生成与界面语言无关的内容时用，一般用 t） */
export function messagesFor(l: Locale): Messages {
  return DICTS[l];
}

export function htmlLang(l: Locale = locale): string {
  return LOCALES.find((x) => x.value === l)?.htmlLang ?? l;
}

/** 带上当前语言的 Worker 种类名，再交给 workerName()：如 "paperlens-storage~en" */
export function workerKind(kind: string): string {
  return `${kind}~${locale}`;
}

/** 保存选择并重新加载页面 */
export function setLocale(next: Locale): void {
  if (next === locale) return;
  const url = new URL(location.href);
  url.searchParams.delete("lang");
  try {
    localStorage.setItem(LOCALE_KEY, next);
  } catch {
    // 存不了：用 URL 带过去，至少本次切换生效
    url.searchParams.set("lang", next);
  }
  location.replace(url.toString());
}

/** 仅供测试：切换当前语言（不保存、不重新加载）。模块加载时就读取了 t 的常量不会跟着变 */
export function setLocaleForTest(l: Locale): void {
  locale = l;
  t = DICTS[l];
}
