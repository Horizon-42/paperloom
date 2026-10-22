// @vitest-environment node
// 界面文案只能写在 src/i18n/locales/ 里：扫描 src/ 下其余代码中的字符串和 JSX 文字，不能含中文（注释不算）。
// 确实需要中文字符、又不是界面文字的代码（如识别中文标点的规则、数据里的固定标记），在同一行或上一行写
// `// i18n-ignore: <原因>`；中文标点也可以写成 \uXXXX 转义并加注释。
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
  const lines = text.split("\n");
  const ignored = (line: number) => /i18n-ignore:\s*\S/.test(lines[line - 1] ?? "") || /i18n-ignore:\s*\S/.test(lines[line - 2] ?? "");
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
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (CJK.test(s) && !ignored(line)) out.push({ line, text: s.trim().slice(0, 60) });
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
    // 写明原因的 i18n-ignore 豁免本行和下一行；没写原因的不算
    const ignored = `const a = "中"; // i18n-ignore: 标记\n// i18n-ignore: 规则\nconst b = /中/;\nconst c = "中"; // i18n-ignore:`;
    expect(hardcodedCjk("x.ts", ignored).map((h) => h.line)).toEqual([4]);
  });

  it("src/ 下除 i18n/locales/ 外没有写死的中文", () => {
    const report: string[] = [];
    let total = 0;
    for (const f of files(SRC)) {
      const rel = relative(ROOT, f).split("\\").join("/");
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
