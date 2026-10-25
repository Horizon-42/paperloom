// 各模块共用的文案：通用按钮、时间、语言切换。
const pad = (n: number) => String(n).padStart(2, "0");

export default {
  appName: "Paperloom",
  /** 页面标题："<项目名> · Paperloom" */
  pageTitle: (name: string) => `${name} · Paperloom`,
  ok: "确定",
  cancel: "取消",
  close: "关闭",
  save: "保存",
  delete: "删除",
  remove: "移除",
  rename: "重命名",
  edit: "编辑",
  create: "新建",
  undo: "撤销",
  retry: "重试",
  loading: "加载中…",
  unknown: "未知",
  /** 列表的连接：["a", "b", "c"] → "a、b、c" */
  list: (items: readonly string[]) => items.join("、"),
  /** 名称加引号 */
  quote: (s: string) => `「${s}」`,
  /** 错误信息前面加上说明："导出失败：<原因>" */
  failedWith: (what: string, reason: string) => `${what}：${reason}`,
  language: {
    label: "界面语言",
    switchTitle: "切换界面语言",
    /** 其他标签页改了界面语言时，本标签页的提示（用新语言显示） */
    changedElsewhere: "界面语言已在其他标签页改为中文。",
    reload: "重新加载",
  },
  time: {
    justNow: "刚刚",
    minutesAgo: (n: number) => `${n} 分钟前`,
    hoursAgo: (n: number) => `${n} 小时前`,
    /** 较早的时间：同一年省略年份，如 "10月20日 14:05" */
    dateTime: (d: Date, withYear: boolean) =>
      `${withYear ? `${d.getFullYear()}年` : ""}${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  },
  /** 全局撤销 / 重做（D20） */
  undoRedo: {
    undone: "已撤销（⌘/Ctrl + Shift + Z 重做）",
    redone: "已重做",
    nothingToUndo: "没有可撤销的操作",
    nothingToRedo: "没有可重做的操作",
    undoFailed: "撤销失败",
    redoFailed: "重做失败",
  },
};
