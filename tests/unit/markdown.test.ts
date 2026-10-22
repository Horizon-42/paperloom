import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/markdown";

describe("renderMarkdown", () => {
  it("renders inline math with KaTeX", () => {
    expect(renderMarkdown("energy $E=mc^2$")).toContain("katex");
  });
  it("escapes raw html", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });
  it("opens links in a new tab", () => {
    expect(renderMarkdown("[a](https://example.com)")).toContain('target="_blank"');
  });
});
