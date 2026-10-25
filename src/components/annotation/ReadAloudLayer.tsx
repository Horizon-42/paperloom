// 朗读高亮（under-text 页面覆盖层，D19）：浅色画正在读的句子，深一点画正在读的词
import { useReadAloudStore } from "@/app/stores/readAloud";
import type { PageLayerContext } from "@/components/viewer/overlays";
import { pdfRectToScreen } from "@/lib/coords";
import { textRangeToPdfRects } from "@/lib/textGeometry";

export function ReadAloudLayer({ ctx }: { ctx: PageLayerContext }) {
  const { paneId, paperId, pageNumber } = ctx;
  const mine = useReadAloudStore((s) => !!s.target && s.target.paneId === paneId && s.target.paperId === paperId && s.target.page === pageNumber);
  const sentence = useReadAloudStore((s) => (mine ? s.sentence : null));
  const word = useReadAloudStore((s) => (mine ? s.word : null));
  if (!mine || !ctx.text) return null;
  const draw = (r: { start: number; end: number } | null, cls: string, kind: string) =>
    r
      ? textRangeToPdfRects(ctx, r.start, r.end).map((rect, i) => {
          const s = pdfRectToScreen(ctx.viewport, rect);
          return <div key={`${kind}${i}`} className={cls} data-read-aloud={kind} style={{ position: "absolute", left: s.left, top: s.top, width: s.width, height: s.height }} />;
        })
      : null;
  return (
    <div className="pointer-events-none absolute inset-0">
      {draw(sentence, "rounded-sm bg-sky-200/60", "sentence")}
      {draw(word, "rounded-sm bg-sky-400/55", "word")}
    </div>
  );
}
