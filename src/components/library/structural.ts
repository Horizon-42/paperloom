// 结构共享：实时查询每次都返回新对象，这里让内容没变的记录沿用上一次的引用，
// 下游的 memo（PaperRow 等）才能真正跳过渲染。

/** 浅比较两条记录：值相同（===），或都是元素逐个相同的数组 */
export function sameRecord(a: object, b: object): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (va === vb) continue;
    if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  }
  return true;
}

export interface Shared<T> {
  list: T[];
  byId: Map<string, T>;
}

/** 以 id 对齐新旧列表，未变化的记录沿用旧引用；整体都没变时直接返回 prev */
export function shareById<T extends { id: string }>(prev: Shared<T> | null, next: T[]): Shared<T> {
  const byId = new Map<string, T>();
  let unchanged = !!prev && prev.list.length === next.length;
  const list = next.map((item, i) => {
    const old = prev?.byId.get(item.id);
    const v = old && sameRecord(old, item) ? old : item;
    byId.set(item.id, v);
    if (unchanged && prev!.list[i] !== v) unchanged = false;
    return v;
  });
  return unchanged ? prev! : { list, byId };
}
