// 附加文件组（画布等）上传前整理文件名，使其满足本地服务的白名单（server/storageFs.ts 的 validateRelativeName）：
// 过长的文件名截短（保留扩展名），结尾的点和空格去掉，重名（不区分大小写）加序号；
// 含 ".."、绝对路径、控制字符等明显错误的文件跳过并告警，不让一个坏文件名拖垮整组。
import type { ExtraFile } from "./extraFiles";

const MAX_SEGMENT_BYTES = 200; // 服务端上限 255，给序号留余量
const BAD_CHARS = /[\u0000-\u001f\u007f<>:"|?*\\]/;

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

function truncateSegment(seg: string, maxBytes: number): string {
  if (utf8Length(seg) <= maxBytes) return seg;
  const dot = seg.lastIndexOf(".");
  const ext = dot > 0 && seg.length - dot <= 16 ? seg.slice(dot) : "";
  let stem = ext ? seg.slice(0, dot) : seg;
  const budget = maxBytes - utf8Length(ext);
  let out = "";
  for (const ch of stem) {
    if (utf8Length(out + ch) > budget) break;
    out += ch;
  }
  stem = out.replace(/[. ]+$/, "");
  return `${stem}${ext}`;
}

function withSuffix(name: string, i: number): string {
  const slash = name.lastIndexOf("/");
  const dir = name.slice(0, slash + 1);
  const seg = name.slice(slash + 1);
  const dot = seg.lastIndexOf(".");
  return dot > 0 ? `${dir}${seg.slice(0, dot)} (${i})${seg.slice(dot)}` : `${dir}${seg} (${i})`;
}

export function prepareExtraFiles(group: string, files: ExtraFile[], warn: (msg: string) => void = console.warn): ExtraFile[] {
  const out: ExtraFile[] = [];
  const used = new Set<string>();
  for (const f of files) {
    if (typeof f?.name !== "string" || typeof f.content !== "string") {
      warn(`[storage] skipped an invalid file in data/${group}/`);
      continue;
    }
    const segs = f.name.split("/").map((s) => s.replace(/[. ]+$/, ""));
    if (f.name.startsWith("/") || segs.some((s) => !s || s.startsWith(".") || BAD_CHARS.test(s)) || segs.length > 8) {
      warn(`[storage] skipped file name "${f.name}": can't be written to data/${group}/`);
      continue;
    }
    let name = segs.map((s) => truncateSegment(s, MAX_SEGMENT_BYTES)).join("/");
    const base = name;
    for (let i = 2; used.has(name.normalize("NFC").toLowerCase()); i++) name = withSuffix(base, i);
    used.add(name.normalize("NFC").toLowerCase());
    out.push({ name, content: f.content });
  }
  return out;
}
