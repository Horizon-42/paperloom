// 标签的外观：按标签名哈希取一组柔和的颜色，以及论文行里单行显示、放不下时折叠为 "+N" 的标签行。
// 颜色类名必须写成完整的字面量，Tailwind 才能扫描到。
import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { useLibraryStore } from "@/app/stores/library";
import { tagColorIndex, tagKey } from "@/lib/tags";
import { IconX } from "./icons";
import { cx } from "./ui";

interface Tone {
  /** 平常 */
  chip: string;
  /** 可点击时的悬停 */
  hover: string;
  /** 在筛选中（选中） */
  on: string;
  /** 小色块（筛选菜单、建议列表） */
  dot: string;
}

const PALETTE: readonly Tone[] = [
  { chip: "bg-sky-50 text-sky-700 ring-sky-200", hover: "hover:bg-sky-100", on: "bg-sky-600 text-white ring-sky-600", dot: "bg-sky-400" },
  { chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", hover: "hover:bg-emerald-100", on: "bg-emerald-600 text-white ring-emerald-600", dot: "bg-emerald-400" },
  { chip: "bg-amber-50 text-amber-800 ring-amber-200", hover: "hover:bg-amber-100", on: "bg-amber-500 text-white ring-amber-500", dot: "bg-amber-400" },
  { chip: "bg-rose-50 text-rose-700 ring-rose-200", hover: "hover:bg-rose-100", on: "bg-rose-600 text-white ring-rose-600", dot: "bg-rose-400" },
  { chip: "bg-violet-50 text-violet-700 ring-violet-200", hover: "hover:bg-violet-100", on: "bg-violet-600 text-white ring-violet-600", dot: "bg-violet-400" },
  { chip: "bg-teal-50 text-teal-700 ring-teal-200", hover: "hover:bg-teal-100", on: "bg-teal-600 text-white ring-teal-600", dot: "bg-teal-400" },
  { chip: "bg-orange-50 text-orange-700 ring-orange-200", hover: "hover:bg-orange-100", on: "bg-orange-500 text-white ring-orange-500", dot: "bg-orange-400" },
  { chip: "bg-indigo-50 text-indigo-700 ring-indigo-200", hover: "hover:bg-indigo-100", on: "bg-indigo-600 text-white ring-indigo-600", dot: "bg-indigo-400" },
];

export function tagTone(tag: string): Tone {
  return PALETTE[tagColorIndex(tag, PALETTE.length)];
}

const chipBase = "inline-flex shrink-0 items-center whitespace-nowrap rounded ring-1 ring-inset";
/** 论文行、工具栏里的小标签 */
const chipXs = "h-4 max-w-full px-1.5 text-[11px] leading-4";
/** 编辑器、筛选栏里的标签（可带 ×） */
const chipSm = "h-5 max-w-full gap-0.5 px-1.5 text-[12px] leading-5";

export function TagDot({ tag, className }: { tag: string; className?: string }) {
  return <span aria-hidden className={cx("h-2 w-2 shrink-0 rounded-sm", tagTone(tag).dot, className)} />;
}

/** 只读的小标签 */
export function TagChip({ tag, size = "xs", selected, className, style }: { tag: string; size?: "xs" | "sm"; selected?: boolean; className?: string; style?: CSSProperties }) {
  const tone = tagTone(tag);
  return (
    <span className={cx(chipBase, size === "xs" ? chipXs : chipSm, selected ? tone.on : tone.chip, className)} style={style} data-tag={tag}>
      <span className="truncate">{tag}</span>
    </span>
  );
}

/** 带 × 的标签（编辑器、筛选栏、编辑信息对话框） */
export function RemovableTagChip({ tag, selected, onRemove, removeLabel }: { tag: string; selected?: boolean; onRemove: () => void; removeLabel?: string }) {
  const tone = tagTone(tag);
  return (
    <span className={cx(chipBase, chipSm, "pr-0.5", selected ? tone.on : tone.chip)} data-tag={tag} data-selected={selected || undefined}>
      <span className="truncate">{tag}</span>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()} // 鼠标点击不抢走输入框的焦点；键盘可以 Tab 到这里
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className={cx(
          "rounded-sm p-px opacity-60 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-blue-400",
          selected ? "hover:bg-white/20" : "hover:bg-black/5",
        )}
        aria-label={removeLabel ?? `移除标签「${tag}」`}
        title={removeLabel ?? `移除标签「${tag}」`}
      >
        <IconX width={11} height={11} />
      </button>
    </span>
  );
}

// ---------- 论文行里的标签行 ----------

const CHIP_FONT_PX = 11;
const CHIP_PAD_X = 12; // px-1.5 × 2
const CHIP_GAP = 4; // gap-1
const BADGE_FONT_PX = 10.5;
const BADGE_PAD_X = 4;

let measureCtx: CanvasRenderingContext2D | null | undefined;
let fontFamily: string | null = null;
const textWidths = new Map<string, number>();

/** 用 canvas 量文字宽度（与界面同一字体），结果按文字缓存；取不到 canvas 时粗略估算 */
function textWidth(text: string, px: number): number {
  const key = `${px}|${text}`;
  let w = textWidths.get(key);
  if (w !== undefined) return w;
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }
  if (measureCtx) {
    fontFamily ??= getComputedStyle(document.body).fontFamily || "sans-serif";
    measureCtx.font = `${px}px ${fontFamily}`;
    w = measureCtx.measureText(text).width;
  } else {
    w = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? px : px * 0.6), 0);
  }
  textWidths.set(key, w);
  return w;
}

const chipWidth = (tag: string) => Math.ceil(textWidth(tag, CHIP_FONT_PX)) + CHIP_PAD_X + 1;
const badgeWidth = (n: number) => Math.ceil(textWidth(`+${n}`, BADGE_FONT_PX)) + BADGE_PAD_X;

/** 宽度 avail 内能完整显示前几个标签（其余折叠为 "+N"）；一个都放不下时截断第一个 */
export function fitTags(widths: readonly number[], avail: number, badge: (hidden: number) => number): { shown: number; firstMax?: number } {
  const n = widths.length;
  if (!n || avail <= 0) return { shown: n };
  let sum = 0;
  const prefix = [0];
  for (const w of widths) prefix.push((sum += w));
  if (sum + CHIP_GAP * (n - 1) <= avail) return { shown: n };
  for (let k = n - 1; k >= 1; k--) {
    if (prefix[k] + CHIP_GAP * k + badge(n - k) <= avail) return { shown: k };
  }
  return { shown: 1, firstMax: Math.max(24, avail - (n > 1 ? CHIP_GAP + badge(n - 1) : 0)) };
}

// 所有标签行共用一个 ResizeObserver
const widthCallbacks = new WeakMap<Element, (w: number) => void>();
let sharedObserver: ResizeObserver | null = null;
function observeWidth(el: Element, cb: (w: number) => void): () => void {
  sharedObserver ??= new ResizeObserver((entries) => {
    for (const e of entries) widthCallbacks.get(e.target)?.(Math.floor(e.contentRect.width));
  });
  widthCallbacks.set(el, cb);
  sharedObserver.observe(el);
  return () => {
    sharedObserver?.unobserve(el);
    widthCallbacks.delete(el);
  };
}
/** 最近量到的标签行宽度：列表里各行一样宽，新挂载的行先用它，避免先全部渲染再折叠 */
let lastLineWidth = 0;

/** 论文行里的标签：单行，放不下的折叠为 "+N"；点击切换标签筛选 */
export function TagLine({ tags }: { tags: string[] }) {
  const filter = useLibraryStore((s) => s.tagFilter);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(lastLineWidth);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = Math.floor(el.clientWidth);
    if (w) {
      lastLineWidth = w;
      setWidth(w);
    }
    return observeWidth(el, (w) => {
      if (!w) return; // 被隐藏
      lastLineWidth = w;
      setWidth(w);
    });
  }, []);

  const selected = new Set(filter.map(tagKey));
  const { shown, firstMax } = fitTags(tags.map(chipWidth), width, badgeWidth);
  const hidden = tags.slice(shown);
  const toggle = (e: MouseEvent, tag: string) => {
    e.stopPropagation(); // 不打开论文
    useLibraryStore.getState().toggleTagFilter(tag);
  };

  return (
    <div ref={ref} className="mt-1 flex h-4 min-w-0 items-center gap-1 overflow-hidden" role="group" aria-label="标签">
      {tags.slice(0, shown).map((t, i) => {
        const on = selected.has(t.toLocaleLowerCase());
        const tone = tagTone(t);
        return (
          <button
            key={t}
            type="button"
            tabIndex={-1}
            draggable={false}
            data-tag-chip={t}
            aria-pressed={on}
            title={on ? `取消按「${t}」筛选` : `按「${t}」筛选`}
            onClick={(e) => toggle(e, t)}
            onDoubleClick={(e) => e.stopPropagation()}
            className={cx(chipBase, chipXs, "cursor-pointer", on ? tone.on : cx(tone.chip, tone.hover))}
            style={i === 0 && firstMax ? { maxWidth: firstMax } : undefined}
          >
            <span className="truncate">{t}</span>
          </button>
        );
      })}
      {hidden.length > 0 && (
        <span className="shrink-0 px-0.5 text-[10.5px] tabular-nums text-neutral-400" title={hidden.join("、")} data-tag-more>
          +{hidden.length}
        </span>
      )}
    </div>
  );
}
