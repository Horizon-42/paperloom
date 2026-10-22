import { beforeEach, describe, expect, it } from "vitest";
import { MAX_TOASTS, useAnnotationStore } from "@/app/stores/annotation";
import { deleteWithUndo, registerDraft } from "@/components/annotation/actions";
import { db } from "@/db/schema";
import { createAnnotation } from "@/services/annotationService";
import type { SelectionAnchor } from "@/types/models";

const anchor: SelectionAnchor = {
  paperId: "p1",
  page: 1,
  rects: [[72, 700, 200, 712]],
  quote: { exact: "x", prefix: "", suffix: "" },
  fileHash: "h1",
};

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await db.papers.add({ id: "p1", fileHash: "h1", title: "P", authors: [], domainIds: [], pageCount: 1, addedAt: 0 });
  useAnnotationStore.setState({ selected: null, editingId: null, hover: null, toasts: [] });
});

describe("hover is per pane (#12)", () => {
  it("only the pane that set the hover sees it, and only that pane can clear it", () => {
    const st = useAnnotationStore.getState;
    st().setHover("left", "a1");
    expect(st().hover).toEqual({ paneId: "left", id: "a1" });
    // 另一分栏的 mouseleave 不清除左栏的悬停
    st().setHover("right", null);
    expect(st().hover).toEqual({ paneId: "left", id: "a1" });
    st().setHover("right", "a1");
    expect(st().hover).toEqual({ paneId: "right", id: "a1" });
    st().setHover("right", null);
    expect(st().hover).toBeNull();
  });
});

describe("deleteWithUndo (#13)", () => {
  it("keeps one undo per deletion", async () => {
    const a1 = await createAnnotation(anchor, { color: "#fde68a", note: "一" });
    const a2 = await createAnnotation(anchor, { color: "#fde68a", note: "二" });
    await deleteWithUndo(a1.id);
    await deleteWithUndo(a2.id);
    const toasts = useAnnotationStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts.every((t) => t.undo && t.kind === "info")).toBe(true);
    // 撤销第一次删除：只恢复第一条
    await toasts[0].undo!();
    expect((await db.annotations.get(a1.id))?.note).toBe("一");
    expect(await db.annotations.get(a2.id)).toBeUndefined();
    await toasts[1].undo!();
    expect((await db.annotations.get(a2.id))?.note).toBe("二");
  });

  it("saves the unsaved draft before deleting, so undo brings it back", async () => {
    const a = await createAnnotation(anchor, { color: "#fde68a", note: "旧笔记" });
    useAnnotationStore.getState().edit({ paneId: "left", paperId: "p1", id: a.id });
    const unregister = registerDraft(a.id, () => "未保存的草稿  \n");
    await deleteWithUndo(a.id);
    unregister();
    expect(await db.annotations.get(a.id)).toBeUndefined();
    const st = useAnnotationStore.getState();
    expect(st.selected).toBeNull();
    expect(st.editingId).toBeNull();
    await st.toasts[0].undo!();
    expect((await db.annotations.get(a.id))?.note).toBe("未保存的草稿");
  });

  it("shows an error toast instead of throwing when the write fails", async () => {
    const a = await createAnnotation(anchor, { color: "#fde68a" });
    const fail = () => {
      throw new Error("磁盘已满");
    };
    db.annotations.hook("deleting", fail);
    try {
      await expect(deleteWithUndo(a.id)).resolves.toBeUndefined();
    } finally {
      db.annotations.hook("deleting").unsubscribe(fail);
    }
    const [t] = useAnnotationStore.getState().toasts;
    expect(t.kind).toBe("error");
    expect(t.message).toContain("磁盘已满");
    expect(await db.annotations.get(a.id)).toBeDefined();
  });

  it("caps the number of toasts", () => {
    const st = useAnnotationStore.getState;
    for (let i = 0; i < MAX_TOASTS + 2; i++) st().showToast(`t${i}`);
    expect(st().toasts.map((t) => t.message)).toEqual(Array.from({ length: MAX_TOASTS }, (_, i) => `t${i + 2}`));
    st().dismissToast(st().toasts[0].seq);
    expect(st().toasts).toHaveLength(MAX_TOASTS - 1);
  });
});
