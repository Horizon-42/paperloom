// 预设高亮色。黄色与 termService.TERM_SOURCE_COLOR 相同，术语出处批注与普通高亮外观一致
import { t } from "@/i18n";

export interface HighlightColor {
  value: string;
  /** 界面上显示的颜色名（读取时取当前语言） */
  readonly label: string;
}

type ColorName = keyof typeof t.reader.colors;

const color = (value: string, name: ColorName): HighlightColor => ({
  value,
  get label() {
    return t.reader.colors[name];
  },
});

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  color("#fde68a", "yellow"),
  color("#bbf7d0", "green"),
  color("#bfdbfe", "blue"),
  color("#fbcfe8", "pink"),
  color("#ddd6fe", "purple"),
];

export const DEFAULT_COLOR = HIGHLIGHT_COLORS[0].value;

export function colorLabel(value: string): string {
  return HIGHLIGHT_COLORS.find((c) => c.value.toLowerCase() === value.toLowerCase())?.label ?? value;
}

/** 卡片色条、选中描边等需要更深的同色 */
export function strongColor(value: string, amount = 45): string {
  return `color-mix(in srgb, ${value}, #000 ${amount}%)`;
}
