import { beforeEach, describe, expect, it } from "vitest";
import { useReaderStore } from "@/app/stores/reader";

const s = () => useReaderStore.getState();

beforeEach(() => {
  useReaderStore.setState({ panes: [{ id: "left", tabs: [], activePaperId: null }], focusedPane: "left", jumpRequest: null });
});

describe("reader store", () => {
  it("openPaper 不重复添加标签，已打开时切过去", () => {
    s().openPaper("a");
    s().openPaper("b");
    s().openPaper("a");
    expect(s().panes[0].tabs).toEqual(["a", "b"]);
    expect(s().panes[0].activePaperId).toBe("a");
  });

  it("未分屏时指定右栏会建出右栏，focusedPane 始终指向存在的分栏", () => {
    s().openPaper("a", { paneId: "right" });
    expect(s().panes.map((p) => p.id)).toEqual(["left", "right"]);
    expect(s().panes[1].tabs).toEqual(["a"]);
    expect(s().focusedPane).toBe("right");
    s().openPaper("b");
    expect(s().panes[1].tabs).toEqual(["a", "b"]);
  });

  it("关闭当前标签后激活相邻标签", () => {
    ["a", "b", "c"].forEach((id) => s().openPaper(id));
    s().activateTab("left", "b");
    s().closeTab("left", "b");
    expect(s().panes[0].activePaperId).toBe("c");
    s().closeTab("left", "c");
    expect(s().panes[0].activePaperId).toBe("a");
  });

  it("jumpTo 在两栏都打开同一论文时，优先聚焦的分栏", () => {
    s().openPaper("a");
    s().toggleSplit();
    s().openPaper("a", { paneId: "right" });
    s().focusPane("right");
    s().jumpTo({ paperId: "a", page: 30 });
    expect(s().jumpRequest).toMatchObject({ paneId: "right", page: 30 });
    expect(s().focusedPane).toBe("right");
  });

  it("jumpTo 可显式指定分栏；未打开的论文在聚焦分栏打开", () => {
    s().openPaper("a");
    s().toggleSplit();
    s().jumpTo({ paperId: "b", page: 2, paneId: "left" });
    expect(s().panes[0].tabs).toContain("b");
    expect(s().jumpRequest?.paneId).toBe("left");
    s().focusPane("right");
    s().jumpTo({ paperId: "c", page: 1 });
    expect(s().panes[1].tabs).toEqual(["c"]);
  });

  it("关闭标签或合并分屏时清除未消费的跳转请求", () => {
    s().jumpTo({ paperId: "a", page: 37 });
    s().closeTab("left", "a");
    expect(s().jumpRequest).toBeNull();
    s().toggleSplit();
    s().jumpTo({ paperId: "b", page: 3, paneId: "right" });
    s().toggleSplit();
    expect(s().jumpRequest).toBeNull();
    expect(s().panes[0].tabs).toContain("b");
  });

  it("跳转请求的 seq 单调递增", () => {
    s().jumpTo({ paperId: "a", page: 1 });
    const first = s().jumpRequest!.seq;
    s().jumpTo({ paperId: "a", page: 2 });
    expect(s().jumpRequest!.seq).toBeGreaterThan(first);
  });
});
