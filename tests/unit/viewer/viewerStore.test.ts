import { beforeEach, describe, expect, it } from "vitest";
import { useViewerStore } from "@/app/stores/viewer";

const view = { zoomMode: "custom" as const, scale: 2, page: 3, pageFrac: 0.5 };

describe("viewer store", () => {
  beforeEach(() => useViewerStore.setState({ tabViews: {}, consumedJumpSeq: 0, splitRatio: 0.5 }));

  it("按分栏+论文保存，取不到时退回另一分栏", () => {
    const s = useViewerStore.getState();
    s.saveTabView("right", "p1", view);
    expect(s.getTabView("right", "p1")).toEqual(view);
    expect(s.getTabView("left", "p1")).toEqual(view);
    expect(s.getTabView("left", "p2")).toBeUndefined();
  });

  it("清理已关闭论文的状态", () => {
    const s = useViewerStore.getState();
    s.saveTabView("left", "p1", view);
    s.saveTabView("left", "p2", view);
    s.pruneTabViews(["p2"]);
    expect(Object.keys(useViewerStore.getState().tabViews)).toEqual(["left:p2"]);
  });

  it("跳转请求只消费一次", () => {
    const s = useViewerStore.getState();
    expect(s.consumeJump(1)).toBe(true);
    expect(s.consumeJump(1)).toBe(false);
    expect(s.consumeJump(2)).toBe(true);
  });

  it("分屏比例限制在 0.2–0.8", () => {
    useViewerStore.getState().setSplitRatio(0.05);
    expect(useViewerStore.getState().splitRatio).toBe(0.2);
  });
});
