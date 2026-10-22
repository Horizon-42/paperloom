// 术语前台模块的全局挂载点：术语弹窗、术语编辑器（都以 portal 渲染）
import { TermEditorDialog } from "./TermEditor";
import { TermPopover } from "./TermPopover";

export function TermHost() {
  return (
    <>
      <TermPopover />
      <TermEditorDialog />
    </>
  );
}
