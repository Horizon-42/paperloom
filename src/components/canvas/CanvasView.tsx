// 笔记画布（开发文档第 9 节）入口。React Flow 较大，画布界面按需加载；导出注册在 register.ts 中随启动执行。
import { lazy, Suspense } from "react";
import "./register";

const CanvasWorkspace = lazy(() => import("./CanvasWorkspace"));

export function CanvasView() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-neutral-400">正在加载画布…</div>}>
      <CanvasWorkspace />
    </Suspense>
  );
}
