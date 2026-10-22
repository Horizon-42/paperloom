// 侧栏顶部的项目切换器：当前项目名 ▾ → 项目列表（各带"在新标签页打开"）、新建、重命名、管理/删除。
// 切换项目 = 带 ?project=<id> 重新加载页面（先尽量把未保存的改动存进文件夹）；每个标签页一个项目，可以同时开几个。
import { useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { currentProject, useProjectsStore, type ProjectInfo } from "@/app/stores/projects";
import { projectUrl } from "@/lib/project";
import { createProject, deleteProject, openProjectInNewTab, ProjectInUseError, ProjectUnsyncedError, renameProject, type DeleteResult } from "@/services/projects";
import { flushStorage } from "@/services/storage/sync";
import { IconCheck, IconChevronDown, IconExternal, IconX } from "./icons";
import { btnDanger, btnGhost, btnOutline, btnPrimary, cx, dialogContent, dialogOverlay, dialogTitle, iconBtn, input, menuContent, menuItem, menuSeparator } from "./ui";

/** 在本标签页打开另一个项目：先把待保存的改动写进文件夹（最多等 5 秒），再重新加载 */
export async function switchToProject(id: string): Promise<void> {
  await Promise.race([flushStorage().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  location.assign(projectUrl(id));
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectSwitcher() {
  const projects = useProjectsStore((s) => s.projects);
  const currentId = useProjectsStore((s) => s.currentId);
  const source = useProjectsStore((s) => s.source);
  const needsMigration = useProjectsStore((s) => s.needsMigration);
  const openDialog = useProjectsStore((s) => s.openDialog);
  const cur = currentProject({ projects, currentId });
  const [open, setOpen] = useState(false);
  // 迁移前、或项目列表读不了时：不新建、不改名、不删除（只改本浏览器副本会和服务端对不上）
  const locked = needsMigration || source === "error";

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="-ml-0.5 flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 pl-1 pr-1.5 text-left hover:bg-neutral-200/60 data-[state=open]:bg-neutral-200/60"
            title={`项目：${cur.name}（点击切换）`}
            aria-label={`当前项目：${cur.name}，切换项目`}
            data-testid="project-switcher"
          >
            <span className="h-4 w-4 shrink-0 rounded bg-gradient-to-br from-blue-500 to-indigo-500" aria-hidden />
            <span className="truncate text-[15px] font-semibold tracking-tight text-neutral-900" data-testid="project-name">
              {cur.name}
            </span>
            <IconChevronDown width={14} height={14} className="shrink-0 text-neutral-400" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className={cx(menuContent, "w-[260px]")} data-testid="project-menu">
            <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] text-neutral-400">
              项目{source === "local" ? "（未连接本地服务：列表只保存在本浏览器）" : source === "error" ? "（本地服务的项目列表暂时无法读取）" : ""}
            </DropdownMenu.Label>
            {projects.map((p) => (
              <DropdownMenu.Item
                key={p.id}
                className={cx(menuItem, "pr-1")}
                data-project-id={p.id}
                onSelect={() => {
                  if (p.id !== currentId) void switchToProject(p.id);
                }}
              >
                <span className="flex w-4 shrink-0 justify-center text-blue-600">{p.id === currentId && <IconCheck width={14} height={14} />}</span>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.localOnly && source === "server" && <span className="shrink-0 text-[11px] text-amber-600">仅本浏览器</span>}
                <button
                  type="button"
                  className={iconBtn}
                  title="在新标签页打开"
                  aria-label={`在新标签页打开「${p.name}」`}
                  data-testid="project-open-new-tab"
                  // 只拦 click：pointerdown 仍要冒泡给菜单项，否则松开鼠标时菜单项会补发一次 click（触发切换）
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setOpen(false);
                    openProjectInNewTab(p.id);
                  }}
                >
                  <IconExternal width={13} height={13} />
                </button>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className={menuSeparator} />
            <DropdownMenu.Item className={menuItem} disabled={locked} onSelect={() => openDialog("create")}>
              新建项目…
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} disabled={locked} onSelect={() => openDialog("rename")}>
              重命名当前项目…
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} disabled={locked} onSelect={() => openDialog("manage")}>
              管理/删除项目…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ProjectDialogs />
    </>
  );
}

/** 本地服务在、但项目列表读不了（projects.json 损坏、没有响应）：明确告诉用户，而不是当作"没有本地服务" */
export function ProjectRegistryBanner() {
  const source = useProjectsStore((s) => s.source);
  const error = useProjectsStore((s) => s.error);
  if (source !== "error") return null;
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] leading-snug text-red-800" role="alert" data-testid="project-registry-error">
      <div className="font-medium">本地服务的项目列表无法读取：{error}</div>
      <div className="mt-0.5 text-red-700">现在只能使用本浏览器中的数据，项目的新建、重命名、删除已停用。请检查 data/projects.json 后刷新页面。</div>
    </div>
  );
}

function ProjectDialogs() {
  const dialog = useProjectsStore((s) => s.dialog);
  const close = () => useProjectsStore.getState().openDialog(null);
  if (dialog === "create") return <CreateProjectDialog onClose={close} />;
  if (dialog === "rename") return <RenameProjectDialog onClose={close} />;
  if (dialog === "manage") return <ManageProjectsDialog onClose={close} />;
  return null;
}

function Shell(props: { title: string; description?: ReactNode; onClose: () => void; children: ReactNode; testId: string; wide?: boolean }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content className={cx(dialogContent, props.wide && "w-[min(92vw,540px)]")} data-testid={props.testId}>
          <div className="mb-3 flex items-start gap-3">
            <Dialog.Title className={cx(dialogTitle, "min-w-0 flex-1")}>{props.title}</Dialog.Title>
            <Dialog.Close className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label="关闭">
              <IconX width={16} height={16} />
            </Dialog.Close>
          </div>
          {props.description ? (
            <Dialog.Description asChild>
              <div className="mb-3 text-[13px] leading-relaxed text-neutral-600">{props.description}</div>
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{props.title}</Dialog.Description>
          )}
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------- 新建 ----------

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const source = useProjectsStore((s) => s.source);
  const [name, setName] = useState("");
  const [newTab, setNewTab] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await createProject(name);
      if (newTab) {
        openProjectInNewTab(p.id);
        onClose();
      } else {
        await switchToProject(p.id);
      }
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Shell
      title="新建项目"
      testId="project-create-dialog"
      onClose={onClose}
      description={
        source === "server" ? (
          <>每个项目的论文、批注、术语和画布完全分开，数据保存在 data/projects/ 下各自的文件夹里。</>
        ) : (
          <>未连接本地服务：新项目只保存在本浏览器中（之后用 npm run dev 启动时会自动建立它的文件夹）。</>
        )
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[12px] text-neutral-500">项目名称</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：RoFormer 精读" autoFocus maxLength={60} aria-label="项目名称" />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-neutral-600">
          <input type="checkbox" checked={newTab} onChange={(e) => setNewTab(e.target.checked)} />
          在新标签页打开（当前标签页保持不变）
        </label>
        {error && <p className="text-[12.5px] text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnGhost} onClick={onClose}>
            取消
          </button>
          <button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>
            {busy ? "正在创建…" : "创建并打开"}
          </button>
        </div>
      </form>
    </Shell>
  );
}

// ---------- 重命名 ----------

function RenameProjectDialog({ onClose }: { onClose: () => void }) {
  const cur = useProjectsStore((s) => currentProject(s));
  const [name, setName] = useState(cur.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await renameProject(cur.id, name);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Shell title="重命名当前项目" testId="project-rename-dialog" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} aria-label="项目名称" />
        <p className="text-[12px] text-neutral-500">只改显示的名称，文件夹 data/projects/{cur.id}/ 不变。</p>
        {error && <p className="text-[12.5px] text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            取消
          </button>
          <button type="submit" className={btnPrimary} disabled={busy || !name.trim() || name.trim() === cur.name}>
            保存
          </button>
        </div>
      </form>
    </Shell>
  );
}

// ---------- 管理 / 删除 ----------

function describeDelete(name: string, r: DeleteResult): string {
  if (r.listOnly) return `已从本浏览器的项目列表中移除「${name}」（未连接本地服务：它的文件夹和本浏览器中的数据库都保留）`;
  const parts = [r.trashedTo ? `已删除「${name}」：文件夹已移到 data/${r.trashedTo}/` : `已删除「${name}」`];
  if (r.exportedAs) parts.push(`删除前已下载备份 ${r.exportedAs}`);
  if (r.browserData === "kept") parts.push("本浏览器中它的数据库已保留（打开这个项目的地址可以导出）");
  if (r.browserData === "blocked") parts.push("本浏览器中它的数据库正被占用，未能删除（不影响其他项目）");
  if (r.browserData === "failed") parts.push("本浏览器中它的数据库未能删除（不影响其他项目）");
  return parts.join("；");
}

function ManageProjectsDialog({ onClose }: { onClose: () => void }) {
  const projects = useProjectsStore((s) => s.projects);
  const currentId = useProjectsStore((s) => s.currentId);
  const source = useProjectsStore((s) => s.source);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** 本浏览器里有尚未保存的内容：可以只删文件夹、保留浏览器里的数据库 */
  const [unsynced, setUnsynced] = useState<string | null>(null);

  const remove = async (p: ProjectInfo, keepBrowserData = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await deleteProject(p.id, { keepBrowserData });
      setMessage({ ok: true, text: describeDelete(p.name, r) });
      setConfirming(null);
      setUnsynced(null);
    } catch (e) {
      if (e instanceof ProjectUnsyncedError) setUnsynced(p.id);
      setMessage({ ok: false, text: e instanceof ProjectInUseError || e instanceof ProjectUnsyncedError ? e.message : `删除失败：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const confirmText = (p: ProjectInfo) => {
    if (source === "server" && !p.localOnly)
      return `「${p.name}」的论文、批注、术语和画布将从项目列表中移除，数据移到 data/trash/projects/，不会物理删除；确认本浏览器中的数据都已保存到文件夹后，本浏览器中它的数据库也会一并删除。`;
    if (!p.localOnly) return `未连接本地服务：只会把「${p.name}」从本浏览器的项目列表中移除，它的文件夹和本浏览器中的数据库都保留。`;
    return `「${p.name}」只在本浏览器中：删除前会先下载一份 JSON 备份（不含 PDF 文件），然后删除本浏览器中它的全部数据。`;
  };

  return (
    <Shell title="管理项目" testId="project-manage-dialog" onClose={onClose} wide>
      <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
        {projects.map((p) => {
          const isCurrent = p.id === currentId;
          return (
            <li key={p.id} className="px-3 py-2" data-project-id={p.id}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-neutral-800">
                    {p.name}
                    {isCurrent && <span className="ml-1.5 text-[11px] font-normal text-blue-600">当前</span>}
                    {p.localOnly && source === "server" && <span className="ml-1.5 text-[11px] font-normal text-amber-600">仅本浏览器</span>}
                  </div>
                  <div className="truncate text-[11px] text-neutral-400">{source === "server" && !p.localOnly ? `data/projects/${p.id}/` : `本浏览器 · ${p.id}`}</div>
                </div>
                {!isCurrent && (
                  <button type="button" className={btnGhost} onClick={() => void switchToProject(p.id)}>
                    打开
                  </button>
                )}
                <button type="button" className={btnGhost} onClick={() => openProjectInNewTab(p.id)} title="在新标签页打开">
                  新标签页
                </button>
                {!isCurrent && projects.length > 1 && (
                  <button
                    type="button"
                    className={cx(btnGhost, "text-red-600 hover:bg-red-50")}
                    onClick={() => {
                      setConfirming(p.id);
                      setUnsynced(null);
                    }}
                    disabled={busy}
                    data-testid="project-delete"
                  >
                    删除…
                  </button>
                )}
              </div>
              {confirming === p.id && (
                <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[12.5px] leading-relaxed text-red-800" data-testid="project-delete-confirm">
                  <p>{confirmText(p)}</p>
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <button type="button" className={btnOutline} onClick={() => setConfirming(null)} disabled={busy}>
                      取消
                    </button>
                    {unsynced === p.id && (
                      <button type="button" className={btnOutline} onClick={() => void remove(p, true)} disabled={busy} data-testid="project-delete-keep-browser">
                        仍然删除（保留本浏览器中的数据库）
                      </button>
                    )}
                    <button type="button" className={btnDanger} onClick={() => void remove(p)} disabled={busy} data-testid="project-delete-confirm-button">
                      {busy ? "正在删除…" : "删除项目"}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[12px] text-neutral-500">当前打开的项目不能删除；要删除它，先切换到其他项目。</p>
      {message && (
        <p className={cx("mt-2 text-[12.5px]", message.ok ? "text-emerald-700" : "text-red-600")} role="status" data-testid="project-manage-message">
          {message.text}
        </p>
      )}
    </Shell>
  );
}
