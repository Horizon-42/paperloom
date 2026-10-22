// 侧栏对话框的外壳：标题、关闭按钮、说明文字
import { t } from "@/i18n";
import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { IconX } from "./icons";
import { cx, dialogContent, dialogOverlay, dialogTitle } from "./ui";

export interface ShellProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Esc 时先调用；调用 preventDefault 则不关闭对话框 */
  onEscapeKeyDown?: (e: KeyboardEvent) => void;
}

export function Shell(props: ShellProps) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content
          className={cx(dialogContent, props.wide && "w-[min(92vw,520px)]")}
          onEscapeKeyDown={(e) => {
            // 标签输入框的建议列表开着：Esc 先收起列表
            if ((document.activeElement as HTMLElement | null)?.hasAttribute("data-tag-input-open")) e.preventDefault();
            else props.onEscapeKeyDown?.(e);
          }}
        >
          <div className="mb-3 flex items-start gap-3">
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>{props.title}</Dialog.Title>
            <Dialog.Close className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label={t.common.close}>
              <IconX width={16} height={16} />
            </Dialog.Close>
          </div>
          {props.description ? (
            <Dialog.Description asChild>
              <div className="text-[13px] leading-relaxed text-neutral-600">{props.description}</div>
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{props.title}</Dialog.Description>
          )}
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
