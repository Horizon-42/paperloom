// 术语模块共用的样式与小组件（沿用文库模块的按钮、输入框样式）
import type { SVGProps } from "react";
export { btn, btnDanger, btnGhost, btnOutline, btnPrimary, cx, dialogContent, dialogOverlay, dialogTitle, iconBtn, input, menuContent, menuItem } from "@/components/library/ui";
export { IconPlus, IconSearch, IconX } from "@/components/library/icons";

export const sectionTitle = "mb-1 text-[11px] font-medium tracking-wide text-neutral-400";
export const chip = "inline-flex max-w-full items-center gap-1 truncate rounded bg-neutral-100 px-1.5 py-px text-[12px] text-neutral-600";
export const linkBtn = "truncate text-left text-blue-700 hover:underline focus-visible:outline-2 focus-visible:outline-blue-500";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...p,
});

export const IconPencil = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
  </svg>
);
export const IconUp = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 15 6-6 6 6" />
  </svg>
);
export const IconDown = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const IconBack = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 6 9 12l6 6" />
  </svg>
);
/** 虚线下划线图标（工具栏开关） */
export const IconTermUnderline = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 5v6a5 5 0 0 0 10 0V5" />
    <path d="M4 20h2.5M9 20h2.5M14 20h2.5M19 20h1" />
  </svg>
);
