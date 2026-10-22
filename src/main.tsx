// 入口：先确定当前项目（URL ?project= > 上次打开的 > 列表第一个 > default，见 services/projects.ts），
// 再加载应用本体（start.tsx）。这里不能静态导入任何用到数据库的模块：数据库名取决于当前项目。
import "katex/dist/katex.min.css";
import "./index.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { bootProject } from "@/services/projects";

void bootProject().then(async (r) => {
  if (r.kind === "ok") {
    await import("./start");
    return;
  }
  const { ProjectNotFound } = await import("@/app/ProjectNotFound");
  document.title = "找不到项目 · Paperloom";
  createRoot(document.getElementById("root")!).render(createElement(ProjectNotFound, r));
});
