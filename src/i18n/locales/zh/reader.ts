// reader 模块的界面文案（中文，是各语言文案的结构来源）：阅读器（标签、分屏、工具栏、页面）与批注。
export default {
  /** 阅读区、分栏 */
  area: {
    empty: "从左侧选择一篇论文",
    paneEmptyFocused: "在左侧点击论文，在此分栏打开",
    paneEmptyUnfocused: "点击此处后，从左侧选择论文在此分栏打开",
    resizePanes: "拖动调整分栏宽度",
  },
  /** 标签栏 */
  tabs: {
    deleted: "（已删除）",
    closeTab: "关闭标签",
    closeTitle: "关闭（中键单击标签也可关闭）",
    openInOtherPane: "在另一侧分栏打开",
    closeOthers: "关闭其他标签",
    split: "左右分屏",
    unsplit: "取消分屏",
  },
  /** 阅读器工具栏 */
  toolbar: {
    zoomOut: "缩小（Ctrl/⌘ -）",
    zoomIn: "放大（Ctrl/⌘ +）",
    zoomLevel: "缩放比例",
    fitWidth: "适合宽度",
    pageNumber: "页码",
  },
  /** PDF 视图、页面 */
  viewer: {
    opening: "正在打开…",
    paperMissing: "论文不存在或已被删除",
    cannotOpen: (reason: string) => `无法打开：${reason}`,
    pdfMissing: "缺少 PDF 文件，请重新导入该文件",
    pdfChanging: "论文的 PDF 在提取全文期间反复变化",
    pageRenderFailed: "本页渲染失败",
    noTextBadge: "无文字层",
    noTextTitle: "此页无文字层，无法选字",
    scannedBadge: "扫描件",
    scannedTitle: "扫描件：标注精度取决于 OCR",
  },
  /** 高亮颜色名 */
  colors: {
    yellow: "黄色",
    green: "绿色",
    blue: "蓝色",
    pink: "粉色",
    purple: "紫色",
  },
  /** "第 3 页" */
  page: (n: number) => `第 ${n} 页`,
  /** 选中文字后的工具栏 */
  selection: {
    toolbar: "选区工具栏",
    highlight: (color: string) => `${color}高亮`,
    writeNote: "写笔记",
    makeTerm: "设为术语",
    saveFailed: "保存高亮失败",
  },
  /** 朗读（D19，浏览器自带的语音合成） */
  readAloud: {
    button: "朗读",
    buttonTitle: "朗读选中的文字（浏览器自带的语音）",
    barLabel: "朗读",
    reading: "正在朗读",
    paused: "已暂停",
    pause: "暂停",
    resume: "继续",
    stop: "停止朗读",
    rateTitle: "语速（点击切换）",
    rateLabel: (rate: number) => `语速 ${rate} 倍，点击切换`,
  },
  /** 页边角注卡片、色条 */
  card: {
    changeColor: "更改颜色",
    colorTitle: (color: string) => `颜色：${color}，点击更改`,
    changeColorFailed: "更改颜色失败",
    relocated: "已重新定位",
    relocatedTitle: "换过 PDF 文件后按原文重新定位",
    editNote: "编辑笔记",
    deleteAnnotation: "删除批注",
    addNote: "添加笔记…",
    notePlaceholder: "写笔记（支持 Markdown 和 $公式$）",
    noteHint: "⌘Enter 保存 · Esc 取消",
    saveNoteFailed: "保存笔记失败",
    openTerm: "打开术语",
    selectAnnotation: "选中批注",
    /** 色条的提示：原文开头 + 在画布上或有连线 */
    onCanvasTitle: (quote: string) => `${quote}（在画布上或有连线，点击查看）`,
  },
  /** 底部提示条 */
  toast: {
    deleted: "已删除批注",
    deleteFailed: "删除批注失败",
    undoFailed: "撤销失败",
    dismiss: "关闭提示",
  },
  /** 批注列表 */
  list: {
    heading: "批注",
    count: (n: number) => `${n} 条`,
    filterByField: "按领域筛选",
    allFields: "全部领域",
    filterByColor: "按颜色筛选",
    search: "搜索原文或笔记",
    clearFilters: "清除筛选",
    noMatches: "没有符合条件的批注",
    empty: "还没有批注。在论文中选中文字即可高亮和写笔记。",
    orphaned: "未定位",
    orphanedHint: "替换 PDF 文件后，这些批注的原文在新文件中找不到了。可以删除，或在原文中重新划线后删除旧批注。",
    noNote: "无笔记",
  },
  /** 侧栏全局搜索的批注分组 */
  search: {
    group: "批注",
  },
  /** 替换 PDF 文件对话框 */
  replace: {
    title: "替换 PDF 文件",
    intro: '用新文件（例如 arXiv 的新版本）替换这篇论文的 PDF。批注会按原文重新定位；找不到原文的批注标为"未定位"，可在批注列表中查看和处理。',
    busy: "正在替换并重新定位批注…",
    choose: "点击选择新的 PDF 文件",
    viewOrphaned: "查看未定位批注",
    done: "完成",
    unchanged: "所选文件与当前 PDF 相同，无需替换。",
    conflict: (title: string) => `这个文件已被另一篇论文「${title}」使用，不能用来替换。`,
    failed: (reason: string) => `替换失败：${reason}`,
    replacedReanchorFailed: (pages: number) => `已替换为新文件（${pages} 页）。批注暂时未能重新定位，下次打开这篇论文时会自动重试。`,
    replacedNothing: (pages: number) => `已替换为新文件（${pages} 页）。这篇论文没有需要重新定位的批注。`,
    replacedSummary: (pages: number, relocated: number, orphaned: number) =>
      `已替换为新文件（${pages} 页）。${relocated} 条批注已重新定位${orphaned ? `，${orphaned} 条未能在新文件中找到原文，已放入"未定位"` : ""}。`,
    /** 替换失败的原因 */
    errors: {
      unreadable: "无法读取文件",
      notPdf: "不是 PDF 文件",
      paperMissing: "论文不存在",
      encrypted: "PDF 已加密，暂不支持",
      corrupt: "文件已损坏或不是有效的 PDF",
      noPages: "PDF 没有页面",
    },
  },
};
