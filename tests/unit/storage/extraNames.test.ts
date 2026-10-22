import { describe, expect, it } from "vitest";
import { prepareExtraFiles } from "@/services/storage/extraNames";

describe("prepareExtraFiles", () => {
  it("过长的文件名截短并保留扩展名，结尾的点和空格去掉，重名加序号", () => {
    const warns: string[] = [];
    const out = prepareExtraFiles(
      "canvas",
      [
        { name: `${"画".repeat(100)}.canvas`, content: "a" },
        { name: "对比 .", content: "b" },
        { name: "Board.canvas", content: "c" },
        { name: "board.canvas", content: "d" },
      ],
      (m) => warns.push(m),
    );
    expect(new TextEncoder().encode(out[0].name).length).toBeLessThanOrEqual(200);
    expect(out[0].name.endsWith(".canvas")).toBe(true);
    expect(out[1].name).toBe("对比");
    expect(out.slice(2).map((f) => f.name)).toEqual(["Board.canvas", "board (2).canvas"]);
    expect(warns).toEqual([]);
  });

  it("危险的文件名跳过并告警", () => {
    const warns: string[] = [];
    const out = prepareExtraFiles(
      "canvas",
      [
        { name: "../x.canvas", content: "" },
        { name: "/abs.canvas", content: "" },
        { name: ".hidden", content: "" },
        { name: "a\u0000b", content: "" },
        { name: "ok/b.canvas", content: "" },
      ],
      (m) => warns.push(m),
    );
    expect(out.map((f) => f.name)).toEqual(["ok/b.canvas"]);
    expect(warns).toHaveLength(4);
  });
});
