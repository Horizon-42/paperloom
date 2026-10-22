import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetViewport, initialViewport, loadViewport, saveViewport } from "@/components/canvas/viewportMemory";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("视口记忆（localStorage）", () => {
  it("按画布保存、读取、删除；非法值忽略", () => {
    saveViewport("b1", { x: 10, y: -5, zoom: 0.8 });
    saveViewport("b2", { x: NaN, y: 0, zoom: 1 });
    saveViewport("b3", { x: 0, y: 0, zoom: 0 });
    expect(loadViewport("b1")).toEqual({ x: 10, y: -5, zoom: 0.8 });
    expect(loadViewport("b2")).toBeNull();
    expect(loadViewport("b3")).toBeNull();
    localStorage.setItem("paperlens.canvas.viewport.bad", "{not json");
    expect(loadViewport("bad")).toBeNull();
    forgetViewport("b1");
    expect(loadViewport("b1")).toBeNull();
  });

  it("打开时：本浏览器记住的优先，其次旧数据里的 Board.viewport，都没有返回 null", () => {
    expect(initialViewport({ id: "b", viewport: { x: 1, y: 2, zoom: 1.5 } })).toEqual({ x: 1, y: 2, zoom: 1.5 });
    saveViewport("b", { x: 3, y: 4, zoom: 0.5 });
    expect(initialViewport({ id: "b", viewport: { x: 1, y: 2, zoom: 1.5 } })).toEqual({ x: 3, y: 4, zoom: 0.5 });
    expect(initialViewport({ id: "c" })).toBeNull();
  });

  it("localStorage 不可用时不抛错", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveViewport("b", { x: 0, y: 0, zoom: 1 })).not.toThrow();
    expect(loadViewport("b")).toBeNull();
    expect(() => forgetViewport("b")).not.toThrow();
  });
});
