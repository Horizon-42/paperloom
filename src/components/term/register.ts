// 术语前台模块向 pageOverlays 注册术语下划线覆盖层。App.tsx 会在首次渲染前 import 本文件。
import { pageOverlays } from "@/components/viewer/overlays";
import { TermUnderlineLayer } from "./TermLayer";
import { getTermRuntime, startTermRuntime } from "./runtime";
import { getPaperOccurrenceIndex } from "./paperIndex";

pageOverlays.push({ key: "term-underlines", slot: "under-text", Component: TermUnderlineLayer });

// 启动时就订阅术语表并建好匹配器，不等第一页挂载
if (typeof window !== "undefined") startTermRuntime();

// 开发模式下暴露给 e2e 和手工性能检查
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__paperlensTerm = { getTermRuntime, getPaperOccurrenceIndex };
}
