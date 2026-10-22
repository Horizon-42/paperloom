// 画布的对话框：新建/重命名画布、删除画布、通用确认
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAnnotationStore } from "@/app/stores/annotation";
import { reportError } from "@/components/annotation/actions";
import { deleteBoard, planBoardDeletion, type BoardDeletionPlan } from "@/services/canvasService";
import { forgetViewport } from "./viewportMemory";
import { btnDanger, btnGhost, btnPrimary, cx, dialogContent, dialogOverlay, dialogTitle, input, IconX } from "./ui";

function Shell(props: { title: string; description?: ReactNode; onClose: () => void; children: ReactNode; testId?: string }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={cx(dialogContent, "nokey")} data-canvas-dialog={props.testId}>
          <div className="mb-3 flex items-start gap-3">
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>{props.title}</Dialog.Title>
            <Dialog.Close className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label="关闭">
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

/** 新建 / 重命名画布 */
export function BoardNameDialog(props: { title: string; initial: string; confirmText: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    try {
      await props.onSubmit(name);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <Shell title={props.title} onClose={props.onClose} testId="board-name">
      <form onSubmit={(e) => void submit(e)}>
        <input
          className={input}
          value={name}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="画布名称，例如：方法对比"
          aria-label="画布名称"
        />
        {error && <div className="mt-1 text-[12px] text-red-600">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={props.onClose}>
            取消
          </button>
          <button type="submit" className={btnPrimary}>
            {props.confirmText}
          </button>
        </div>
      </form>
    </Shell>
  );
}

/** 删除画布：只删节点；只在这块画布上、没有连线的自由笔记可选择一并删除或放回"未整理" */
export function DeleteBoardDialog({ boardId, onClose, onDeleted }: { boardId: string; onClose: () => void; onDeleted?: () => void }) {
  const [plan, setPlan] = useState<BoardDeletionPlan | null | undefined>(undefined);
  const [deleteNotes, setDeleteNotes] = useState(false);
  useEffect(() => {
    let alive = true;
    planBoardDeletion(boardId).then((p) => alive && setPlan(p), reportError("读取画布失败"));
    return () => {
      alive = false;
    };
  }, [boardId]);
  useEffect(() => {
    if (plan === null) onClose();
  }, [plan, onClose]);
  if (!plan) return null;
  const orphans = plan.orphanNoteIds.length;
  const confirm = async () => {
    try {
      const r = await deleteBoard(boardId, { deleteOrphanNotes: deleteNotes });
      forgetViewport(boardId);
      onClose();
      onDeleted?.();
      useAnnotationStore
        .getState()
        .showToast(r.deletedNotes ? `已删除画布「${plan.board.name}」和 ${r.deletedNotes} 条笔记` : `已删除画布「${plan.board.name}」`);
    } catch (e) {
      reportError("删除画布失败")(e);
    }
  };
  return (
    <Shell
      title={`删除画布「${plan.board.name}」？`}
      onClose={onClose}
      testId="delete-board"
      description={
        <>
          画布上的 {plan.nodeCount} 个节点会被移除。批注、术语、论文和连线都不受影响，连线仍会显示在其他画布和「相关笔记」里。
        </>
      }
    >
      {orphans > 0 && (
        <fieldset className="mt-3 space-y-1.5 rounded-md border border-neutral-200 p-3 text-[13px]" data-orphan-notes={orphans}>
          <legend className="px-1 text-[12px] text-neutral-500">有 {orphans} 条自由笔记只在这块画布上，且没有连线</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="orphans" checked={!deleteNotes} onChange={() => setDeleteNotes(false)} />
            保留，放回「未整理」
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="orphans" checked={deleteNotes} onChange={() => setDeleteNotes(true)} />
            一并删除这些笔记
          </label>
        </fieldset>
      )}
      <p className="mt-3 text-[12px] text-neutral-400">此操作无法撤销。</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={onClose}>
          取消
        </button>
        <button type="button" className={btnDanger} onClick={() => void confirm()}>
          删除画布
        </button>
      </div>
    </Shell>
  );
}

/** 通用确认框 */
export function ConfirmDialog(props: {
  title: string;
  body: ReactNode;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  testId?: string;
}) {
  return (
    <Shell title={props.title} description={props.body} onClose={props.onClose} testId={props.testId}>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={props.onClose}>
          取消
        </button>
        <button
          type="button"
          className={props.danger ? btnDanger : btnPrimary}
          autoFocus
          onClick={() => {
            props.onConfirm();
            props.onClose();
          }}
        >
          {props.confirmText}
        </button>
      </div>
    </Shell>
  );
}
