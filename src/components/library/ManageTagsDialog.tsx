// 管理标签：文库里所有标签及论文数；改名（改成已有的标签时合并为一个）、删除（只从论文上去掉标签，论文保留）。
// 改名、删除后同步更新侧栏的标签筛选。
import { t } from "@/i18n";
import { Trans } from "@/i18n/Trans";
import { useRef, useState } from "react";
import { useLibraryStore } from "@/app/stores/library";
import { findTag, normalizeTag, renameInTags, tagKey, type TagInfo } from "@/lib/tags";
import { deleteTag, renameTag } from "@/services/tagService";
import { Shell } from "./DialogShell";
import { useLibraryData } from "./libraryData";
import { TagChip } from "./TagChips";
import { holdTagName } from "./tagFilterHold";
import { btnDanger, btnGhost, btnPrimary, cx, input } from "./ui";

type Mode = { kind: "rename"; tag: string; draft: string } | { kind: "delete"; tag: string } | null;

const smallBtn = "h-6 rounded px-2 text-[12px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800";

export function ManageTagsDialog({ onClose }: { onClose: () => void }) {
  const { tags } = useLibraryData();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const finish = (message: string) => {
    setMode(null);
    setError(null);
    setNotice(message);
    listRef.current?.focus({ preventScroll: true });
  };

  const rename = async (from: string, draft: string) => {
    const target = normalizeTag(draft);
    if (!target) return setError(t.library.tags.emptyName);
    if (target === from) return finish("");
    const existing = findTag(tags, target);
    const merge = !!existing && tagKey(existing.name) !== tagKey(from);
    // 合并时沿用已有标签的写法
    const to = merge ? existing.name : target;
    setBusy(true);
    // 先改筛选再写库：侧栏的筛选守卫在标签列表变化时会去掉已不存在的标签，写库之后再改就晚了。
    // 写库生效前新名字还不在文库里，暂留它，免得期间别的标签变化让守卫把它去掉
    const st = useLibraryStore.getState();
    const prevFilter = st.tagFilter;
    const nextFilter = renameInTags(prevFilter, from, to);
    const release = holdTagName(to);
    if (nextFilter) st.setTagFilter(nextFilter);
    try {
      const n = await renameTag(from, to);
      finish(merge ? t.library.tags.manage.merged(from, to, n) : t.library.tags.manage.renamed(from, to, n));
    } catch (e) {
      if (nextFilter) st.setTagFilter(prevFilter);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      // 等实时查询把改名后的标签带回来再释放
      window.setTimeout(release, 1000);
    }
  };

  const remove = async (tag: string) => {
    setBusy(true);
    const st = useLibraryStore.getState();
    const prevFilter = st.tagFilter;
    st.setTagFilter(prevFilter.filter((f) => tagKey(f) !== tagKey(tag)));
    try {
      const n = await deleteTag(tag);
      finish(t.library.tags.manage.deleted(tag, n));
    } catch (e) {
      st.setTagFilter(prevFilter);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      title={t.library.tags.manage.title}
      onClose={onClose}
      wide
      description={tags.length ? t.library.tags.manage.summary(tags.length) : undefined}
      onEscapeKeyDown={(e) => {
        // 正在改名或确认删除：Esc 只取消这一步
        if (mode) {
          e.preventDefault();
          setMode(null);
          setError(null);
        }
      }}
    >
      {tags.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-200 px-3 py-4 text-center text-xs leading-relaxed text-neutral-400">
          {t.library.tags.noTags}
        </p>
      ) : (
        <ul ref={listRef} tabIndex={-1} className="-mx-1 mt-3 max-h-[min(56vh,420px)] overflow-y-auto outline-none" aria-label={t.library.tags.manage.listLabel}>
          {tags.map((info) => (
            <TagItem
              key={info.name}
              tag={info}
              all={tags}
              mode={mode?.tag === info.name ? mode : null}
              busy={busy}
              error={mode?.tag === info.name ? error : null}
              onMode={(m) => {
                setMode(m);
                setError(null);
                setNotice(null);
              }}
              onRename={(draft) => void rename(info.name, draft)}
              onDelete={() => void remove(info.name)}
            />
          ))}
        </ul>
      )}
      <div className="mt-4 flex items-center gap-2">
        <p role="status" className="min-w-0 flex-1 truncate text-[12px] text-neutral-500">
          {notice}
        </p>
        <button type="button" className={btnGhost} onClick={onClose}>
          {t.library.tags.manage.done}
        </button>
      </div>
    </Shell>
  );
}

function TagItem(props: {
  tag: TagInfo;
  all: TagInfo[];
  mode: Mode;
  busy: boolean;
  error: string | null;
  onMode: (m: Mode) => void;
  onRename: (draft: string) => void;
  onDelete: () => void;
}) {
  const { tag, all, mode, busy, error, onMode, onRename, onDelete } = props;

  if (mode?.kind === "rename") {
    const target = normalizeTag(mode.draft);
    const existing = target ? findTag(all, target) : undefined;
    const merge = !!existing && tagKey(existing.name) !== tagKey(tag.name);
    return (
      <li className="rounded-md bg-neutral-50 px-2 py-2" data-manage-tag={tag.name}>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(mode.draft);
          }}
        >
          <input
            autoFocus
            aria-label={t.library.tags.manage.newNameLabel(tag.name)}
            value={mode.draft}
            onChange={(e) => onMode({ ...mode, draft: e.target.value })}
            onFocus={(e) => e.currentTarget.select()}
            className={cx(input, "h-7 flex-1")}
          />
          <button type="submit" className={cx(btnPrimary, "h-7 px-2.5")} disabled={busy || !target}>
            {merge ? t.library.tags.manage.merge : t.common.save}
          </button>
          <button type="button" className={cx(btnGhost, "h-7 px-2")} onClick={() => onMode(null)}>
            {t.common.cancel}
          </button>
        </form>
        {error ? (
          <p className="mt-1.5 text-xs text-red-600">{error}</p>
        ) : merge ? (
          <p className="mt-1.5 text-xs text-amber-700">
            {t.library.tags.manage.mergeHint(existing.name, existing.count)}
          </p>
        ) : null}
      </li>
    );
  }

  if (mode?.kind === "delete") {
    return (
      <li className="flex items-center gap-2 rounded-md bg-red-50/60 px-2 py-1.5" data-manage-tag={tag.name}>
        <span className="min-w-0 flex-1 text-[13px] text-neutral-700">
          <Trans text={t.library.tags.manage.deleteConfirm(tag.count)} values={{ tag: <span className="font-medium">{tag.name}</span> }} />
          <span className="text-neutral-400">{t.library.tags.manage.keepPapers}</span>
        </span>
        <button type="button" className={cx(btnGhost, "h-7 px-2")} onClick={() => onMode(null)} autoFocus>
          {t.common.cancel}
        </button>
        <button type="button" className={cx(btnDanger, "h-7 px-2.5")} disabled={busy} onClick={onDelete}>
          {t.common.delete}
        </button>
      </li>
    );
  }

  return (
    <li className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-neutral-50" data-manage-tag={tag.name}>
      <TagChip tag={tag.name} size="sm" style={{ flexShrink: 1, minWidth: 0 }} />
      <span className="flex-1" />
      <span className="shrink-0 text-[12px] tabular-nums text-neutral-400">{t.library.tags.manage.count(tag.count)}</span>
      <button type="button" className={smallBtn} onClick={() => onMode({ kind: "rename", tag: tag.name, draft: tag.name })} aria-label={t.library.tags.manage.renameLabel(tag.name)}>
        {t.common.rename}
      </button>
      <button
        type="button"
        className={cx(smallBtn, "hover:bg-red-50 hover:text-red-600")}
        onClick={() => onMode({ kind: "delete", tag: tag.name })}
        aria-label={t.library.tags.manage.deleteLabel(tag.name)}
      >
        {t.common.delete}
      </button>
    </li>
  );
}
