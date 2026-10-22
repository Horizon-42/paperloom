// 画布模块的启动注册：把全部画布以 JSON Canvas 镜像到 data/canvas/。
// CanvasView.tsx 引入本文件，App.tsx 静态引入 CanvasView，所以应用启动时即注册（画布界面本身按需加载）。
import { useCanvasStore } from "@/app/stores/canvas";
import * as canvasService from "@/services/canvasService";
import * as linkService from "@/services/linkService";
import * as noteService from "@/services/noteService";
import { registerExtraFiles } from "@/services/storage/extraFiles";
import { exportBoardFile, produceCanvasFiles } from "./exportCanvas";

registerExtraFiles("canvas", produceCanvasFiles);

// 开发模式下暴露给 e2e
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__paperlensCanvas = {
    useCanvasStore,
    canvasService,
    noteService,
    linkService,
    produceCanvasFiles,
    exportBoardFile,
  };
}
