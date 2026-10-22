// 文库模块共用的 Tailwind 类名
export const menuContent =
  "z-50 min-w-[168px] rounded-lg border border-neutral-200 bg-white p-1 text-[13px] text-neutral-700 shadow-lg shadow-neutral-900/10";
export const menuItem =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-neutral-100 data-[disabled]:pointer-events-none data-[disabled]:text-neutral-300";
export const menuItemDanger = `${menuItem} text-red-600 data-[highlighted]:bg-red-50`;
export const menuSeparator = "my-1 h-px bg-neutral-100";

export const dialogOverlay = "fixed inset-0 z-50 bg-neutral-900/25";
export const dialogContent =
  "fixed left-1/2 top-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-200 bg-white p-5 text-sm shadow-xl focus:outline-none";
export const dialogTitle = "text-base font-semibold text-neutral-900";

export const btn =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500 disabled:opacity-50";
export const btnPrimary = `${btn} bg-blue-600 text-white hover:bg-blue-700`;
export const btnDanger = `${btn} bg-red-600 text-white hover:bg-red-700`;
export const btnGhost = `${btn} text-neutral-600 hover:bg-neutral-100`;
export const btnOutline = `${btn} border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50`;

export const input =
  "h-8 w-full rounded-md border border-neutral-200 bg-white px-2.5 text-[13px] text-neutral-800 placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100";

export const iconBtn =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700";

/** 拼接类名，忽略假值 */
export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}
