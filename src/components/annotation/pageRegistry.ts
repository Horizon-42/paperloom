// 页面 ctx 登记表：选区工具栏按选区所在的页面元素找到该页的 PageLayerContext。
// 由一个 over-text 覆盖层（不渲染任何内容）在挂载、ctx 更新时登记，卸载时注销。
import { useLayoutEffect } from "react";
import type { PageLayerContext } from "@/components/viewer/overlays";

const registry = new Map<string, PageLayerContext>();

export const pageKey = (paneId: string, paperId: string, page: number) => `${paneId}|${paperId}|${page}`;

export function getPageCtx(key: string): PageLayerContext | undefined {
  return registry.get(key);
}

/** 某分栏某论文当前已挂载的所有页（按页码升序） */
export function pagesOf(paneId: string, paperId: string): PageLayerContext[] {
  const out: PageLayerContext[] = [];
  for (const ctx of registry.values()) if (ctx.paneId === paneId && ctx.paperId === paperId) out.push(ctx);
  return out.sort((a, b) => a.pageNumber - b.pageNumber);
}

/** DOM 节点所在页面的 ctx（节点须在 .pl-page 内） */
export function ctxForNode(node: Node | null): PageLayerContext | undefined {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
  const pageEl = el?.closest<HTMLElement>(".pl-page[data-page-number]");
  if (!pageEl) return undefined;
  const viewer = pageEl.closest<HTMLElement>("[data-viewer-pane][data-viewer-paper]");
  if (!viewer) return undefined;
  const ctx = registry.get(pageKey(viewer.dataset.viewerPane!, viewer.dataset.viewerPaper!, Number(pageEl.dataset.pageNumber)));
  return ctx?.pageEl === pageEl ? ctx : undefined;
}

export function PageCtxRegistrar({ ctx }: { ctx: PageLayerContext }) {
  useLayoutEffect(() => {
    const key = pageKey(ctx.paneId, ctx.paperId, ctx.pageNumber);
    registry.set(key, ctx);
    return () => {
      if (registry.get(key) === ctx) registry.delete(key);
    };
  }, [ctx]);
  return null;
}
