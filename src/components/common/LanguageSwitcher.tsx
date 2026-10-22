// 界面语言切换（侧栏顶部的 EN | CN 分段按钮）：当前语言高亮，点另一个就切换。
// 切换前先尽量把未保存的改动写进文件夹，再重新加载页面（见 docs/decisions.md D13）。
import { useEffect, useState } from "react";
import { LOCALES, LOCALE_KEY, htmlLang, isLocale, locale, messagesFor, setLocale, t, type Locale } from "@/i18n";
import { cx } from "@/components/library/ui";
import { flushStorage } from "@/services/storage/sync";

/** 先尽量保存（最多等 5 秒），再执行 */
async function afterFlush(fn: () => void): Promise<void> {
  await Promise.race([flushStorage().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  fn();
}

function switchLocale(next: Locale): void {
  if (next !== locale) void afterFlush(() => setLocale(next));
}

export function LanguageSwitcher() {
  return (
    <div
      role="group"
      aria-label={t.common.language.label}
      title={t.common.language.switchTitle}
      className="flex h-7 shrink-0 items-center gap-px rounded-md bg-neutral-200/70 p-0.5"
      data-testid="language-switcher"
    >
      {LOCALES.map((l) => {
        const active = l.value === locale;
        return (
          <button
            key={l.value}
            type="button"
            lang={l.htmlLang}
            aria-label={l.label}
            aria-pressed={active}
            title={l.label}
            data-locale={l.value}
            onClick={() => switchLocale(l.value)}
            className={cx(
              "h-6 rounded px-1.5 text-[11px] font-semibold tracking-wide transition-colors",
              active ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800",
            )}
          >
            {l.short}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 其他标签页改了界面语言：本标签页不会自动重新加载（可能有正在输入的内容），标签页之间同步的状态文字也会混用两种语言，
 * 所以用新语言提示重新加载
 */
export function LanguageChangedNotice() {
  const [next, setNext] = useState<Locale | null>(null);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOCALE_KEY) setNext(isLocale(e.newValue) && e.newValue !== locale ? e.newValue : null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  if (!next) return null;
  const m = messagesFor(next).common.language;
  return (
    <div
      role="status"
      lang={htmlLang(next)}
      className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900"
      data-testid="language-changed"
    >
      <span className="min-w-0 flex-1">{m.changedElsewhere}</span>
      <button
        type="button"
        onClick={() => void afterFlush(() => location.reload())}
        className="shrink-0 rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-700"
      >
        {m.reload}
      </button>
    </div>
  );
}
