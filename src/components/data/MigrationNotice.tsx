// data/ 还是旧版结构（没有 projects.json）时的阻断提示：本地服务这时拒绝一切写入，自动保存暂停，
// 数据留在本浏览器的 IndexedDB 里不会丢；运行迁移脚本后刷新页面即可继续。
import * as Dialog from "@radix-ui/react-dialog";
import { useStorageStore } from "@/app/stores/storage";
import { btnPrimary, dialogContent, dialogOverlay, dialogTitle } from "@/components/library/ui";

export function MigrationNotice() {
  const phase = useStorageStore((s) => s.phase);
  const label = useStorageStore((s) => s.dataDirLabel);
  if (phase !== "needs-migration") return null;
  const block = (e: Event) => e.preventDefault();
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlay} />
        <Dialog.Content
          className={dialogContent}
          data-testid="migration-notice"
          onEscapeKeyDown={block}
          onPointerDownOutside={block}
          onInteractOutside={block}
        >
          <Dialog.Title className={dialogTitle}>数据需要迁移到项目结构：请运行 npm run migrate:projects</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-3 space-y-2 text-[13px] leading-relaxed text-neutral-600">
              <p>
                {label ?? "data/"} 还是旧版的目录结构。新版本把每个项目的数据放在 data/projects/&lt;项目&gt;/ 下，原来的数据会成为第一个项目。
              </p>
              <p>
                在项目目录里运行 <code className="rounded bg-neutral-100 px-1 py-0.5 text-[12px]">npm run migrate:projects</code> 预览，确认后运行{" "}
                <code className="rounded bg-neutral-100 px-1 py-0.5 text-[12px]">npm run migrate:projects -- --apply</code>（会先完整备份 data/）。
              </p>
              <p>迁移完成前自动保存已暂停，不会写入 data/；本浏览器中的数据不会丢失。迁移后刷新本页即可继续。</p>
            </div>
          </Dialog.Description>
          <div className="mt-4 flex justify-end">
            <button type="button" className={btnPrimary} onClick={() => location.reload()}>
              已迁移，刷新页面
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
