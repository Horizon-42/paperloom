// 论文标签的写操作：单篇增删、整库重命名/删除。规范化规则见 lib/tags.ts。
import { db } from "@/db/schema";
import { getPaper, updatePaper } from "@/db/repo/papers";
import { normalizeTag, normalizeTags, paperTags, renameInTags, tagKey } from "@/lib/tags";

/** 没有标签时删掉字段，与 lib/tags.ts、存储格式校验一致 */
const tagsField = (tags: string[]) => (tags.length ? tags : undefined);

/** 整体替换一篇论文的标签 */
export async function setPaperTags(paperId: string, tags: string[]): Promise<void> {
  await updatePaper(paperId, { tags: tagsField(normalizeTags(tags)) });
}

/** 给论文加标签（已有的跳过，追加在末尾）；返回实际新增的个数 */
export async function addPaperTags(paperId: string, tags: string[]): Promise<number> {
  return db.transaction("rw", db.papers, async () => {
    const p = await getPaper(paperId);
    if (!p) return 0;
    const before = paperTags(p);
    const next = normalizeTags([...before, ...tags]);
    if (next.length === before.length) return 0;
    await updatePaper(paperId, { tags: next });
    return next.length - before.length;
  });
}

/** 从论文上去掉一个标签（不区分大小写） */
export async function removePaperTag(paperId: string, tag: string): Promise<void> {
  const k = tagKey(tag);
  await db.transaction("rw", db.papers, async () => {
    const p = await getPaper(paperId);
    if (!p) return;
    const before = paperTags(p);
    const next = before.filter((t) => t.toLocaleLowerCase() !== k);
    if (next.length !== before.length) await updatePaper(paperId, { tags: tagsField(next) });
  });
}

/**
 * 在所有论文上把标签 from 改名为 to（也可以只改大小写）；to 已存在的论文上合并为一个。
 * 返回受影响的论文数。to 规范化后为空时抛错。
 */
export async function renameTag(from: string, to: string): Promise<number> {
  const target = normalizeTag(to);
  if (!target) throw new Error("标签名不能为空");
  return db.transaction("rw", db.papers, async () => {
    let n = 0;
    await db.papers
      .filter((p) => !!p.tags?.length)
      .modify((p) => {
        const next = renameInTags(paperTags(p), from, target);
        if (!next) return;
        p.tags = next;
        n++;
      });
    return n;
  });
}

/** 从所有论文上删掉一个标签；返回受影响的论文数 */
export async function deleteTag(tag: string): Promise<number> {
  const k = tagKey(tag);
  return db.transaction("rw", db.papers, async () => {
    let n = 0;
    await db.papers
      .filter((p) => !!p.tags?.some((t) => t.toLocaleLowerCase() === k))
      .modify((p) => {
        const next = paperTags(p).filter((t) => t.toLocaleLowerCase() !== k);
        if (next.length) p.tags = next;
        else delete p.tags;
        n++;
      });
    return n;
  });
}
