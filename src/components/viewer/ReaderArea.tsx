import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/schema";
import { useReaderStore, type Pane } from "@/app/stores/reader";
import { MAX_BACKGROUND_DOCS, useViewerStore } from "@/app/stores/viewer";
import { acquirePdf } from "@/lib/pdfDocs";
import { PdfViewer } from "./PdfViewer";
import { TabBar } from "./TabBar";

/** 阅读区：1 个或左右 2 个分栏，每栏有标签栏和当前论文的 PdfViewer */
export function ReaderArea() {
  const panes = useReaderStore((s) => s.panes);
  const focusedPane = useReaderStore((s) => s.focusedPane);
  const splitRatio = useViewerStore((s) => s.splitRatio);
  const split = panes.length > 1;
  const empty = panes.every((p) => p.tabs.length === 0);

  // 清理已关闭论文的界面状态
  const openIds = panes.flatMap((p) => p.tabs);
  const openKey = openIds.join("|");
  useEffect(() => {
    useViewerStore.getState().pruneTabViews(openKey ? openKey.split("|") : []);
  }, [openKey]);

  const containerRef = useRef<HTMLDivElement>(null);

  // 后台标签的文档：前台视图自己持有文档；后台只保留最近显示过的 MAX_BACKGROUND_DOCS 篇，
  // 其余释放（视图状态仍在 store 里，切回时重新加载并恢复位置）
  const docMru = useViewerStore((s) => s.docMru);
  const foreground = new Set(panes.map((p) => p.activePaperId).filter((id): id is string => !!id));
  const background = new Set(openIds.filter((id) => !foreground.has(id)));
  const keep = docMru.filter((id) => background.has(id)).slice(0, MAX_BACKGROUND_DOCS);
  // 一次查齐所有打开论文的 fileHash，切换标签时保留者能在同一次提交里接住文档。
  // 以排序后的论文集合为依赖（标签顺序、所在分栏变化不重查），重查期间沿用上一次的结果
  const idsKey = [...new Set(openIds)].sort().join("|");
  const queried = useLiveQuery(async () => {
    const ids = idsKey ? idsKey.split("|") : [];
    const papers = await db.papers.bulkGet(ids);
    return new Map(ids.map((id, i) => [id, papers[i]?.fileHash]));
  }, [idsKey]);
  const lastHashes = useRef(new Map<string, string | undefined>());
  if (queried) lastHashes.current = queried;
  const hashes = queried ?? lastHashes.current;

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1" data-reader-area>
      {keep.map((id) => {
        const fileHash = hashes.get(id);
        return fileHash ? <DocRetainer key={id} paperId={id} fileHash={fileHash} /> : null;
      })}
      {empty && !split ? (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">从左侧选择一篇论文</div>
      ) : (
        panes.map((pane, i) => (
          <PaneSlot
            key={pane.id}
            pane={pane}
            focused={pane.id === focusedPane}
            split={split}
            basis={split ? (i === 0 ? splitRatio : 1 - splitRatio) : 1}
            divider={split && i === 0 ? <Divider containerRef={containerRef} /> : null}
          />
        ))
      )}
    </div>
  );
}

function PaneSlot({
  pane,
  focused,
  split,
  basis,
  divider,
}: {
  pane: Pane;
  focused: boolean;
  split: boolean;
  basis: number;
  divider: ReactNode;
}) {
  return (
    <>
      <section
        className="relative flex min-h-0 min-w-0 flex-col"
        style={{ flex: `${basis} 1 0px` }}
        data-pane={pane.id}
        data-focused={focused || undefined}
        onPointerDownCapture={() => {
          if (useReaderStore.getState().focusedPane !== pane.id) useReaderStore.getState().focusPane(pane.id);
        }}
      >
        <TabBar pane={pane} focused={focused} split={split} />
        {pane.activePaperId ? (
          <PdfViewer key={pane.activePaperId} paneId={pane.id} paperId={pane.activePaperId} />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-neutral-100 text-sm text-neutral-400">
            {focused ? "在左侧点击论文，在此分栏打开" : "点击此处后，从左侧选择论文在此分栏打开"}
          </div>
        )}
        {split && focused && <div className="pointer-events-none absolute inset-0 z-20 ring-1 ring-blue-400/40 ring-inset" />}
      </section>
      {divider}
    </>
  );
}

/** 分栏之间的可拖动分隔条；双击恢复等分 */
function Divider({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const setRatio = useViewerStore((s) => s.setSplitRatio);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整分栏宽度"
      className="group relative z-30 w-1.5 shrink-0 cursor-col-resize bg-neutral-200 hover:bg-blue-300 active:bg-blue-400"
      data-split-divider
      onDoubleClick={() => setRatio(0.5)}
      onPointerDown={(e) => {
        const el = containerRef.current;
        if (!el) return;
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const rect = el.getBoundingClientRect();
        let raf = 0;
        let x = e.clientX;
        const onMove = (ev: PointerEvent) => {
          x = ev.clientX;
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            setRatio((x - rect.left) / rect.width);
          });
        };
        const onUp = () => {
          cancelAnimationFrame(raf);
          setRatio((x - rect.left) / rect.width);
          target.removeEventListener("pointermove", onMove);
          target.removeEventListener("pointerup", onUp);
          target.removeEventListener("pointercancel", onUp);
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
        target.addEventListener("pointercancel", onUp);
      }}
    />
  );
}

/** 让后台标签的 PDF 文档保持加载 */
function DocRetainer({ paperId, fileHash }: { paperId: string; fileHash: string }) {
  useEffect(() => acquirePdf({ paperId, fileHash }).release, [paperId, fileHash]);
  return null;
}
