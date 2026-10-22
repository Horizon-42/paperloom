import { useMemo } from "react";
import { renderMarkdown } from "@/lib/markdown";
import "./markdown.css";

interface Props {
  source: string;
  className?: string;
  /** source 为空时显示的提示 */
  emptyText?: string;
}

export function MarkdownView({ source, className = "", emptyText }: Props) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  if (!source.trim()) {
    return emptyText ? <div className={`text-sm text-neutral-400 ${className}`}>{emptyText}</div> : null;
  }
  return <div className={`md-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
