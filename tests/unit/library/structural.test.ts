import { describe, expect, it } from "vitest";
import { sameRecord, shareById } from "@/components/library/structural";

describe("structural sharing", () => {
  it("compares records shallowly, arrays element-wise", () => {
    expect(sameRecord({ a: 1, xs: ["x", "y"] }, { a: 1, xs: ["x", "y"] })).toBe(true);
    expect(sameRecord({ a: 1, xs: ["x"] }, { a: 1, xs: ["x", "y"] })).toBe(false);
    expect(sameRecord({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameRecord({ a: 1, o: {} }, { a: 1, o: {} })).toBe(false); // 只比较一层
  });

  it("reuses unchanged objects by id and the whole result when nothing changed", () => {
    const first = shareById(null, [
      { id: "a", t: "A", tags: ["x"] },
      { id: "b", t: "B", tags: [] },
    ]);
    const same = shareById(first, [
      { id: "a", t: "A", tags: ["x"] },
      { id: "b", t: "B", tags: [] },
    ]);
    expect(same).toBe(first);

    const changed = shareById(first, [
      { id: "a", t: "A", tags: ["x"] },
      { id: "b", t: "B2", tags: [] },
    ]);
    expect(changed).not.toBe(first);
    expect(changed.list[0]).toBe(first.list[0]);
    expect(changed.list[1]).not.toBe(first.list[1]);
    expect(changed.byId.get("b")!.t).toBe("B2");

    const reordered = shareById(changed, [changed.list[1], changed.list[0]].map((x) => ({ ...x })));
    expect(reordered).not.toBe(changed);
    expect(reordered.list[0]).toBe(changed.list[1]);

    const removed = shareById(reordered, [{ ...reordered.list[0] }]);
    expect(removed.list).toHaveLength(1);
    expect(removed.byId.has("a")).toBe(false);
  });
});
