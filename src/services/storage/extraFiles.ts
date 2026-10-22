// 镜像到 data/ 的附加文件（例如画布导出的 JSON Canvas）。
// 各模块在启动时注册一个生成函数；存储模块保存时调用它们，把结果写到 data/<group>/ 下，
// 并删除该目录中本次未生成的旧文件。

export interface ExtraFile {
  /** 相对 data/<group>/ 的文件名，如 "方法对比.canvas"；不能包含 ".." 或以 "/" 开头 */
  name: string;
  content: string;
}

export type ExtraFileProducer = () => Promise<ExtraFile[]>;

const producers = new Map<string, ExtraFileProducer>();

/** group 即 data/ 下的子目录名（如 "canvas"），同名重复注册时后者覆盖前者 */
export function registerExtraFiles(group: string, producer: ExtraFileProducer): void {
  producers.set(group, producer);
}

export function extraFileGroups(): [string, ExtraFileProducer][] {
  return [...producers];
}
