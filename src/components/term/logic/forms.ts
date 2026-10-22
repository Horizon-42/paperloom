// 表面形式质量检查（纯函数）：太短或不含字母数字的形式会命中大量无关文字（如 "a" 命中几乎每个冠词，"-" 命中每个连字符）。
// 只提示，不阻止保存。

export interface WeakForm {
  form: string;
  /** noAlnum：没有字母或数字；short：只有 1 个字母或数字 */
  reason: "noAlnum" | "short";
}

const ALNUM = /[\p{L}\p{N}]/gu;

export function weakForms(forms: readonly { form: string }[]): WeakForm[] {
  const out: WeakForm[] = [];
  const seen = new Set<string>();
  for (const { form } of forms) {
    if (seen.has(form)) continue;
    seen.add(form);
    const n = form.match(ALNUM)?.length ?? 0;
    if (n === 0) out.push({ form, reason: "noAlnum" });
    else if (n === 1) out.push({ form, reason: "short" });
  }
  return out;
}
