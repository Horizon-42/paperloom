// 导入队列：把选择/拖入的文件依次交给 paperService，进度和结果写进 library store
import { importTargetDomainId, useLibraryStore, type ImportJobItem } from "@/app/stores/library";
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

/** 加入导入队列。归入的领域：给了 domainId 就用它（null = 不归类），否则取加入队列时侧栏选中的领域 */
export function enqueueImport(files: File[], target?: { domainId: string | null }): void {
  if (!files.length) return;
  const store = useLibraryStore.getState();
  const domainId = target ? target.domainId : importTargetDomainId(store);
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

/**
 * 领域树已经把放下的文件导入到了某一行对应的领域。窗口上的拖入处理据此跳过；
 * 不用 defaultPrevented 判断：编辑器（CodeMirror）等也会对放下的文件 preventDefault
 */
const handledDrops = new WeakSet<Event>();
export const markDropHandled = (e: Event) => void handledDrops.add(e);
export const isDropHandled = (e: Event) => handledDrops.has(e);

let picker: HTMLInputElement | null = null;
let pickTarget: { domainId: string; onPicked?: () => void } | null = null;

/**
 * 打开文件选择框，选好的 PDF 导入到指定领域（领域行上的导入按钮）。必须在点击事件里同步调用。
 * 领域行在虚拟列表里随时可能被卸载，所以共用一个挂在 body 上的 input，不放在行里
 */
export function pickFilesForImport(domainId: string, onPicked?: () => void): void {
  if (!picker) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = true;
    input.hidden = true;
    input.dataset.testid = "import-input-domain";
    input.addEventListener("change", () => {
      const files = filesFromList(input.files);
      const target = pickTarget;
      input.value = "";
      if (!files.length || !target) return;
      enqueueImport(files, { domainId: target.domainId });
      target.onPicked?.();
    });
    document.body.appendChild(input);
    picker = input;
  }
  pickTarget = { domainId, onPicked };
  picker.click();
}
