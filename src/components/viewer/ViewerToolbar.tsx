import { useEffect, useState, type ReactNode } from "react";
import type { PaneId } from "@/app/stores/reader";
import type { ZoomMode } from "./layout";
import { PaperTagsControl } from "@/components/library/PaperTagsControl";
import { TermDisplayMenu } from "@/components/term/TermDisplayMenu";

interface Props {
  paneId: PaneId;
  paperId: string;
  currentPage: number;
  pageCount: number;
  /** 当前缩放（1 = 100%），未就绪时为 0 */
  zoom: number;
  zoomMode: ZoomMode;
  onPage: (page: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
}

export function ViewerToolbar({ paneId, paperId, currentPage, pageCount, zoom, zoomMode, onPage, onZoomIn, onZoomOut, onFitWidth }: Props) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-neutral-200 bg-white px-2 text-xs text-neutral-600 select-none">
      <PageInput current={currentPage} count={pageCount} onCommit={onPage} />
      <div className="mx-2 h-4 w-px bg-neutral-200" />
      <ToolButton label="缩小（Ctrl/⌘ -）" onClick={onZoomOut} disabled={!zoom}>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 8h10" />
        </svg>
      </ToolButton>
      <span className="w-12 text-center tabular-nums" data-zoom-label aria-label="缩放比例">
        {zoom ? `${Math.round(zoom * 100)}%` : "—"}
      </span>
      <ToolButton label="放大（Ctrl/⌘ +）" onClick={onZoomIn} disabled={!zoom}>
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 8h10M8 3v10" />
        </svg>
      </ToolButton>
      <button
        type="button"
        onClick={onFitWidth}
        disabled={!zoom}
        aria-pressed={zoomMode === "page-width"}
        className={`ml-1 rounded px-2 py-1 hover:bg-neutral-100 disabled:opacity-40 ${
          zoomMode === "page-width" ? "bg-neutral-100 text-neutral-900" : ""
        }`}
      >
        适合宽度
      </button>
      {/* 靠右：这篇论文的标签、术语下划线开关 */}
      <div className="ml-auto flex min-w-0 items-center gap-1">
        <PaperTagsControl paneId={paneId} paperId={paperId} />
        <div className="mx-1 h-4 w-px shrink-0 bg-neutral-200" />
        <TermDisplayMenu />
      </div>
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-100 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function PageInput({ current, count, onCommit }: { current: number; count: number; onCommit: (page: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [current]);
  const commit = () => {
    if (draft === null) return;
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && count) onCommit(Math.min(Math.max(1, n), count));
    setDraft(null);
  };
  return (
    <label className="flex items-center gap-1">
      <input
        aria-label="页码"
        className="h-6 w-10 rounded border border-neutral-200 px-1 text-center tabular-nums outline-none focus:border-blue-400"
        value={draft ?? (count ? String(current) : "")}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onFocus={(e) => e.target.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="tabular-nums" data-page-count>
        / {count || "—"}
      </span>
    </label>
  );
}
