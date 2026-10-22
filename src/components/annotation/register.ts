// 批注模块向 pageOverlays / docOverlays 注册覆盖层、向文库搜索注册结果提供者。
// App.tsx 会在首次渲染前 import 本文件。
import { useAnnotationStore } from "@/app/stores/annotation";
import { registerSearchProvider } from "@/components/library/search";
import { docOverlays, pageOverlays } from "@/components/viewer/overlays";
import * as annotationService from "@/services/annotationService";
import * as reanchorService from "@/services/reanchorService";
import { HighlightLayer } from "./HighlightLayer";
import { MarginRail } from "./MarginRail";
import { PageCtxRegistrar } from "./pageRegistry";
import { annotationSearchProvider } from "./searchProvider";

if (!pageOverlays.some((e) => e.key === "annotation-highlights")) {
  pageOverlays.push(
    { key: "annotation-highlights", slot: "under-text", Component: HighlightLayer },
    { key: "annotation-page-registry", slot: "over-text", Component: PageCtxRegistrar },
  );
  docOverlays.push({ key: "annotation-margin", slot: "margin", Component: MarginRail });
}

registerSearchProvider(annotationSearchProvider);

// 开发模式下暴露给 e2e
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__paperlensAnnotation = {
    useAnnotationStore,
    annotationService,
    reanchorService,
  };
}
