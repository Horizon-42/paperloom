// 画布模块的样式与图标（按钮、输入框沿用文库模块）
import type { SVGProps } from "react";

export {
  btnDanger,
  btnGhost,
  btnPrimary,
  cx,
  dialogContent,
  dialogOverlay,
  dialogTitle,
  input,
  menuContent,
  menuItem,
  menuItemDanger,
  menuSeparator,
} from "@/components/library/ui";
export { IconCanvas, IconCheck, IconChevronDown, IconInbox, IconMore, IconPlus, IconSearch, IconX } from "@/components/library/icons";
export { IconPen, IconTrash } from "@/components/annotation/icons";

/** 节点标题栏里的小按钮 */
export const nodeBtn =
  "nodrag nopan inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700";

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

/** 跳到原文 */
export const IconJump = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);
/** 连线 */
export const IconLink = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M8 8l8 8" />
  </svg>
);
export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);
/** 新建笔记 */
export const IconNotePlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
    <path d="M14 3v5h5M12 11v6M9 14h6" />
  </svg>
);
export const IconFolder = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </svg>
);
export const IconFit = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
  </svg>
);
