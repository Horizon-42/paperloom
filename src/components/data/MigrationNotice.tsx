// data/ 还是旧版结构（没有 projects.json）时的阻断提示：本地服务这时拒绝一切写入，自动保存暂停，
// 数据留在本浏览器的 IndexedDB 里不会丢；运行迁移脚本后刷新页面即可继续。
import * as Dialog from "@radix-ui/react-dialog";
import { useStorageStore } from "@/app/stores/storage";
import { btnPrimary, dialogContent, dialogOverlay, dialogTitle } from "@/components/library/ui";
import { t } from "@/i18n";
import { Trans } from "@/i18n/Trans";

const Code = ({ children }: { children: string }) => <code className="rounded bg-neutral-100 px-1 py-0.5 text-[12px]">{children}</code>;

export function MigrationNotice() {
  const phase = useStorageStore((s) => s.phase);
  const label = useStorageStore((s) => s.dataDirLabel);
  if (phase !== "needs-migration") return null;
  const block = (e: Event) => e.preventDefault();
  const m = t.data.migration;
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
          <Dialog.Title className={dialogTitle}>{m.title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-3 space-y-2 text-[13px] leading-relaxed text-neutral-600">
              <p>{m.oldLayout(label ?? "data/")}</p>
              <p>
                <Trans text={m.howTo} values={{ preview: <Code>npm run migrate:projects</Code>, apply: <Code>npm run migrate:projects -- --apply</Code> }} />
              </p>
              <p>{m.paused}</p>
            </div>
          </Dialog.Description>
          <div className="mt-4 flex justify-end">
            <button type="button" className={btnPrimary} onClick={() => location.reload()}>
              {m.reload}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
