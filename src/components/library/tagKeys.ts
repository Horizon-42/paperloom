// 标签相关的键盘判断：快捷键 T、输入法组字、焦点是否在可输入的地方、是否有其他弹层开着。
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type AnyKeyEvent = KeyboardEvent | ReactKeyboardEvent;

const native = (e: AnyKeyEvent): KeyboardEvent => ("nativeEvent" in e ? e.nativeEvent : e);

/** 输入法正在组字：此时的回车、逗号等是输入法自己的操作，不能当作提交（Safari 组字结束的回车 keyCode 也是 229） */
export function isComposingKey(e: AnyKeyEvent): boolean {
  const n = native(e);
  return n.isComposing || n.keyCode === 229;
}

/** 打开标签编辑的快捷键：单独按 T（不带修饰键，不在组字） */
export function isTagShortcut(e: AnyKeyEvent): boolean {
  return (e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !isComposingKey(e);
}

/** 焦点在输入框、文本域、可编辑区域或 CodeMirror 里 */
export function isTextEntry(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest(".cm-editor");
}

/** 有对话框、菜单或浮层开着（Radix 的 Dialog / Popover 内容是 role="dialog"，菜单是 role="menu"；不含悬停提示） */
export function hasOpenLayer(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');
}
