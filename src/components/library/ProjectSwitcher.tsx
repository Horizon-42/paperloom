// 侧栏顶部的项目切换器：当前项目名 ▾ → 项目列表（各带"在新标签页打开"）、新建、重命名、管理/删除。
// 切换项目 = 带 ?project=<id> 重新加载页面（先尽量把未保存的改动存进文件夹）；每个标签页一个项目，可以同时开几个。
import { t } from "@/i18n";
import { useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { currentProject, useProjectsStore, type ProjectInfo } from "@/app/stores/projects";
import { projectDisplayName, projectUrl } from "@/lib/project";
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
  const curName = projectDisplayName(cur);
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
            title={t.library.projects.switcherTitle(curName)}
            aria-label={t.library.projects.switcherAria(curName)}
            data-testid="project-switcher"
          >
            <span className="h-4 w-4 shrink-0 rounded bg-gradient-to-br from-blue-500 to-indigo-500" aria-hidden />
            <span className="truncate text-[15px] font-semibold tracking-tight text-neutral-900" data-testid="project-name">
              {curName}
            </span>
            <IconChevronDown width={14} height={14} className="shrink-0 text-neutral-400" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className={cx(menuContent, "w-[260px]")} data-testid="project-menu">
            <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-[11px] text-neutral-400">
              {t.library.projects.menuHeading}
              {source === "local" ? t.library.projects.menuLocalNote : source === "error" ? t.library.projects.menuErrorNote : ""}
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
                <span className="min-w-0 flex-1 truncate">{projectDisplayName(p)}</span>
                {p.localOnly && source === "server" && <span className="shrink-0 text-[11px] text-amber-600">{t.library.projects.browserOnly}</span>}
                <button
                  type="button"
                  className={iconBtn}
                  title={t.library.projects.openInNewTab}
                  aria-label={t.library.projects.openNameInNewTab(projectDisplayName(p))}
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
              {t.library.projects.newProject}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} disabled={locked} onSelect={() => openDialog("rename")}>
              {t.library.projects.renameCurrent}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} disabled={locked} onSelect={() => openDialog("manage")}>
              {t.library.projects.manage}
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
      <div className="font-medium">{t.library.projects.registryError(error)}</div>
      <div className="mt-0.5 text-red-700">{t.library.projects.registryErrorHelp}</div>
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
            <Dialog.Close className="-mr-1 -mt-0.5 rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" aria-label={t.common.close}>
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
      title={t.library.projects.create.title}
      testId="project-create-dialog"
      onClose={onClose}
      description={
        source === "server" ? (
          <>{t.library.projects.create.descServer}</>
        ) : (
          <>{t.library.projects.create.descLocal}</>
        )
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[12px] text-neutral-500">{t.library.projects.create.nameLabel}</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={t.library.projects.create.namePlaceholder} autoFocus maxLength={60} aria-label={t.library.projects.create.nameLabel} />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-neutral-600">
          <input type="checkbox" checked={newTab} onChange={(e) => setNewTab(e.target.checked)} />
          {t.library.projects.create.openInNewTab}
        </label>
        {error && <p className="text-[12.5px] text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnGhost} onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>
            {busy ? t.library.projects.create.creating : t.library.projects.create.submit}
          </button>
        </div>
      </form>
    </Shell>
  );
}

// ---------- 重命名 ----------

function RenameProjectDialog({ onClose }: { onClose: () => void }) {
  const cur = useProjectsStore((s) => currentProject(s));
  // 默认项目显示本地化的名字：输入框也从显示名开始，不改动就不能保存
  const curName = projectDisplayName(cur);
  const [name, setName] = useState(curName);
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
    <Shell title={t.library.projects.rename.title} testId="project-rename-dialog" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} aria-label={t.library.projects.create.nameLabel} />
        <p className="text-[12px] text-neutral-500">{t.library.projects.rename.note(cur.id)}</p>
        {error && <p className="text-[12.5px] text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            {t.common.cancel}
          </button>
          <button type="submit" className={btnPrimary} disabled={busy || !name.trim() || name.trim() === curName}>
            {t.common.save}
          </button>
        </div>
      </form>
    </Shell>
  );
}

// ---------- 管理 / 删除 ----------

function describeDelete(name: string, r: DeleteResult): string {
  const m = t.library.projects.manageDialog.result;
  if (r.listOnly) return m.listOnly(name);
  const parts = [r.trashedTo ? m.trashed(name, r.trashedTo) : m.deleted(name)];
  if (r.exportedAs) parts.push(m.exported(r.exportedAs));
  if (r.browserData === "kept") parts.push(m.kept);
  if (r.browserData === "blocked") parts.push(m.blocked);
  if (r.browserData === "failed") parts.push(m.failed);
  return m.join(parts);
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
      setMessage({ ok: true, text: describeDelete(projectDisplayName(p), r) });
      setConfirming(null);
      setUnsynced(null);
    } catch (e) {
      if (e instanceof ProjectUnsyncedError) setUnsynced(p.id);
      setMessage({ ok: false, text: e instanceof ProjectInUseError || e instanceof ProjectUnsyncedError ? e.message : t.library.projects.manageDialog.deleteFailed(errorText(e)) });
    } finally {
      setBusy(false);
    }
  };

  const confirmText = (p: ProjectInfo) => {
    const name = projectDisplayName(p);
    if (source === "server" && !p.localOnly) return t.library.projects.manageDialog.confirmServer(name);
    if (!p.localOnly) return t.library.projects.manageDialog.confirmListOnly(name);
    return t.library.projects.manageDialog.confirmLocal(name);
  };

  return (
    <Shell title={t.library.projects.manageDialog.title} testId="project-manage-dialog" onClose={onClose} wide>
      <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
        {projects.map((p) => {
          const isCurrent = p.id === currentId;
          return (
            <li key={p.id} className="px-3 py-2" data-project-id={p.id}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-neutral-800">
                    {projectDisplayName(p)}
                    {isCurrent && <span className="ml-1.5 text-[11px] font-normal text-blue-600">{t.library.projects.manageDialog.current}</span>}
                    {p.localOnly && source === "server" && <span className="ml-1.5 text-[11px] font-normal text-amber-600">{t.library.projects.browserOnly}</span>}
                  </div>
                  <div className="truncate text-[11px] text-neutral-400">{source === "server" && !p.localOnly ? `data/projects/${p.id}/` : t.library.projects.manageDialog.browserLocation(p.id)}</div>
                </div>
                {!isCurrent && (
                  <button type="button" className={btnGhost} onClick={() => void switchToProject(p.id)}>
                    {t.library.projects.manageDialog.open}
                  </button>
                )}
                <button type="button" className={btnGhost} onClick={() => openProjectInNewTab(p.id)} title={t.library.projects.openInNewTab}>
                  {t.library.projects.manageDialog.newTab}
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
                    {t.library.projects.manageDialog.delete}
                  </button>
                )}
              </div>
              {confirming === p.id && (
                <div className="mt-2 rounded-md bg-red-50 px-3 py-2 text-[12.5px] leading-relaxed text-red-800" data-testid="project-delete-confirm">
                  <p>{confirmText(p)}</p>
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <button type="button" className={btnOutline} onClick={() => setConfirming(null)} disabled={busy}>
                      {t.common.cancel}
                    </button>
                    {unsynced === p.id && (
                      <button type="button" className={btnOutline} onClick={() => void remove(p, true)} disabled={busy} data-testid="project-delete-keep-browser">
                        {t.library.projects.manageDialog.deleteKeepBrowser}
                      </button>
                    )}
                    <button type="button" className={btnDanger} onClick={() => void remove(p)} disabled={busy} data-testid="project-delete-confirm-button">
                      {busy ? t.library.projects.manageDialog.deleting : t.library.projects.manageDialog.deleteProject}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[12px] text-neutral-500">{t.library.projects.manageDialog.currentNote}</p>
      {message && (
        <p className={cx("mt-2 text-[12.5px]", message.ok ? "text-emerald-700" : "text-red-600")} role="status" data-testid="project-manage-message">
          {message.text}
        </p>
      )}
    </Shell>
  );
}
