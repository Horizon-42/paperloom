// 标签筛选的暂留名单（只是界面状态）：管理标签对话框改名时先把筛选改成新名字、再写库，
// 写库生效前新名字还不在文库的标签里；期间其他标签变化触发筛选守卫（LibrarySidebar）时，不去掉这些名字。
import { tagKey } from "@/lib/tags";

const held = new Map<string, number>();

/** 暂留一个标签名；返回释放函数（可重复调用） */
export function holdTagName(name: string): () => void {
  const k = tagKey(name);
  held.set(k, (held.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (held.get(k) ?? 1) - 1;
    if (n > 0) held.set(k, n);
    else held.delete(k);
  };
}

export function isTagNameHeld(name: string): boolean {
  return held.has(tagKey(name));
}
