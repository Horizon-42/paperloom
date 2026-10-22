// 阅读器工具栏上的术语下划线开关（开发文档第 8 节"术语过多导致页面满是下划线"）：
// 每页每个术语只标第一次、一键隐藏全部下划线。设置存在 db.kv，对所有分栏生效。
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { setTermDisplaySettings } from "@/services/termService";
import { useTermRuntime } from "./runtime";
import { IconTermUnderline, cx, menuContent, menuItem } from "./ui";

export function TermDisplayMenu() {
  const { display } = useTermRuntime();
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className={cx(
          "ml-auto flex h-6 items-center gap-1 rounded px-1.5 hover:bg-neutral-100 data-[state=open]:bg-neutral-100",
          display.hidden && "text-neutral-400",
        )}
        title="术语下划线"
        aria-label="术语下划线"
        data-term-display-menu
      >
        <IconTermUnderline />
        <span>{display.hidden ? "术语已隐藏" : display.firstOnly ? "术语：仅首次" : "术语"}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={menuContent}>
          <DropdownMenu.CheckboxItem
            className={menuItem}
            checked={display.firstOnly}
            disabled={display.hidden}
            onCheckedChange={(v) => void setTermDisplaySettings({ firstOnly: v === true })}
            onSelect={(e) => e.preventDefault()}
            data-term-first-only
          >
            <Check on={display.firstOnly} />
            每页每个术语只标第一次
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            className={menuItem}
            checked={display.hidden}
            onCheckedChange={(v) => void setTermDisplaySettings({ hidden: v === true })}
            onSelect={(e) => e.preventDefault()}
            data-term-hide-all
          >
            <Check on={display.hidden} />
            隐藏全部术语下划线
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span className={cx("flex h-3.5 w-3.5 items-center justify-center rounded-sm border", on ? "border-blue-600 bg-blue-600 text-white" : "border-neutral-300")}>
      {on && (
        <svg viewBox="0 0 12 12" width={10} height={10} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path d="m2.5 6 2.5 2.5 4.5-5" />
        </svg>
      )}
    </span>
  );
}
