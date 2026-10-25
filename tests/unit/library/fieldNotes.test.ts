import { describe, expect, it } from "vitest";
import { noteLabel } from "@/components/library/fieldNotes";

describe("noteLabel", () => {
  it.each([
    ["## 整体总结\n正文", "整体总结"],
    ["\n\n  - **要点**：LSTM", "要点：LSTM"],
    ["```\ncode\n```", "code"],
    ["$$\nE=mc^2\n$$", "E=mc^2"],
    ["---\n真正的标题", "真正的标题"],
    ["snake_case 和 _强调_", "snake_case 和 强调"],
    ["[链接文字](https://x.y) 后面", "链接文字 后面"],
    ["", ""],
    ["   \n  ", ""],
  ])("%j → %j", (text, label) => expect(noteLabel(text)).toBe(label));
});
