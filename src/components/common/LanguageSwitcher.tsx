// 界面语言切换（侧栏顶部的 EN | CN 分段按钮）：当前语言高亮，点另一个就切换。
// 切换前先尽量把未保存的改动写进文件夹，再重新加载页面（见 docs/decisions.md D13）。
import { LOCALES, locale, setLocale, t, type Locale } from "@/i18n";
import { cx } from "@/components/library/ui";
import { flushStorage } from "@/services/storage/sync";

async function switchLocale(next: Locale): Promise<void> {
  if (next === locale) return;
  await Promise.race([flushStorage().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  setLocale(next);
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
            onClick={() => void switchLocale(l.value)}
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
