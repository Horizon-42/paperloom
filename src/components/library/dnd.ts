// 侧栏内部拖放用的 dataTransfer 类型
export const PAPER_MIME = "application/x-paperlens-paper";
export const DOMAIN_MIME = "application/x-paperlens-domain";

export function hasType(e: { dataTransfer: DataTransfer | null }, type: string): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes(type);
}

/** 从系统拖入的文件（而不是页面内元素） */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return hasType(e, "Files") && !hasType(e, PAPER_MIME) && !hasType(e, DOMAIN_MIME);
}
