// 术语弹窗的交互控制：悬停预览计时、页面卸载时收起弹窗、跳到某一处出现位置。
// 悬停状态跨页面（指针可能从一页移到另一页），所以放在模块级而不是某个覆盖层组件里。
import { useReaderStore, type PaneId } from "@/app/stores/reader";
import { useTermUiStore, type TermAnchor } from "@/app/stores/termUi";
import { getPageEntry } from "./pages";
import type { OccurrencePos } from "./logic/occurrences";

/** 悬停多久显示只读预览（开发文档 5.4） */
export const HOVER_DELAY = 400;
/** 指针离开下划线后多久收起预览（留出移进预览卡片的时间） */
const CLOSE_DELAY = 250;

export interface HoverTarget {
  anchor: TermAnchor;
  termIds: string[];
}

export const anchorKey = (a: Pick<TermAnchor, "paneId" | "paperId" | "page" | "start">) => `${a.paneId}|${a.paperId}|${a.page}|${a.start}`;

let current: HoverTarget | null = null;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let overPopover = false;

/** 指针移到某处命中上（或移开：null） */
export function hoverMatch(t: HoverTarget | null) {
  if ((t && current && anchorKey(t.anchor) === anchorKey(current.anchor)) || (!t && !current)) return;
  current = t;
  clearTimeout(openTimer);
  if (!t) {
    scheduleClosePreview();
    return;
  }
  const st = useTermUiStore.getState();
  if (st.popover?.mode === "edit") return;
  if (st.popover?.mode === "preview" && anchorKey(st.popover.anchor) === anchorKey(t.anchor)) {
    clearTimeout(closeTimer);
    return;
  }
  openTimer = setTimeout(() => {
    const s = useTermUiStore.getState();
    if (s.popover?.mode === "edit" || !current || anchorKey(current.anchor) !== anchorKey(t.anchor)) return;
    s.openPopover({ mode: "preview", termIds: t.termIds, activeTermId: t.termIds[0], anchor: t.anchor });
  }, HOVER_DELAY);
}

/** 按下指针（开始点击或拖选）时取消待显示的预览 */
export function cancelHover() {
  current = null;
  clearTimeout(openTimer);
}

function scheduleClosePreview() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    const s = useTermUiStore.getState();
    if (s.popover?.mode === "preview" && !overPopover && !current) s.closePopover();
  }, CLOSE_DELAY);
}

/** 指针进出弹窗卡片 */
export function popoverPointer(inside: boolean) {
  overPopover = inside;
  if (inside) clearTimeout(closeTimer);
  else scheduleClosePreview();
}

/** 覆盖层卸载（页面离开渲染范围、切换标签）：弹窗锚在这页上且不在导航途中时收起 */
export function pageUnmounted(paneId: PaneId, paperId: string, page: number) {
  const { popover, flash, closePopover } = useTermUiStore.getState();
  if (!popover) return;
  const a = popover.anchor;
  if (a.paneId !== paneId || a.paperId !== paperId || a.page !== page) return;
  if (flash?.movePopover) return;
  closePopover();
}

/**
 * 跳到当前论文里某个术语的一处出现位置：目标页已渲染时直接滚动定位，否则先跳到该页，
 * 页面就绪后由覆盖层闪烁并滚动到可见。movePopover 为 true 时弹窗随之移过去。
 */
export function goToOccurrence(paneId: PaneId, paperId: string, termId: string, pos: OccurrencePos, movePopover: boolean) {
  const entry = getPageEntry(paneId, paperId, pos.page);
  if (!entry?.ctx.text) useReaderStore.getState().jumpTo({ paperId, page: pos.page, paneId });
  expireFlash(useTermUiStore.getState().requestFlash({ paneId, paperId, page: pos.page, termId, range: { start: pos.start, end: pos.end }, movePopover }));
}

/** 目标页迟迟没有就绪（如文档打开失败）时放弃这次定位，弹窗不再保持隐藏 */
const FLASH_TIMEOUT = 10_000;
function expireFlash(seq: number) {
  setTimeout(() => useTermUiStore.getState().clearFlash(seq), FLASH_TIMEOUT);
}

/** 打开另一篇（或同一篇）论文并闪烁该页上这个术语的第一处 */
export function openPaperAtTerm(paperId: string, page: number, termId: string) {
  useReaderStore.getState().jumpTo({ paperId, page });
  const req = useReaderStore.getState().jumpRequest;
  if (!req) return;
  expireFlash(useTermUiStore.getState().requestFlash({ paneId: req.paneId, paperId, page, termId }));
}
