// 节点里的 Markdown：延迟渲染。
// 几百个节点同时进入视口时，先显示纯文本摘要，Markdown（含 KaTeX）在空闲时分批渲染并缓存；
// 缩小到看不清字时（lowDetail）始终只显示纯文本。
import { useEffect, useReducer } from "react";
import { renderMarkdown } from "@/lib/markdown";
import "@/components/common/markdown.css";
import { plainExcerpt } from "./model";

const MAX_CACHE = 2000;
const SLICE_MS = 8;

const cache = new Map<string, string>();
const waiting = new Map<string, Set<() => void>>();
let scheduled = false;

const idle: (cb: () => void) => void =
  typeof requestIdleCallback === "function" ? (cb) => requestIdleCallback(cb, { timeout: 120 }) : (cb) => setTimeout(cb, 16);

function remember(src: string, html: string) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  cache.set(src, html);
}

function run() {
  scheduled = false;
  const start = performance.now();
  for (const [src, subs] of waiting) {
    if (performance.now() - start > SLICE_MS) break;
    remember(src, renderMarkdown(src));
    waiting.delete(src);
    subs.forEach((f) => f());
  }
  if (waiting.size) schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  idle(run);
}

/** 渲染好的 HTML；还没轮到时返回 null */
function useMarkdownHtml(src: string, enabled: boolean): string | null {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const html = cache.get(src) ?? null;
  useEffect(() => {
    if (!enabled || cache.has(src)) return;
    let subs = waiting.get(src);
    if (!subs) waiting.set(src, (subs = new Set()));
    const s = subs;
    s.add(rerender);
    schedule();
    return () => {
      s.delete(rerender);
      if (!s.size && waiting.get(src) === s) waiting.delete(src);
    };
  }, [src, enabled]);
  return enabled ? html : null;
}

export function NodeMarkdown({ source, lowDetail, className = "" }: { source: string; lowDetail?: boolean; className?: string }) {
  const html = useMarkdownHtml(source, !lowDetail);
  if (html === null) return <div className={`whitespace-pre-wrap break-words text-[12.5px] leading-[1.45] ${className}`}>{plainExcerpt(source, 400)}</div>;
  return <div className={`md-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
