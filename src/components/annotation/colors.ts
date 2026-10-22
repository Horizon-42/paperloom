// 预设高亮色。黄色与 termService.TERM_SOURCE_COLOR 相同，术语出处批注与普通高亮外观一致
export interface HighlightColor {
  value: string;
  label: string;
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { value: "#fde68a", label: "黄色" },
  { value: "#bbf7d0", label: "绿色" },
  { value: "#bfdbfe", label: "蓝色" },
  { value: "#fbcfe8", label: "粉色" },
  { value: "#ddd6fe", label: "紫色" },
];

export const DEFAULT_COLOR = HIGHLIGHT_COLORS[0].value;

export function colorLabel(value: string): string {
  return HIGHLIGHT_COLORS.find((c) => c.value.toLowerCase() === value.toLowerCase())?.label ?? value;
}

/** 卡片色条、选中描边等需要更深的同色 */
export function strongColor(value: string, amount = 45): string {
  return `color-mix(in srgb, ${value}, #000 ${amount}%)`;
}
