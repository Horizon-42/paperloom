// @vitest-environment node
// 界面文案只能写在 src/i18n/locales/ 里：扫描 src/ 下其余代码中的字符串和 JSX 文字，不能含中文（注释不算）。
// 确实需要中文字符的代码（如中文标点的识别规则）在 ALLOW 里逐条登记原因。
// 只查部分路径：I18N_SCAN=src/components/canvas,src/services/linkService.ts npx vitest run tests/unit/i18n/hardcoded.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(ROOT, "src");
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

const SCAN = (process.env.I18N_SCAN ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** 允许含中文的文件（相对仓库根目录）→ 原因 */
const ALLOW: Record<string, string> = {
  "src/i18n/index.ts": "语言列表里各语言用自己的写法（中文）",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return p === join(SRC, "i18n", "locales") ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [p] : [];
  });
}

/** 一个文件里含中文的字符串字面量、模板片段、JSX 文字 */
export function hardcodedCjk(path: string, text = readFileSync(path, "utf8")): { line: number; text: string }[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      const s = node.getText(sf);
      if (CJK.test(s)) out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: s.trim().slice(0, 60) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("界面文案不写死在代码里", () => {
  it("扫描器只认字符串和 JSX 文字，不认注释", () => {
    const sample = `// 注释里的中文\nconst a = "中文"; /* 块注释 中文 */\nconst b = <p>文字</p>;\nconst c = \`x\${1}中\`;\nconst d = "english";`;
    expect(hardcodedCjk("x.tsx", sample).map((h) => h.line)).toEqual([2, 3, 4]);
  });

  it("src/ 下除 i18n/locales/ 外没有写死的中文", () => {
    const report: string[] = [];
    let total = 0;
    for (const f of files(SRC)) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (rel in ALLOW) continue;
      if (SCAN.length && !SCAN.some((p) => rel.startsWith(p))) continue;
      const hits = hardcodedCjk(f);
      if (!hits.length) continue;
      total += hits.length;
      report.push(`${rel}（${hits.length}）: ` + hits.slice(0, SCAN.length ? 50 : 3).map((h) => `${h.line}:${h.text}`).join(" | "));
    }
    if (total) console.log(`写死的中文共 ${total} 处，${report.length} 个文件：\n` + report.join("\n"));
    expect(report).toEqual([]);
  });
});
