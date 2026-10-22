// 虚拟列表：只渲染可视区域及前后 overscan 行。行高可以固定，也可以按行给出（前缀和 + 二分查找）。
// 根元素就是滚动容器，转发 ref 和其余属性（可直接作为 Radix Trigger 的 asChild 子元素）。
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type UIEvent,
} from "react";

export interface VirtualListHandle {
  /** 把第 index 行滚动到可视区域内（已可见则不动） */
  scrollToIndex(index: number): void;
}

/** 每行占用的高度（含行间距），像素；函数形式按行计算，应是稳定的引用（模块级函数） */
export type RowHeight<T> = number | ((item: T, index: number) => number);

export interface VirtualListProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  items: T[];
  rowHeight: RowHeight<T>;
  getKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  overscan?: number;
  /** 行区域左右内边距 */
  gutter?: number;
  /** 列表末尾留白 */
  paddingBottom?: number;
  handleRef?: Ref<VirtualListHandle>;
  /** 渲染在行区域之后（如空状态） */
  footer?: ReactNode;
}

/** 行的纵向布局 */
export interface RowLayout {
  count: number;
  /** 所有行的总高度 */
  total: number;
  top(index: number): number;
  height(index: number): number;
  /** 纵坐标 y 落在哪一行（超出范围时取首行/末行；没有行时为 0） */
  indexAt(y: number): number;
}

export function buildRowLayout<T>(items: readonly T[], rowHeight: RowHeight<T>): RowLayout {
  const n = items.length;
  if (typeof rowHeight === "number") {
    const h = rowHeight;
    return {
      count: n,
      total: n * h,
      top: (i) => i * h,
      height: () => h,
      indexAt: (y) => (n ? Math.min(n - 1, Math.max(0, Math.floor(y / h))) : 0),
    };
  }
  // offsets[i] 是第 i 行的顶部，offsets[n] 是总高度
  const offsets = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + rowHeight(items[i], i);
  return {
    count: n,
    total: offsets[n],
    top: (i) => offsets[i],
    height: (i) => offsets[i + 1] - offsets[i],
    indexAt: (y) => {
      if (!n) return 0;
      // 最后一个 offsets[i] <= y 的 i
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

function VirtualListInner<T>(props: VirtualListProps<T>, ref: ForwardedRef<HTMLDivElement>) {
  const {
    items,
    rowHeight,
    getKey,
    renderItem,
    overscan = 6,
    gutter = 8,
    paddingBottom = 12,
    handleRef,
    footer,
    onScroll,
    ...rest
  } = props;
  const el = useRef<HTMLDivElement | null>(null);
  const layout = useMemo(() => buildRowLayout(items, rowHeight), [items, rowHeight]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [first, setFirst] = useState(0); // 第一可见行；只有跨行时才触发重新渲染
  const [viewport, setViewport] = useState(0);

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      el.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const syncFirst = useCallback(() => {
    const node = el.current;
    if (node) setFirst(layoutRef.current.indexAt(node.scrollTop));
  }, []);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const measure = () => {
      setViewport(node.clientHeight);
      syncFirst();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [syncFirst]);

  // 行高或行数变了：按新布局重算第一可见行
  useLayoutEffect(syncFirst, [layout, syncFirst]);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToIndex(index) {
        const node = el.current;
        const L = layoutRef.current;
        if (!node || index < 0 || index >= L.count) return;
        const top = L.top(index);
        const bottom = top + L.height(index);
        if (top < node.scrollTop) node.scrollTop = top;
        else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight;
        syncFirst();
      },
    }),
    [syncFirst],
  );

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    setFirst(layoutRef.current.indexAt(e.currentTarget.scrollTop));
    onScroll?.(e);
  };

  const n = items.length;
  const firstRow = Math.min(first, Math.max(0, n - 1));
  // 第一可见行可能只露出一部分：可视区下沿不超过它的底部 + 视口高度
  const lastVisible = n ? layout.indexAt(layout.top(firstRow) + layout.height(firstRow) + viewport) : 0;
  const start = Math.max(0, firstRow - overscan);
  const end = Math.min(n, lastVisible + 1 + overscan);
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const item = items[i];
    rows.push(
      <div
        key={getKey(item)}
        style={{ position: "absolute", top: layout.top(i), left: gutter, right: gutter, height: layout.height(i) }}
      >
        {renderItem(item, i)}
      </div>,
    );
  }

  return (
    <div ref={setRefs} onScroll={handleScroll} {...rest}>
      <div style={{ position: "relative", height: layout.total + (n ? paddingBottom : 0) }}>{rows}</div>
      {footer}
    </div>
  );
}

export const VirtualList = forwardRef(VirtualListInner) as <T>(
  props: VirtualListProps<T> & { ref?: Ref<HTMLDivElement> },
) => ReactElement;
