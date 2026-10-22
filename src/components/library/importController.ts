// 导入队列：把选择/拖入的文件依次交给 paperService，进度和结果写进 library store
import { selectedDomainId, useLibraryStore, type ImportJobItem } from "@/app/stores/library";
import { importPdf, type ImportOutcome } from "@/services/paperService";

interface QueueItem {
  file: File;
  domainId: string | null;
}

const queue: QueueItem[] = [];
let running = false;

function toItem(o: ImportOutcome): ImportJobItem {
  if (o.status === "failed") return { status: o.status, fileName: o.fileName, error: o.error };
  return { status: o.status, fileName: o.fileName, paperId: o.paper.id, title: o.paper.title };
}

/** 加入导入队列。归入的领域取加入队列时侧栏选中的领域 */
export function enqueueImport(files: File[]): void {
  if (!files.length) return;
  const store = useLibraryStore.getState();
  const domainId = selectedDomainId(store.selection);
  queue.push(...files.map((file) => ({ file, domainId })));
  store.setImportJob((prev) =>
    prev && !prev.finished
      ? { ...prev, total: prev.total + files.length }
      : { total: files.length, done: 0, current: null, items: [], finished: false },
  );
  if (!running) void drain();
}

async function drain() {
  running = true;
  const store = useLibraryStore.getState;
  try {
    while (queue.length) {
      const { file, domainId } = queue.shift()!;
      store().setImportJob((j) => j && { ...j, current: file.name });
      const outcome = await importPdf(file, { domainId });
      store().setImportJob((j) => j && { ...j, done: j.done + 1, items: [...j.items, toItem(outcome)] });
    }
  } finally {
    running = false;
    store().setImportJob((j) => j && { ...j, current: null, finished: true });
  }
  // 只有一篇新增或一篇重复时，直接在列表中定位它
  const items = store().importJob?.items ?? [];
  const added = items.filter((i) => i.status === "added");
  const dups = items.filter((i) => i.status === "duplicate");
  const target = added.length === 1 ? added[0] : added.length === 0 && dups.length === 1 ? dups[0] : null;
  if (target?.paperId) store().revealPaper(target.paperId);
}

/** FileList → 数组。不在这里过滤非 PDF：交给服务检查文件头，并在结果汇总里给出失败原因 */
export function filesFromList(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}
