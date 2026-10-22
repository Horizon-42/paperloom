// 关系选择浮层：新建连线时选择关系类型，点击已有连线时修改或删除（删除是全局的，要二次确认）。
import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { t } from "@/i18n";
import { Trans } from "@/i18n/Trans";
import { RELATIONS } from "@/services/linkService";
import type { LinkRelation } from "@/types/models";
import { RELATION_STYLE } from "./model";
import { btnDanger, btnGhost, btnPrimary, cx, input } from "./ui";

export interface RelationPickerProps {
  /** 浮层锚点（client 坐标） */
  anchor: { x: number; y: number };
  mode: "create" | "edit";
  initial: { relation: LinkRelation; label?: string };
  /** 两端的标题，显示在顶部 */
  endpoints?: { from: string; to: string };
  /** reverse：编辑时选择了调换方向 */
  onSubmit: (relation: LinkRelation, label: string, reverse: boolean) => void;
  onDelete?: () => void;
  onClose: () => void;
}

function Swatch({ relation }: { relation: LinkRelation }) {
  const s = RELATION_STYLE[relation];
  return (
    <svg width="18" height="8" aria-hidden className="shrink-0">
      <line x1="1" y1="4" x2="17" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} />
    </svg>
  );
}

export function RelationPicker({ anchor, mode, initial, endpoints, onSubmit, onDelete, onClose }: RelationPickerProps) {
  const [relation, setRelation] = useState<LinkRelation>(initial.relation);
  const [label, setLabel] = useState(initial.label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reverse, setReverse] = useState(false);
  const ends = endpoints && reverse ? { from: endpoints.to, to: endpoints.from } : endpoints;

  const submit = () => {
    if (relation === "custom" && !label.trim()) {
      setError(t.canvas.picker.customNeedsText);
      return;
    }
    onSubmit(relation, label.trim(), reverse);
  };

  return (
    <Popover.Root open onOpenChange={(o) => !o && onClose()}>
      <Popover.Anchor asChild>
        <div style={{ position: "fixed", left: anchor.x, top: anchor.y, width: 1, height: 1, pointerEvents: "none" }} />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={6}
          collisionPadding={12}
          className="nokey z-50 w-[340px] rounded-lg border border-neutral-200 bg-white p-3 text-[13px] shadow-xl"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
              e.preventDefault();
              if (!confirmDelete) submit();
            }
          }}
          data-relation-picker={mode}
        >
          {confirmDelete ? (
            <div data-confirm-delete-link>
              <div className="mb-1 font-medium text-neutral-900">{t.canvas.picker.deleteTitle}</div>
              <p className="mb-3 text-[12.5px] leading-relaxed text-neutral-500">
                <Trans
                  text={t.canvas.picker.deleteBody}
                  values={{
                    all: <strong className="font-medium text-neutral-700">{t.canvas.picker.allBoards}</strong>,
                    related: <strong className="font-medium text-neutral-700">{t.canvas.picker.relatedNotes}</strong>,
                  }}
                />
              </p>
              <div className="flex justify-end gap-1.5">
                <button type="button" className={cx(btnGhost, "h-7 px-2.5 text-[12.5px]")} onClick={() => setConfirmDelete(false)}>
                  {t.common.cancel}
                </button>
                <button type="button" className={cx(btnDanger, "h-7 px-2.5 text-[12.5px]")} onClick={() => onDelete?.()} autoFocus>
                  {t.canvas.picker.deleteConfirm}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-2 font-medium text-neutral-900">{mode === "create" ? t.canvas.picker.create : t.canvas.picker.edit}</div>
              {ends && (
                <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-neutral-500" data-link-ends>
                  <span className="min-w-0 flex-1 truncate" title={ends.from}>
                    {ends.from}
                  </span>
                  {mode === "edit" ? (
                    <button
                      type="button"
                      className={cx("shrink-0 rounded px-1 hover:bg-neutral-100", reverse && "bg-blue-50 text-blue-700")}
                      title={t.canvas.picker.reverse}
                      aria-label={t.canvas.picker.reverse}
                      aria-pressed={reverse}
                      onClick={() => setReverse((r) => !r)}
                    >
                      ⇄
                    </button>
                  ) : (
                    <span className="shrink-0">→</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-right" title={ends.to}>
                    {ends.to}
                  </span>
                </div>
              )}
              <div className="mb-2 grid grid-cols-3 gap-1" role="radiogroup" aria-label={t.canvas.picker.relationGroup}>
                {RELATIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={relation === r}
                    className={cx(
                      "flex items-center gap-1 rounded-md border px-1.5 py-1 text-[12px]",
                      relation === r ? "border-blue-300 bg-blue-50 text-blue-800" : "border-neutral-200 text-neutral-600 hover:bg-neutral-50",
                    )}
                    onClick={() => {
                      setRelation(r);
                      setError(null);
                    }}
                  >
                    <Swatch relation={r} />
                    <span className="min-w-0 truncate">{t.canvas.relations[r]}</span>
                  </button>
                ))}
              </div>
              <input
                className={cx(input, "h-7 text-[12.5px]")}
                placeholder={relation === "custom" ? t.canvas.picker.customPlaceholder : t.canvas.picker.notePlaceholder}
                value={label}
                autoFocus={mode === "create"}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setError(null);
                }}
                aria-label={t.canvas.picker.labelAria}
                data-relation-label
              />
              {error && <div className="mt-1 text-[11.5px] text-red-600">{error}</div>}
              <div className="mt-3 flex items-center gap-1.5">
                {mode === "edit" && onDelete && (
                  <button type="button" className={cx(btnGhost, "h-7 px-2 text-[12.5px] text-red-600 hover:bg-red-50")} onClick={() => setConfirmDelete(true)}>
                    {t.canvas.picker.deleteButton}
                  </button>
                )}
                <span className="flex-1" />
                <button type="button" className={cx(btnGhost, "h-7 px-2.5 text-[12.5px]")} onClick={onClose}>
                  {t.common.cancel}
                </button>
                <button type="button" className={cx(btnPrimary, "h-7 px-3 text-[12.5px]")} onClick={submit}>
                  {mode === "create" ? t.canvas.picker.submitCreate : t.common.save}
                </button>
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
