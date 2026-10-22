// @vitest-environment node
// 本地服务的错误代码与前端文案表（t.data.errors.server）对得上：
// 服务端每个错误代码都有文案；中文文案写死的条目必须与服务端原文一致（中文界面的错误提示与改造前相同，服务端改了措辞也能发现）。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import zhData from "../../../../src/i18n/locales/zh/data";

const SERVER = fileURLToPath(new URL("../../../../server", import.meta.url));

/** 服务端源码里的 (代码, 原文)：new StorageError(状态, "代码", "原文"…)、{ code|error: "代码", message: "原文" }；原文不是字面量时为 null */
function serverErrors(): { code: string; message: string | null; where: string }[] {
  const out: { code: string; message: string | null; where: string }[] = [];
  for (const name of readdirSync(SERVER).filter((n) => n.endsWith(".ts"))) {
    const path = join(SERVER, name);
    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const lit = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
    const where = (n: ts.Node) => `${name}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && node.expression.getText(sf) === "StorageError") {
        const code = lit(node.arguments?.[1]);
        if (code) out.push({ code, message: lit(node.arguments?.[2]), where: where(node) });
      }
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (k: string) =>
          node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === k)?.initializer;
        const code = lit(prop("code")) ?? lit(prop("error"));
        if (code && prop("message")) out.push({ code, message: lit(prop("message")), where: where(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe("本地服务的错误文案", () => {
  const table = zhData.errors.server as Record<string, unknown>;
  const found = serverErrors();

  it("扫描到了服务端的错误", () => {
    expect(found.length).toBeGreaterThan(30);
  });

  it("服务端的每个错误代码都有文案", () => {
    const missing = [...new Set(found.filter((e) => !(e.code in table)).map((e) => `${e.code}（${e.where}）`))];
    expect(missing).toEqual([]);
  });

  it("写死的中文文案与服务端原文一致", () => {
    const drift = found
      .filter((e) => typeof table[e.code] === "string" && e.message !== null && e.message !== table[e.code])
      .map((e) => `${e.code}（${e.where}）：服务端"${e.message}" ≠ 文案"${String(table[e.code])}"`);
    expect(drift).toEqual([]);
  });
});
