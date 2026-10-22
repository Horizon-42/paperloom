import * as ContextMenu from "@radix-ui/react-context-menu";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/schema";
import { t } from "@/i18n";
import { useReaderStore, type Pane } from "@/app/stores/reader";

interface Props {
  pane: Pane;
  focused: boolean;
  split: boolean;
}

export function TabBar({ pane, focused, split }: Props) {
  const { activateTab, closeTab, toggleSplit } = useReaderStore.getState();
  const titles = useLiveQuery(
    async () => {
      const papers = await db.papers.bulkGet(pane.tabs);
      return new Map(pane.tabs.map((id, i) => [id, papers[i]?.title ?? null]));
    },
    [pane.tabs.join("|")],
  );

  return (
    <div
      className={`flex h-9 shrink-0 items-stretch border-b border-neutral-200 ${focused && split ? "bg-white" : "bg-neutral-50"}`}
      role="tablist"
      data-tabbar={pane.id}
    >
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {pane.tabs.map((paperId) => {
          const active = paperId === pane.activePaperId;
          const title = titles ? titles.get(paperId) : undefined; // undefined：加载中；null：已删除
          return (
            <ContextMenu.Root key={paperId}>
              <ContextMenu.Trigger asChild>
                <div
                  role="tab"
                  aria-selected={active}
                  title={title ?? undefined}
                  data-tab={paperId}
                  className={`group relative flex max-w-56 min-w-24 cursor-default items-center gap-1 border-r border-neutral-200 pr-1 pl-3 text-xs ${
                    active ? "bg-white text-neutral-900" : "text-neutral-500 hover:bg-neutral-100"
                  }`}
                  onClick={() => activateTab(pane.id, paperId)}
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault(); // 阻止中键自动滚动
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) closeTab(pane.id, paperId);
                  }}
                >
                  {active && (
                    <span
                      className={`absolute inset-x-0 top-0 h-0.5 ${focused || !split ? "bg-blue-500" : "bg-neutral-300"}`}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{title === undefined ? "…" : (title ?? t.reader.tabs.deleted)}</span>
                  <button
                    type="button"
                    aria-label={t.reader.tabs.closeTab}
                    title={t.reader.tabs.closeTitle}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 ${
                      active ? "" : "opacity-0 group-hover:opacity-100"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(pane.id, paperId);
                    }}
                  >
                    <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="z-50 min-w-36 rounded-md border border-neutral-200 bg-white p-1 text-xs shadow-lg">
                  <MenuItem onSelect={() => openInOtherPane(pane.id, paperId)}>{t.reader.tabs.openInOtherPane}</MenuItem>
                  <MenuItem onSelect={() => closeTab(pane.id, paperId)}>{t.reader.tabs.closeTab}</MenuItem>
                  <MenuItem
                    onSelect={() => pane.tabs.filter((id) => id !== paperId).forEach((id) => closeTab(pane.id, id))}
                  >
                    {t.reader.tabs.closeOthers}
                  </MenuItem>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
      </div>
      <button
        type="button"
        onClick={toggleSplit}
        title={split ? t.reader.tabs.unsplit : t.reader.tabs.split}
        aria-label={split ? t.reader.tabs.unsplit : t.reader.tabs.split}
        aria-pressed={split}
        className="flex w-9 shrink-0 items-center justify-center text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
        data-split-toggle
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          {split ? <path d="M8 3v10" strokeDasharray="1.5 1.5" /> : <path d="M8 3v10" />}
        </svg>
      </button>
    </div>
  );
}

function MenuItem({ onSelect, children }: { onSelect: () => void; children: string }) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="cursor-default rounded px-2 py-1.5 text-neutral-700 outline-none data-[highlighted]:bg-neutral-100"
    >
      {children}
    </ContextMenu.Item>
  );
}

/** 在另一侧分栏也打开同一篇论文（两侧共享同一个 PDF 文档对象） */
function openInOtherPane(from: Pane["id"], paperId: string) {
  const store = useReaderStore.getState();
  if (store.panes.length === 1) store.toggleSplit();
  useReaderStore.getState().openPaper(paperId, { paneId: from === "left" ? "right" : "left" });
}
