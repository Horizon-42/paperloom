// 界面语言切换（侧栏顶部的地球按钮）：选择后先尽量把未保存的改动写进文件夹，再重新加载页面（见 docs/decisions.md D13）。
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LOCALES, locale, setLocale, t, type Locale } from "@/i18n";
import { cx, iconBtn, menuContent, menuItem } from "@/components/library/ui";
import { flushStorage } from "@/services/storage/sync";

async function switchLocale(next: Locale): Promise<void> {
  if (next === locale) return;
  await Promise.race([flushStorage().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  setLocale(next);
}

export function LanguageSwitcher() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={cx(iconBtn, "h-7 w-7 shrink-0")} title={t.common.language.switchTitle} aria-label={t.common.language.label} data-testid="language-switcher">
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={cx(menuContent, "w-[140px]")} data-testid="language-menu">
          <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] text-neutral-400">{t.common.language.label}</DropdownMenu.Label>
          {LOCALES.map((l) => (
            <DropdownMenu.Item key={l.value} className={menuItem} lang={l.htmlLang} data-locale={l.value} onSelect={() => void switchLocale(l.value)}>
              <span className="flex-1">{l.label}</span>
              {l.value === locale && <span aria-hidden className="text-blue-600">✓</span>}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
