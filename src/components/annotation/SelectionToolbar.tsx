// 选区工具栏：在文本层选中文字后浮在选区旁边。
// 5 种高亮色（点击即保存）、写笔记（保存并打开角注卡片编辑）、设为术语（交给术语编辑器，同时保存出处批注）。
// 选区跨页时只取起点所在页的部分。Esc 或点击别处隐藏。保存失败时保留选区和工具栏，并提示错误。
import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnnotationStore } from "@/app/stores/annotation";
import { useTermUiStore } from "@/app/stores/termUi";
import { normalizeString } from "@/engine/normalize";
import { pdfRectToScreen } from "@/lib/coords";
import { createAnnotation } from "@/services/annotationService";
import { reportError } from "./actions";
import { DEFAULT_COLOR, HIGHLIGHT_COLORS, strongColor } from "./colors";
import { IconPen, IconTagSmall } from "./icons";
import { getPageCtx } from "./pageRegistry";
import { anchorFromSelection, dragGesture, type PendingSelection, type PointerSample } from "./selectionAnchor";

const TOOLBAR_H = 34;

export function SelectionToolbar() {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [, reposition] = useReducer((x: number) => x + 1, 0);
  const ref = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => {
    let timer = 0;
    // 最近一次鼠标按下/抬起：拖选时用来校正选区端点
    let pointerType = "mouse";
    let down: PointerSample | null = null;
    const sample = (e: MouseEvent): PointerSample => ({
      clientX: e.clientX,
      clientY: e.clientY,
      button: e.button,
      detail: e.detail,
      shiftKey: e.shiftKey,
      pointerType,
    });
    const check = (up: PointerSample | null) => {
      window.clearTimeout(timer);
      const gesture = dragGesture(down, up);
      // 等浏览器更新完选区（mouseup 之后、双击选词之后）
      timer = window.setTimeout(() => setPending(anchorFromSelection(window.getSelection(), gesture)), 0);
    };
    const inToolbar = (t: EventTarget | null) => !!t && !!ref.current?.contains(t as Node);
    const onPointerDown = (e: PointerEvent) => {
      pointerType = e.pointerType || "mouse";
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0 || inToolbar(e.target)) return;
      check(sample(e));
    };
    const onDown = (e: MouseEvent) => {
      if (inToolbar(e.target)) return;
      down = sample(e);
      if (pendingRef.current) setPending(null);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey && /^Arrow|^Home$|^End$/.test(e.key)) {
        down = null; // 键盘调整选区：不用指针校正
        check(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !pendingRef.current) return;
      setPending(null);
      window.getSelection()?.removeAllRanges();
    };
    const onSelChange = () => {
      // 选区被清空（点击别处、程序清除）时隐藏
      if (pendingRef.current && window.getSelection()?.isCollapsed) setPending(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("selectionchange", onSelChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, []);

  // 滚动、缩放、窗口尺寸变化时跟随选区
  useEffect(() => {
    if (!pending) return;
    const onMove = () => reposition();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [pending]);

  if (!pending) return null;
  const ctx = getPageCtx(pending.key);
  if (!ctx || !ctx.pageEl.isConnected) return null;
  const pr = ctx.pageEl.getBoundingClientRect();
  const firstR = pdfRectToScreen(ctx.viewport, pending.anchor.rects[0]);
  const lastR = pdfRectToScreen(ctx.viewport, pending.anchor.rects[pending.anchor.rects.length - 1]);
  let top = pr.top + firstR.top - TOOLBAR_H - 6;
  if (top < 4) top = pr.top + lastR.top + lastR.height + 6;
  const left = Math.max(4, Math.min(window.innerWidth - 300, pr.left + firstR.left));

  const done = () => {
    setPending(null);
    window.getSelection()?.removeAllRanges();
  };
  const st = useAnnotationStore.getState;
  const { anchor, paneId } = pending;

  // 先写库，成功后再清除选区；失败时保留选区和工具栏，提示错误
  const run = async (fn: () => Promise<void>, what: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      reportError(what)(e);
    } finally {
      setBusy(false);
    }
  };
  const highlight = (color: string) =>
    run(async () => {
      await createAnnotation(anchor, { color });
      st().setLastColor(color);
      done();
    }, "保存高亮失败");
  const writeNote = () =>
    run(async () => {
      const a = await createAnnotation(anchor, { color: st().lastColor ?? DEFAULT_COLOR });
      done();
      st().edit({ paneId, paperId: a.paperId, id: a.id });
    }, "保存高亮失败");
  const makeTerm = () => {
    done();
    useTermUiStore.getState().openTermEditor({ initialName: normalizeString(anchor.quote.exact), source: anchor });
  };

  return createPortal(
    <div
      ref={ref}
      role="toolbar"
      aria-label="选区工具栏"
      data-annotation-toolbar
      aria-busy={busy || undefined}
      className="fixed z-50 flex items-center gap-0.5 rounded-lg border border-neutral-200 bg-white px-1 shadow-lg shadow-neutral-900/10"
      style={{ top, left, height: TOOLBAR_H }}
      // 保持文本选区，不让按钮抢走焦点
      onMouseDown={(e) => e.preventDefault()}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-neutral-100"
          aria-label={`${c.label}高亮`}
          title={`${c.label}高亮`}
          data-color={c.value}
          onClick={() => void highlight(c.value)}
        >
          <span className="h-4 w-4 rounded-full border" style={{ background: c.value, borderColor: strongColor(c.value, 25) }} />
        </button>
      ))}
      <span className="mx-1 h-4 w-px bg-neutral-200" />
      <button
        type="button"
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-neutral-700 hover:bg-neutral-100"
        onClick={() => void writeNote()}
        data-action="note"
      >
        <IconPen /> 写笔记
      </button>
      <button
        type="button"
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-neutral-700 hover:bg-neutral-100"
        onClick={makeTerm}
        data-action="term"
      >
        <IconTagSmall /> 设为术语
      </button>
    </div>,
    document.body,
  );
}
