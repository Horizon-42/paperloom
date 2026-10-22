// 标签输入框：已有标签显示为可移除的小块，输入时从文库已有标签中自动补全。
//   回车：添加高亮的那一项。默认高亮：与输入相同或以输入开头的已有标签，否则是"新建「输入」"；
//         ↑/↓ 可以选任意一项。建议列表没显示时（表单里按过 Esc、失焦后回来），回车原样添加输入的文字。
//   逗号、分号（含全角）：把输入的文字原样提交；粘贴 "a, b, c"：一次加多个。
//   输入框为空时退格：第一次选中最后一个标签，再按一次才移除（按住不放的自动重复不算）。
// 输入法组字时（中文输入）的回车、标点、退格一律交给输入法，不当作提交。
// 两种用法：popover（标签编辑弹层，建议列表常驻在输入框下方）、form（编辑信息对话框，输入时浮出建议）。
import { t } from "@/i18n";
import { Trans } from "@/i18n/Trans";
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { findTag, normalizeTag, parseTagInput, suggestTags, type TagInfo } from "@/lib/tags";
import { IconPlus } from "./icons";
import { RemovableTagChip, TagDot } from "./TagChips";
import { isComposingKey } from "./tagKeys";
import { cx } from "./ui";

export interface TagInputHandle {
  focus(): void;
  /** 取出输入框里还没提交的文字（解析为标签，沿用文库里的写法）并清空 */
  takeDraft(): string[];
}

interface Props {
  tags: string[];
  allTags: readonly TagInfo[];
  onAdd: (tags: string[]) => void;
  onRemove: (tag: string) => void;
  variant: "popover" | "form";
  /** 输入框为空、没有高亮建议时按回车；不提供时不拦截（在表单里即提交表单） */
  onEmptyEnter?: () => void;
  id?: string;
  /** 输入框的无障碍名称（有 id 并配了 <label> 时可省略） */
  label?: string;
  placeholder?: string;
}

type Option = { kind: "tag"; name: string; count: number } | { kind: "create"; name: string };

// \uFF0C \uFF1B：全角逗号、分号
const SEPARATOR = /[,\uFF0C;\uFF1B\n\r]/;
const MAX_SUGGESTIONS = 50;
/** 高亮项"自动"：有输入时高亮第一项（输入的标签论文已有时不高亮），没输入时不高亮 */
const AUTO = -2;

export const TagInput = forwardRef<TagInputHandle, Props>(function TagInput(props, ref) {
  const { tags, allTags, onAdd, onRemove, variant, onEmptyEnter, id, label, placeholder = t.library.tags.input.placeholder } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState(AUTO);
  const [focused, setFocused] = useState(false);
  const [listOpen, setListOpen] = useState(false); // 仅 form：是否浮出建议
  // 退格选中、等待第二次退格移除的标签（只认当前最后一个）
  const [armed, setArmed] = useState<string | null>(null);
  const armedTag = armed !== null && tags[tags.length - 1] === armed ? armed : null;
  const listId = useId();
  const optId = (i: number) => `${listId}-opt-${i}`;

  const q = normalizeTag(draft);
  const qk = q.toLocaleLowerCase();
  const own = useMemo(() => new Set(tags.map((t) => t.toLocaleLowerCase())), [tags]);
  const already = !!q && own.has(qk);
  const exists = !!q && allTags.some((t) => t.name.toLocaleLowerCase() === qk);
  const options: Option[] = useMemo(() => {
    const hits = suggestTags(allTags, draft, tags, MAX_SUGGESTIONS);
    // 与输入相同或以输入开头的排在前面（各组内保持论文数、名称的顺序）
    const lead = hits.filter((t) => t.name.toLocaleLowerCase().startsWith(qk));
    const rest = hits.filter((t) => !t.name.toLocaleLowerCase().startsWith(qk));
    const tagOpts = [...lead, ...rest].map((t): Option => ({ kind: "tag", name: t.name, count: t.count }));
    if (!q || exists || already) return tagOpts;
    const create: Option = { kind: "create", name: q };
    // 没有以输入开头的已有标签时，"新建"是默认项，放在最前
    return qk && lead.length ? [...tagOpts, create] : [create, ...tagOpts];
  }, [allTags, draft, tags, q, qk, exists, already]);
  // 默认高亮第一项：上面的排序保证它是相同/前缀匹配的已有标签，或"新建"
  const act = active === AUTO ? (q && !already && options.length ? 0 : -1) : Math.min(active, options.length - 1);
  const listShown = variant === "popover" || (listOpen && focused && (options.length > 0 || already));

  useEffect(() => {
    if (act >= 0) document.getElementById(`${listId}-opt-${act}`)?.scrollIntoView({ block: "nearest" });
  }, [act, listId]);

  /** 已有同名标签时沿用文库里的写法；论文已有的跳过 */
  const resolve = (raw: string[]) => {
    const out: string[] = [];
    const seen = new Set(own);
    for (const t of raw) {
      const name = findTag(allTags, t)?.name ?? t;
      const k = name.toLocaleLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(name);
    }
    return out;
  };

  const reset = () => {
    setDraft("");
    setActive(AUTO);
    if (variant === "form") setListOpen(false);
  };

  const commitText = (raw: string) => {
    const parts = resolve(parseTagInput(raw));
    if (parts.length) onAdd(parts);
    reset();
  };

  const choose = (o: Option) => {
    const parts = resolve([o.name]);
    if (parts.length) onAdd(parts);
    reset();
    inputRef.current?.focus();
  };

  const remove = (tag: string) => {
    setArmed(null);
    onRemove(tag);
    inputRef.current?.focus(); // 用键盘点 × 时按钮随即消失，焦点回到输入框
  };

  /** 文字里含分隔符：前面的部分提交，最后一段留在输入框 */
  const splitCommit = (value: string) => {
    const parts = value.split(SEPARATOR);
    const rest = parts.pop() ?? "";
    commitText(parts.join(","));
    setDraft(rest);
    if (variant === "form") setListOpen(!!normalizeTag(rest));
  };

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    takeDraft() {
      const parts = resolve(parseTagInput(draft));
      reset();
      return parts;
    },
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(e)) return;
    if (e.key !== "Backspace" && armed !== null) setArmed(null);
    const n = options.length;
    switch (e.key) {
      case "Enter": {
        if (!listShown) {
          // 看不见建议时只认输入的文字
          if (q) {
            e.preventDefault();
            commitText(draft);
          } else if (onEmptyEnter) {
            e.preventDefault();
            onEmptyEnter();
          }
          return;
        }
        const o = act >= 0 ? options[act] : undefined;
        if (o) {
          e.preventDefault();
          choose(o);
        } else if (q) {
          e.preventDefault();
          commitText(draft);
        } else if (onEmptyEnter) {
          e.preventDefault();
          onEmptyEnter();
        }
        return;
      }
      case ",":
      case "\uFF0C": // 全角逗号
      case ";":
      case "\uFF1B": // 全角分号
        e.preventDefault();
        if (q) commitText(draft);
        return;
      case "Backspace": {
        const el = e.currentTarget;
        if (draft || !tags.length || el.selectionStart !== 0 || el.selectionEnd !== 0) return;
        e.preventDefault();
        if (e.repeat) return; // 按住不放：清空文字后的自动重复不删标签
        const last = tags[tags.length - 1];
        if (armedTag === last) remove(last);
        else setArmed(last);
        return;
      }
      case "ArrowDown":
      case "ArrowUp":
        if (!n) return;
        e.preventDefault();
        if (!listShown) {
          // 收起的建议列表：先展开，保留（或从第一项开始）高亮
          setListOpen(true);
          setActive(Math.max(act, 0));
          return;
        }
        setActive(e.key === "ArrowDown" ? (act + 1) % n : act <= 0 ? n - 1 : act - 1);
        return;
      case "Escape":
        // 表单里先收起建议，不关闭对话框（对话框那边按 data-tag-input-open 判断）
        if (variant === "form" && listShown) {
          e.preventDefault();
          e.stopPropagation();
          setListOpen(false);
        }
        return;
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!SEPARATOR.test(text)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const v = el.value;
    commitText(v.slice(0, el.selectionStart ?? v.length) + text + v.slice(el.selectionEnd ?? v.length));
  };

  const list = listShown && (
    <div
      id={listId}
      role="listbox"
      aria-label={t.library.tags.input.suggestions}
      className={cx(
        "overflow-y-auto overscroll-contain",
        variant === "popover"
          ? "mt-1.5 max-h-52"
          : "absolute left-0 right-0 top-full z-10 mt-1 max-h-48 rounded-md border border-neutral-200 bg-white p-1 shadow-lg shadow-neutral-900/10",
      )}
    >
      {variant === "popover" && !q && options.length > 0 && <div className="px-2 pb-0.5 pt-1 text-[11px] text-neutral-400">{t.library.tags.input.existing}</div>}
      {options.map((o, i) => (
        <div
          key={`${o.kind}:${o.name}`}
          id={optId(i)}
          role="option"
          aria-selected={i === act}
          onMouseDown={(e) => e.preventDefault()} // 保持输入框焦点
          onClick={() => choose(o)}
          onMouseMove={() => i !== act && setActive(i)}
          className={cx(
            "flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-[12.5px]",
            i === act ? "bg-neutral-100 text-neutral-900" : "text-neutral-700",
          )}
          data-tag-option={o.kind}
        >
          {o.kind === "tag" ? (
            <>
              <TagDot tag={o.name} />
              <span className="min-w-0 flex-1 truncate">{highlight(o.name, qk)}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">{o.count}</span>
            </>
          ) : (
            <>
              <IconPlus width={12} height={12} className="shrink-0 text-neutral-400" />
              <span className="min-w-0 flex-1 truncate">
                <Trans text={t.library.tags.input.create} values={{ tag: <span className="font-medium">{o.name}</span> }} />
              </span>
            </>
          )}
        </div>
      ))}
      {already && <div className="px-2 py-1 text-[12px] text-neutral-400">{t.library.tags.input.already(q)}</div>}
      {variant === "popover" && !q && options.length === 0 && (
        <div className="px-2 py-1.5 text-[12px] leading-relaxed text-neutral-400">
          {allTags.length ? t.library.tags.input.allAdded : t.library.tags.input.emptyHint}
        </div>
      )}
    </div>
  );

  return (
    <div className="relative">
      <div
        className={cx(
          "flex min-h-8 cursor-text flex-wrap items-center gap-1 rounded-md border bg-white px-1.5 py-1",
          focused ? "border-blue-400 ring-2 ring-blue-100" : "border-neutral-200",
        )}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {tags.map((t) => (
          <RemovableTagChip key={t} tag={t} selected={t === armedTag} onRemove={() => remove(t)} />
        ))}
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-label={label}
          aria-expanded={!!listShown}
          aria-controls={listShown ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={listShown && act >= 0 ? optId(act) : undefined}
          data-tag-input
          data-tag-input-open={(variant === "form" && listShown) || undefined}
          value={draft}
          autoComplete="off"
          spellCheck={false}
          placeholder={tags.length ? "" : placeholder}
          onChange={(e) => {
            const v = e.target.value;
            setArmed(null);
            if (!composing.current && SEPARATOR.test(v)) {
              splitCommit(v);
              return;
            }
            setDraft(v);
            setActive(AUTO);
            setListOpen(true);
          }}
          onCompositionStart={() => {
            composing.current = true;
            setArmed(null);
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            const v = e.currentTarget.value;
            if (SEPARATOR.test(v)) splitCommit(v);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setListOpen(false);
            setArmed(null);
          }}
          className="h-6 min-w-[6em] flex-1 bg-transparent px-0.5 text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400"
        />
      </div>
      {/* 读屏提示：退格选中了最后一个标签 */}
      <span className="sr-only" role="status">
        {armedTag ? t.library.tags.input.backspaceAgain(armedTag) : ""}
      </span>
      {list}
    </div>
  );
});

/** 把匹配到的部分加粗 */
function highlight(name: string, qk: string): ReactNode {
  if (!qk) return name;
  const i = name.toLocaleLowerCase().indexOf(qk);
  if (i < 0 || name.toLocaleLowerCase().length !== name.length) return name;
  return (
    <>
      {name.slice(0, i)}
      <span className="font-semibold text-neutral-900">{name.slice(i, i + qk.length)}</span>
      {name.slice(i + qk.length)}
    </>
  );
}
