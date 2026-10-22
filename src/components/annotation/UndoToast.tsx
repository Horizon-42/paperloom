// 底部提示条："已删除批注 · 撤销"、保存失败等。可同时显示多条，各自计时、各自撤销
import { useEffect } from "react";
import { useAnnotationStore, type AnnotationToast } from "@/app/stores/annotation";
import { t } from "@/i18n";

const TOAST_MS = 6000;
const ERROR_MS = 8000;

export function UndoToast() {
  const toasts = useAnnotationStore((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.seq} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: AnnotationToast }) {
  const dismiss = useAnnotationStore((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.seq), toast.kind === "error" ? ERROR_MS : TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className={`pointer-events-auto flex items-center gap-3 rounded-lg px-4 py-2 text-[13px] text-white shadow-lg ${
        toast.kind === "error" ? "bg-red-700" : "bg-neutral-800"
      }`}
      data-annotation-toast={toast.kind}
    >
      <span>{toast.message}</span>
      {toast.undo && (
        <button
          type="button"
          className="font-medium text-blue-300 hover:text-blue-200"
          onClick={() => {
            const undo = toast.undo!;
            dismiss(toast.seq);
            void Promise.resolve()
              .then(undo)
              .catch((e: unknown) => {
                console.error("Undo failed", e);
                useAnnotationStore.getState().showToast(t.reader.toast.undoFailed, { kind: "error" });
              });
          }}
        >
          {t.common.undo}
        </button>
      )}
      {toast.kind === "error" && (
        <button type="button" className="text-white/70 hover:text-white" aria-label={t.reader.toast.dismiss} onClick={() => dismiss(toast.seq)}>
          ×
        </button>
      )}
    </div>
  );
}
