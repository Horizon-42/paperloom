// 界面语言（见 docs/decisions.md D13）。文案都在 locales/<语言>/<模块>.ts，组件里不写死任何一种语言。
// 语言在页面启动时确定一次（URL 的 ?lang= > 本浏览器的选择 > 第一次运行时的语言），切换语言 = 保存后重新加载页面，
// 所以模块加载时就可以读 t，运行中不会变。用法：t.library.importButton、t.library.paperCount(3)。
// Worker 读不到 localStorage：创建 Worker 时用 workerKind(kind) 把语言带进 Worker 名，Worker 里从 self.name 解析。
import { en } from "./locales/en";
import { zh, type Messages } from "./locales/zh";

export type { Messages };
export type Locale = "zh" | "en";

/** 可选的语言（切换按钮按这个顺序排）；label 用该语言自己的写法、short 是按钮上的缩写，都不随界面语言变化 */
export const LOCALES: readonly { value: Locale; label: string; short: string; htmlLang: string }[] = [
  { value: "en", label: "English", short: "EN", htmlLang: "en" },
  { value: "zh", label: "中文", short: "CN", htmlLang: "zh-CN" }, // i18n-ignore: 语言名用该语言自己的写法
];

/** 本浏览器选择的界面语言（与项目无关，所有项目共用） */
export const LOCALE_KEY = "paperlens.locale";

const DICTS: Record<Locale, Messages> = { zh, en };

export function isLocale(v: unknown): v is Locale {
  return v === "zh" || v === "en";
}

/**
 * 新使用者的语言：英文，与浏览器语言无关（多语言之前就在用的保持中文，见 detectLocale）。
 * 构建/开发时可用环境变量 VITE_PAPERLENS_DEFAULT_LOCALE=zh 改（测试按中文界面断言，测试服务器都设成 zh）。
 */
export const DEFAULT_LOCALE: Locale = defaultLocale();

/** "zh"、"zh-CN"、"zh_Hans"、"EN-us" 等 → 支持的语言；其他 → undefined */
export function parseLocale(v: string | null | undefined): Locale | undefined {
  const base = v?.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(base) ? base : undefined;
}

function defaultLocale(): Locale {
  const v = import.meta.env.VITE_PAPERLENS_DEFAULT_LOCALE;
  const l = parseLocale(v);
  if (v && !l) console.warn(`VITE_PAPERLENS_DEFAULT_LOCALE=${v} is not a supported language (${LOCALES.map((x) => x.value).join(", ")}); using en`);
  return l ?? "en";
}

const WORKER_TAG = /~(zh|en)(?=@|$)/;

function inWorker(): boolean {
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== "undefined";
}

/** 本浏览器里已有 PaperLens 的记录（多语言之前就在用的使用者，那时界面是中文） */
function usedBeforeI18n(storage: Storage): boolean {
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k !== LOCALE_KEY && k.startsWith("paperlens")) return true;
  }
  return false;
}

function detectLocale(): Locale {
  if (inWorker()) {
    const m = WORKER_TAG.exec((globalThis as { name?: string }).name ?? "");
    if (m && isLocale(m[1])) return m[1];
    return DEFAULT_LOCALE;
  }
  // ?lang=：存不了 localStorage 时切换语言用它带过去，也便于分享指定语言的链接
  const url = globalThis.location ? new URL(globalThis.location.href) : null;
  const q = url?.searchParams.get("lang") ?? null;
  try {
    const storage = globalThis.localStorage;
    if (isLocale(q)) {
      storage.setItem(LOCALE_KEY, q);
      // 记住之后从地址里去掉：否则之后每次刷新这个标签页，都会覆盖在别的标签页里做的选择
      url!.searchParams.delete("lang");
      history.replaceState(history.state, "", url!.toString());
      return q;
    }
    const saved = storage.getItem(LOCALE_KEY);
    if (isLocale(saved)) return saved;
    // 第一次运行：把这次的语言记下来（之后写入的其他记录不再影响判断）。多语言之前就在用的保持中文，
    // 否则升级后界面突然变成英文，data/ 下的 Markdown 和画布文件也会整体用英文重写一遍
    const initial: Locale = usedBeforeI18n(storage) ? "zh" : DEFAULT_LOCALE;
    storage.setItem(LOCALE_KEY, initial);
    return initial;
  } catch {
    // 读写不了 localStorage（隐私模式等）
    return isLocale(q) ? q : DEFAULT_LOCALE;
  }
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
