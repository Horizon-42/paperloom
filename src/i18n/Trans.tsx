// 文案里嵌元素：文案写成 "用 {cmd} 启动时…"，组件里 <Trans text={t.data.x} values={{ cmd: <Path>npm run dev</Path> }} />。
// 只替换 values 里有的占位符，其余原样保留。
import { Fragment, type ReactNode } from "react";

export function interpolate(text: string, values: Record<string, ReactNode>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!(m[1] in values)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<Fragment key={out.length}>{values[m[1]]}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Trans({ text, values }: { text: string; values: Record<string, ReactNode> }) {
  return <>{interpolate(text, values)}</>;
}
