// 一篇论文的标签编辑弹层。全局只有一个：论文行上的按钮、行上按 T、右键菜单「标签…」、阅读器工具栏都打开它。
// 列表是虚拟化的，弹层打开期间锚点行可能被卸载，所以弹层挂在侧栏层级、由 library store 的 tagEditor 驱动，
// 用虚拟锚点每帧按选择器找锚点元素的位置（找不到时沿用上一次的位置）。
// 修改立即写库（tagService），没有保存按钮。论文被删除、工具栏所在分栏换了论文或切到其他视图时关闭。
import { useEffect, useMemo, useRef } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useAppStore } from "@/app/stores/app";
import { useLibraryStore, type TagEditorState } from "@/app/stores/library";
import { useReaderStore } from "@/app/stores/reader";
import { addPaperTags, removePaperTag } from "@/services/tagService";
import { useLibraryData } from "./libraryData";
import { TagInput, type TagInputHandle } from "./TagInput";

export function TagEditorHost() {
  const editor = useLibraryStore((s) => s.tagEditor);
  if (!editor) return null;
  return <TagEditorPopover key={editor.seq} editor={editor} />;
}

/** 锚点元素：侧栏里的论文行，或分栏工具栏上的标签按钮 */
function anchorSelector(editor: TagEditorState): string {
  const id = CSS.escape(editor.paperId);
  return editor.anchor.kind === "toolbar"
    ? `[data-pane="${editor.anchor.paneId}"] [data-tag-control="${id}"]`
    : `[data-library-sidebar] [role="option"][data-paper-id="${id}"]`;
}

/** 再次点击就关闭弹层的那个按钮 */
function triggerSelector(editor: TagEditorState): string {
  return editor.anchor.kind === "toolbar" ? anchorSelector(editor) : `[data-tag-trigger="${CSS.escape(editor.paperId)}"]`;
}

function TagEditorPopover({ editor }: { editor: TagEditorState }) {
  const { loaded, paperById, tags: allTags } = useLibraryData();
  const paper = paperById.get(editor.paperId);
  const close = useLibraryStore((s) => s.closeTagEditor);
  const view = useAppStore((s) => s.view);
  const toolbarPane = editor.anchor.kind === "toolbar" ? editor.anchor.paneId : null;
  const paneShows = useReaderStore(
    (s) => !toolbarPane || s.panes.find((p) => p.id === toolbarPane)?.activePaperId === editor.paperId,
  );
  useEffect(() => {
    if ((loaded && !paper) || (toolbarPane && (!paneShows || view !== "reader"))) close();
  }, [loaded, paper, toolbarPane, paneShows, view, close]);

  const selector = anchorSelector(editor);
  const virtualRef = useMemo(() => {
    let last = new DOMRect(-10000, -10000, 0, 0);
    return {
      current: {
        getBoundingClientRect(): DOMRect {
          const el = document.querySelector(selector);
          if (el) last = el.getBoundingClientRect();
          return last;
        },
      },
    };
  }, [selector]);

  const inputRef = useRef<TagInputHandle>(null);
  // 点击别处关闭时不把焦点抢回锚点
  const refocus = useRef(true);

  if (!paper) return null;
  const row = editor.anchor.kind === "row";

  return (
    <Popover.Root open onOpenChange={(o) => !o && close()}>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          side={row ? "right" : "bottom"}
          align={row ? "start" : "end"}
          sideOffset={row ? 10 : 4}
          collisionPadding={8}
          updatePositionStrategy="always"
          aria-label="编辑标签"
          data-tag-editor={paper.id}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (refocus.current) document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
          }}
          onPointerDownOutside={(e) => {
            // 再点一次同一个按钮：交给按钮去关闭（否则这里先关掉，按钮的点击又把它打开）
            if ((e.target as Element | null)?.closest?.(triggerSelector(editor))) {
              e.preventDefault();
              return;
            }
            refocus.current = false;
          }}
          onFocusOutside={() => {
            refocus.current = false;
          }}
          className="z-50 w-[288px] rounded-lg border border-neutral-200 bg-white p-2.5 text-[13px] text-neutral-700 shadow-lg shadow-neutral-900/10 focus:outline-none"
        >
          <div className="mb-2 flex items-baseline gap-2 px-0.5">
            <span className="shrink-0 text-xs font-medium text-neutral-600">标签</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-neutral-400" title={paper.title}>
              {paper.title}
            </span>
          </div>
          <TagInput
            ref={inputRef}
            variant="popover"
            tags={paper.tags ?? []}
            allTags={allTags}
            label="添加标签"
            onAdd={(names) => void addPaperTags(paper.id, names)}
            onRemove={(t) => void removePaperTag(paper.id, t)}
            onEmptyEnter={close}
          />
          <div className="mt-2 border-t border-neutral-100 px-0.5 pt-1.5 text-[11px] text-neutral-400">回车添加 · 逗号分隔多个 · Esc 关闭</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
