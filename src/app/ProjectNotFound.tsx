// URL 里的 ?project= 不在项目列表中（打错了、已删除，或在另一个浏览器里建的）：不打开任何数据库，列出可以打开的项目。
// 本浏览器里还留着这个项目的数据库时（例如删除时选择了保留），提供导出为 JSON。
import { useEffect, useState } from "react";
import type { ProjectInfo } from "@/app/stores/projects";
import { isProjectId, projectUrl } from "@/lib/project";

export function ProjectNotFound(props: { requested: string; projects: ProjectInfo[]; needsMigration: boolean }) {
  const [hasLocal, setHasLocal] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isProjectId(props.requested)) return;
    void import("@/services/projectData")
      .then((m) => m.browserDbExists(props.requested))
      .then(setHasLocal, () => {});
  }, [props.requested]);

  const exportLocal = async () => {
    setMsg(null);
    try {
      const m = await import("@/services/projectData");
      const name = await m.exportBrowserCopy(props.requested, props.requested);
      setMsg(name ? `已下载 ${name}：可以在任一项目的「数据与备份」里导入它` : "本浏览器中这个项目的数据库是空的");
    } catch (e) {
      setMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-neutral-50 p-6 text-sm text-neutral-700" data-testid="project-not-found">
      <div className="w-[min(92vw,440px)] rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h1 className="text-base font-semibold text-neutral-900">找不到项目「{props.requested}」</h1>
        <p className="mt-2 leading-relaxed text-neutral-600">
          {props.needsMigration
            ? "数据目录还是旧版结构，迁移前只有原来的项目可以打开。"
            : "它可能已被删除，或者是在另一个浏览器（没有本地服务时）里新建的。"}
        </p>
        {hasLocal && (
          <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-[12.5px] leading-relaxed text-amber-900" data-testid="project-not-found-local">
            <p>本浏览器里还留着这个项目的数据。</p>
            <button type="button" className="mt-1.5 text-blue-600 hover:underline" onClick={() => void exportLocal()} data-testid="project-not-found-export">
              导出本浏览器中这个项目的数据（JSON）
            </button>
            {msg && <p className="mt-1 text-neutral-600">{msg}</p>}
          </div>
        )}
        <ul className="mt-3 space-y-1">
          {props.projects.map((p) => (
            <li key={p.id}>
              <a className="text-blue-600 hover:underline" href={projectUrl(p.id)}>
                打开「{p.name}」
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
