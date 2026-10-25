// 朗读时的小播放条（D19）：底部居中，显示在读的内容，暂停 / 继续、停止、语速
import { t } from "@/i18n";
import { useReadAloudStore } from "@/app/stores/readAloud";
import { IconPause, IconPlay, IconSpeaker, IconStop } from "./icons";
import { RATES, pauseReadAloud, resumeReadAloud, setReadAloudRate, stopReadAloud } from "./readAloud";

const btn = "flex h-7 items-center justify-center rounded-md px-1.5 text-[12px] text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900";

export function ReadAloudBar() {
  const status = useReadAloudStore((s) => s.status);
  const target = useReadAloudStore((s) => s.target);
  const rate = useReadAloudStore((s) => s.rate);
  if (status === "idle" || !target) return null;
  const tx = t.reader.readAloud;
  const next = RATES[(RATES.indexOf(rate as (typeof RATES)[number]) + 1) % RATES.length] ?? 1;
  return (
    <div
      role="region"
      aria-label={tx.barLabel}
      data-read-aloud-bar={status}
      className="fixed bottom-16 left-1/2 z-40 flex max-w-[min(560px,90vw)] -translate-x-1/2 items-center gap-1 rounded-full border border-neutral-200 bg-white py-1 pl-3 pr-1.5 shadow-lg shadow-neutral-900/10"
    >
      <IconSpeaker width={15} height={15} className="shrink-0 text-sky-600" />
      <span className="mx-1 min-w-0 flex-1 truncate text-[12.5px] text-neutral-700" title={target.text}>
        {status === "paused" ? tx.paused : tx.reading} · {target.text}
      </span>
      {status === "speaking" ? (
        <button type="button" className={btn} aria-label={tx.pause} title={tx.pause} onClick={pauseReadAloud}>
          <IconPause />
        </button>
      ) : (
        <button type="button" className={btn} aria-label={tx.resume} title={tx.resume} onClick={resumeReadAloud}>
          <IconPlay />
        </button>
      )}
      <button type="button" className={`${btn} w-12 tabular-nums`} title={tx.rateTitle} aria-label={tx.rateLabel(rate)} onClick={() => setReadAloudRate(next)} data-read-aloud-rate>
        {rate}×
      </button>
      <button type="button" className={btn} aria-label={tx.stop} title={tx.stop} onClick={stopReadAloud}>
        <IconStop />
      </button>
    </div>
  );
}
