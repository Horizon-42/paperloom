// @vitest-environment node
import { describe, expect, it } from "vitest";
import { holdTagName, isTagNameHeld } from "@/components/library/tagFilterHold";

describe("tag filter hold", () => {
  it("holds names case-insensitively, counts nested holds, release is idempotent", () => {
    expect(isTagNameHeld("待看")).toBe(false);
    const r1 = holdTagName("Deep");
    const r2 = holdTagName("deep");
    expect(isTagNameHeld("DEEP")).toBe(true);
    r1();
    r1();
    expect(isTagNameHeld("deep")).toBe(true);
    r2();
    expect(isTagNameHeld("deep")).toBe(false);
  });
});
