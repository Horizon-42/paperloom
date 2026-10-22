// 覆盖层与搜索提供者必须在首次渲染前注册
import "@/components/annotation/register";
import "@/components/term/register";
import "@/components/term/glossary/register";
import { LibrarySidebar } from "@/components/library/LibrarySidebar";
import { ReaderArea } from "@/components/viewer/ReaderArea";
import { GlossaryView } from "@/components/term/GlossaryView";
import { AnnotationList } from "@/components/annotation/AnnotationList";
import { CanvasView } from "@/components/canvas/CanvasView";
import { AnnotationHost } from "@/components/annotation/AnnotationHost";
import { TermHost } from "@/components/term/TermHost";
import { useAppStore } from "./stores/app";

export function App() {
  const view = useAppStore((s) => s.view);
  return (
    <div className="flex h-full overflow-hidden">
      <LibrarySidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 阅读器始终挂载，切到其他视图时只隐藏，保留滚动位置和已渲染页面 */}
        <div className={view === "reader" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
          <ReaderArea />
        </div>
        {view === "glossary" && <GlossaryView />}
        {view === "annotations" && <AnnotationList />}
        {view === "canvas" && <CanvasView />}
      </main>
      <AnnotationHost />
      <TermHost />
    </div>
  );
}
