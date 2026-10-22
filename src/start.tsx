// 应用本体：main.tsx 确定当前项目（lib/project.ts）之后才加载本模块，数据库、Worker、各 store 都按那个项目打开。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { requestPersistentStorage } from "@/db/schema";
import { currentProjectId } from "@/lib/project";
import { startIndexer } from "@/services/indexer";
import { startStorageSync } from "@/services/storage/sync";

void requestPersistentStorage();
startIndexer();
startStorageSync();

if (import.meta.env.DEV) {
  // 供 e2e 测试注入数据和驱动界面
  void Promise.all([
    import("@/db/schema"),
    import("@/app/stores/app"),
    import("@/app/stores/reader"),
    import("@/app/stores/library"),
    import("@/app/stores/termUi"),
    import("@/app/stores/storage"),
    import("@/app/stores/canvas"),
    import("@/app/stores/projects"),
  ]).then(([schema, app, reader, library, termUi, storage, canvas, projects]) => {
    (window as unknown as Record<string, unknown>).__paperlens = {
      projectId: currentProjectId(),
      db: schema.db,
      useAppStore: app.useAppStore,
      useReaderStore: reader.useReaderStore,
      useLibraryStore: library.useLibraryStore,
      useTermUiStore: termUi.useTermUiStore,
      useStorageStore: storage.useStorageStore,
      useCanvasStore: canvas.useCanvasStore,
      useProjectsStore: projects.useProjectsStore,
    };
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
