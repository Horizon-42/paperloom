import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { PageLayerContext } from "@/components/viewer/overlays";
import type { TextRange } from "@/lib/textGeometry";

// 文字定位由阅读器模块负责，这里只验证接线：区间从哪来、何时用指针校正
const refine = vi.fn((_ctx: unknown, r: TextRange, _down: unknown, _up: unknown): TextRange => r);
vi.mock("@/lib/textGeometry", () => ({
  domRangeToTextRange: () => ({ start: 6, end: 11 }),
  textRangeToPdfRects: (_ctx: unknown, s: number, e: number) => [[s, 0, e, 10]],
  refineRangeByPointer: (ctx: unknown, r: TextRange, down: unknown, up: unknown) => refine(ctx, r, down, up),
}));

const { anchorFromSelection, dragGesture, DRAG_MIN_PX } = await import("@/components/annotation/selectionAnchor");
const { PageCtxRegistrar } = await import("@/components/annotation/pageRegistry");

const TEXT = "Hello world, glyph mapping";

function setup() {
  document.body.innerHTML = `<div data-viewer-pane="left" data-viewer-paper="p1">
    <div class="pl-page" data-page-number="2"><div class="textLayer"><span>${TEXT}</span></div></div>
  </div>`;
  const pageEl = document.querySelector<HTMLElement>(".pl-page")!;
  const layerEl = document.querySelector<HTMLElement>(".textLayer")!;
  const ctx = {
    paneId: "left",
    paperId: "p1",
    fileHash: "h1",
    pageNumber: 2,
    viewport: {},
    pageEl,
    text: { items: [], divs: [], layerEl, normalized: { text: TEXT }, charBoxes: null, scanned: false },
  } as unknown as PageLayerContext;
  render(<PageCtxRegistrar ctx={ctx} />, { container: document.createElement("div") });
  const node = layerEl.querySelector("span")!.firstChild!;
  const range = document.createRange();
  range.setStart(node, 6);
  range.setEnd(node, 11);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return { ctx, sel };
}

const sample = (x: number, y: number, extra: Partial<{ detail: number; shiftKey: boolean; pointerType: string; button: number }> = {}) => ({
  clientX: x,
  clientY: y,
  button: 0,
  detail: 1,
  shiftKey: false,
  pointerType: "mouse",
  ...extra,
});

beforeEach(() => refine.mockClear());
afterEach(() => cleanup());

describe("dragGesture", () => {
  it("accepts a plain mouse drag", () => {
    expect(dragGesture(sample(10, 10), sample(80, 12))).toEqual({ down: { clientX: 10, clientY: 10 }, up: { clientX: 80, clientY: 12 } });
  });
  it("rejects double/triple click selection, shift-extend, touch/pen, tiny moves and missing samples", () => {
    expect(dragGesture(sample(10, 10, { detail: 2 }), sample(80, 10))).toBeNull();
    expect(dragGesture(sample(10, 10, { detail: 3 }), sample(80, 10))).toBeNull();
    expect(dragGesture(sample(10, 10, { shiftKey: true }), sample(80, 10))).toBeNull();
    expect(dragGesture(sample(10, 10), sample(80, 10, { shiftKey: true }))).toBeNull();
    expect(dragGesture(sample(10, 10, { pointerType: "touch" }), sample(80, 10))).toBeNull();
    expect(dragGesture(sample(10, 10, { pointerType: "pen" }), sample(80, 10))).toBeNull();
    expect(dragGesture(sample(10, 10, { button: 2 }), sample(80, 10))).toBeNull();
    expect(dragGesture(sample(10, 10), sample(10 + DRAG_MIN_PX - 1, 10))).toBeNull();
    expect(dragGesture(null, sample(80, 10))).toBeNull();
    expect(dragGesture(sample(10, 10), null)).toBeNull();
  });
});

describe("anchorFromSelection + refineRangeByPointer", () => {
  it("uses the native range as is without a drag gesture (double click, keyboard)", () => {
    const { sel } = setup();
    const p = anchorFromSelection(sel, null)!;
    expect(refine).not.toHaveBeenCalled();
    expect(p.anchor).toMatchObject({ paperId: "p1", page: 2, fileHash: "h1", rects: [[6, 0, 11, 10]] });
    expect(p.anchor.quote.exact).toBe("world");
    expect(p.key).toBe("left|p1|2");
  });

  it("refines the range with the drag's pointer positions before computing rects and quote", () => {
    const { ctx, sel } = setup();
    refine.mockImplementationOnce((_c, r) => ({ start: r.start, end: r.end + 1 }));
    const gesture = { down: { clientX: 5, clientY: 6 }, up: { clientX: 90, clientY: 7 } };
    const p = anchorFromSelection(sel, gesture)!;
    expect(refine).toHaveBeenCalledWith(ctx, { start: 6, end: 11 }, gesture.down, gesture.up);
    expect(p.anchor.quote.exact).toBe("world,");
    expect(p.anchor.rects).toEqual([[6, 0, 12, 10]]);
  });

  it("ignores an empty refinement", () => {
    const { sel } = setup();
    refine.mockImplementationOnce(() => ({ start: 8, end: 8 }));
    const p = anchorFromSelection(sel, { down: { clientX: 0, clientY: 0 }, up: { clientX: 50, clientY: 0 } })!;
    expect(p.anchor.quote.exact).toBe("world");
  });

  it("returns null when the selection is not on a registered page", () => {
    setup();
    cleanup(); // 注销页面
    expect(anchorFromSelection(window.getSelection(), null)).toBeNull();
  });
});
