// 应用外壳：启动、找不到项目页。
export default {
  notFound: {
    pageTitle: "找不到项目 · Paperloom",
    heading: (id: string) => `找不到项目「${id}」`,
    needsMigration: "数据目录还是旧版结构，迁移前只有原来的项目可以打开。",
    maybeDeleted: "它可能已被删除，或者是在另一个浏览器（没有本地服务时）里新建的。",
    localDataLeft: "本浏览器里还留着这个项目的数据。",
    exportLocal: "导出本浏览器中这个项目的数据（JSON）",
    exported: (file: string) => `已下载 ${file}：可以在任一项目的「数据与备份」里导入它`,
    localEmpty: "本浏览器中这个项目的数据库是空的",
    exportFailed: (reason: string) => `导出失败：${reason}`,
    open: (name: string) => `打开「${name}」`,
  },
};
