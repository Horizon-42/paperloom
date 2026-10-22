// canvas 模块的界面文案（中文，是各语言文案的结构来源）：笔记画布、连线、页边角注上的画布标记、JSON Canvas 导出。
export default {
  /** 新建画布时自动起的名字。按当时的界面语言生成，存进数据库后就是数据 */
  defaultBoardName: "未命名画布",
  /** 默认名已被占用时加序号："未命名画布 2" */
  numberedBoardName: (base: string, n: number) => `${base} ${n}`,
  loading: "正在加载画布…",
  /** 并列的名称（别名、关联领域） */
  join: (items: readonly string[]) => items.join("、"),

  /** 连线关系（Link.relation 的取值 → 名称） */
  relations: {
    supports: "支持",
    contradicts: "反驳",
    extends: "扩展",
    compares: "对比",
    partOf: "属于",
    custom: "自定义",
  },

  /** 画布上的条目（批注、术语、论文、自由笔记） */
  entity: {
    kinds: {
      annotation: "批注",
      term: "术语",
      paper: "论文",
      note: "笔记",
    },
    deleted: {
      annotation: "已删除的批注",
      term: "已删除的术语",
      paper: "已删除的论文",
      note: "已删除的笔记",
    },
    deletedItem: "已删除的条目",
    noQuote: "（无原文）",
    emptyNote: "（空笔记）",
    unknownPaper: "未知论文",
    /** 批注出处："<论文> · 第 3 页" */
    source: (paper: string, page: number) => `${paper} · 第 ${page} 页`,
    /** 作者列表截断后的后缀 */
    etAl: " 等",
  },

  /** 服务层抛出、会显示在界面上的错误 */
  errors: {
    emptyBoardName: "画布名称不能为空",
    boardMissing: "画布不存在",
    entityDeleted: "条目已被删除",
    selfLink: "不能连到自身",
  },

  /** 一块画布都没有时 */
  empty: {
    title: "还没有画布",
    body: "读完后在画布上整理批注：把批注、术语和论文拖进来，用带关系的连线连成网络。同一批笔记可以按不同主题整理成多块画布。",
    create: "新建画布",
  },

  /** 从其他模块跳到画布但一块画布都没有 */
  noBoardsToast: "还没有画布，请先在「画布」里新建一块",

  toolbar: {
    switchBoard: "切换画布",
    boardsHeading: "画布（最近修改的在前）",
    newBoardMenu: "新建画布…",
    rename: "重命名画布",
    renameMenu: "重命名…",
    deleteMenu: "删除画布…",
    domainsTitle: "关联领域：收件箱默认按这些领域筛选",
    domains: "关联领域",
    domainsHeading: "这块画布关联的领域",
    noDomains: "还没有领域",
    saveFailed: "保存失败",
    nodeCount: (n: number) => `${n} 个节点`,
    fitTitle: "显示全部节点",
    fit: "全部",
    exportTitle: "导出为 Obsidian 可打开的 JSON Canvas 文件",
    export: "导出 .canvas",
    exportFailed: "导出失败",
    more: "更多操作",
  },

  dialogs: {
    newBoard: "新建画布",
    create: "新建",
    renameBoard: "重命名画布",
    nameRequired: "名称不能为空",
    namePlaceholder: "画布名称，例如：方法对比",
    nameLabel: "画布名称",
    readFailed: "读取画布失败",
    deleteTitle: (name: string) => `删除画布「${name}」？`,
    deleteBody: (nodes: number) => `画布上的 ${nodes} 个节点会被移除。批注、术语、论文和连线都不受影响，连线仍会显示在其他画布和「相关笔记」里。`,
    orphanLegend: (n: number) => `有 ${n} 条自由笔记只在这块画布上，且没有连线`,
    keepOrphans: "保留，放回「未整理」",
    deleteOrphans: "一并删除这些笔记",
    irreversible: "此操作无法撤销。",
    deleteConfirm: "删除画布",
    deleted: (name: string, notes: number) => (notes ? `已删除画布「${name}」和 ${notes} 条笔记` : `已删除画布「${name}」`),
    deleteFailed: "删除画布失败",
  },

  sidebar: {
    label: "画布素材",
    inbox: "未整理",
    search: "搜索添加",
    newNoteTitle: "在画布中央新建自由笔记（也可双击画布空白处）",
    newNote: "笔记",
    scopeLabel: "收件箱范围",
    scopeAnywhere: "不在任何画布上",
    scopeBoard: "不在本画布上",
    domainFilter: "按领域筛选",
    allDomains: "全部领域",
    boardDomains: "本画布关联的领域",
    paperFilter: "按论文筛选",
    allPapers: "全部论文",
    colorFilter: "按颜色筛选",
    clear: "清除",
    countAnywhere: (n: number) => `${n} 条未整理`,
    countBoard: (n: number) => `${n} 条不在本画布上`,
    dragHint: "拖到画布上",
    hiddenNotes: (n: number) => `另有 ${n} 条自由笔记被论文/颜色筛选隐藏`,
    showMore: (more: number, total: number) => `再显示 ${more} 条（共 ${total} 条）`,
    noMatch: "没有符合条件的条目",
    boardHasAll: "这块画布已包含所有批注和笔记。",
    allPlaced: "所有批注都已放到画布上。阅读时新建的批注会自动出现在这里；整理另一块画布时可切换到「不在本画布上」。",
    freeNote: "自由笔记 · 不在任何画布上",
    placeCenter: "放到画布中央",
    place: "放到画布",
    jump: "跳到原文",
    searchPlaceholder: "搜索术语、批注、论文、笔记…",
    searchLabel: "搜索要添加的条目",
    searchHint: "输入关键词，把术语、批注、整篇论文或已有笔记拖到画布上。",
    noTerms: "还没有术语",
    noResults: "没有匹配的条目",
    recentTerms: "最近的术语",
    locateTitle: "已在这块画布上，点击定位",
    locate: "定位",
  },

  board: {
    emptyHint: {
      drag: "从左侧把批注、术语或论文拖到这里，",
      newNote: "或双击空白处新建一条笔记。",
      connect: "从节点边缘的圆点拖到另一个节点即可连线。",
    },
    alreadyHere: "已在这块画布上，已定位到该节点",
    notHere: "这块画布上没有该条目",
    placeFailed: "放到画布失败",
    newNoteFailed: "新建笔记失败",
    savePositionFailed: "保存位置失败",
    saveSizeFailed: "保存大小失败",
    removed: (n: number) => (n === 1 ? "已移出画布（条目和连线都保留）" : `已移出 ${n} 个节点（条目和连线都保留）`),
    removeFailed: "移出画布失败",
    paperNoAnnotations: "这篇论文还没有批注",
    paperAllPlaced: "这篇论文的批注都已在这块画布上",
    annotationsAdded: (n: number) => `已放入 ${n} 条批注`,
    addAnnotationsFailed: "放入批注失败",
    noteDeleted: "已删除笔记",
    deleteNoteFailed: "删除笔记失败",
    linksDeleted: (n: number) => (n === 1 ? "已删除连线（所有画布中都已移除）" : `已删除 ${n} 条连线（所有画布中都已移除）`),
    /** 撤销删除连线时，有的连线一端已不存在 */
    linksRestored: (n: number) => (n ? `恢复了 ${n} 条，其余连线的一端已被删除` : "无法恢复：连线的一端已被删除"),
    deleteLinksFailed: "删除连线失败",
    linkExists: "这条连线已存在，已选中它",
    createLinkFailed: "新建连线失败",
    linkMerged: "与已有的连线完全相同，已合并为一条",
    updateLinkFailed: "修改连线失败",
    deleteNoteTitle: "删除这条笔记？",
    deleteNoteBody: (links: number) =>
      `笔记内容会被删除，所有画布上的这张卡片${links ? `和它的 ${links} 条连线` : ""}也会一起删除。 只想从这块画布上拿掉的话，请用「移出画布」。`,
    deleteNoteConfirm: "删除笔记",
    deleteLinksTitle: (n: number) => (n === 1 ? "删除这条连线？" : `删除 ${n} 条连线？`),
    deleteLinksBody: "连线是全局的：删除后会从所有画布和术语弹窗的「相关笔记」中一起消失。两端的条目不受影响。",
    deleteLinksConfirm: "删除连线",
  },

  /** 新建连线 / 点击连线时的关系选择浮层 */
  picker: {
    create: "新建连线",
    edit: "修改连线",
    reverse: "调换方向",
    relationGroup: "关系",
    customPlaceholder: "关系文字（必填）",
    notePlaceholder: "备注（可选）",
    labelAria: "关系文字",
    customNeedsText: "自定义关系需要填写文字",
    deleteButton: "删除连线…",
    submitCreate: "连线",
    deleteTitle: "删除这条连线？",
    /** {all}、{related} 是加粗的 allBoards、relatedNotes */
    deleteBody: "连线是全局的：删除后会从{all}和术语弹窗的{related}中一起消失。两端的条目不受影响。",
    allBoards: "所有画布",
    relatedNotes: "「相关笔记」",
    deleteConfirm: "删除连线",
  },

  /** 连线上关系文字的提示 */
  edgeTitle: (text: string) => `${text}（点击修改或删除）`,

  node: {
    externalTitle: (n: number) => `还有 ${n} 条连线的另一端不在这块画布上`,
    externalLabel: (n: number) => `还有 ${n} 条连线不在本画布上`,
    externalHeading: "另一端不在这块画布上的连线",
    placeHere: "放到这块画布上",
    place: "放到画布",
    remove: "移出画布",
    editorHint: "⌘Enter 保存 · Esc 取消",
    termSource: "批注 · 术语出处",
    orphaned: "未定位",
    orphanedTitle: "换过 PDF 文件后找不到原文，跳转只能到原来的页",
    editNote: "编辑笔记",
    jump: "跳到原文",
    annotationPlaceholder: "写笔记（支持 Markdown 和 $公式$）",
    addNote: "添加笔记…",
    saveNoteFailed: "保存笔记失败",
    editTerm: "编辑术语",
    noNote: "暂无笔记",
    addPaperAnnotations: "放入这篇论文的全部批注",
    openPaper: "打开论文",
    deleteNote: "删除笔记",
    notePlaceholder: "写点什么（支持 Markdown 和 $公式$）",
    writeSomething: "写点什么…",
  },

  /** PDF 页边角注上的画布标记 */
  badge: {
    onBoards: (n: number) => `在 ${n} 块画布上`,
    notPlaced: "未放到画布上",
    links: (n: number) => `${n} 条连线`,
    noLinks: "没有连线",
    /** "在 2 块画布上 · 3 条连线" */
    summary: (parts: readonly string[]) => parts.join(" · "),
    viewInTitle: (summary: string, board: string) => `${summary} · 点击在画布「${board}」中查看`,
    viewInLabel: (summary: string) => `${summary}，在画布中查看`,
    pickLabel: (summary: string) => `${summary}，选择画布`,
    viewHeading: "在画布中查看（最近修改的在前）",
    notPlacedHeading: (links: number) => `有 ${links} 条连线，但这条批注还没放到画布上。放到：`,
    createAndPlace: "新建画布并放入",
    createFailed: "新建画布失败",
  },

  /** 删除批注、术语、自由笔记时确认框里的影响说明 */
  deleteImpact: (links: number, boards: number) => {
    const parts = [links ? `${links} 条连线` : "", boards ? `${boards} 块画布上的节点` : ""].filter(Boolean);
    if (!parts.length) return "没有连线，也不在任何画布上。";
    return `将同时删除${parts.map((p) => ` ${p}`).join("和")}${links ? "（连线在所有画布和「相关笔记」中都会消失）" : ""}。`;
  },

  /** 导出的 JSON Canvas 节点文字（Markdown，跟随界面语言） */
  export: {
    /** 已删除条目的占位："（已删除的批注）" */
    missing: (what: string) => `（${what}）`,
    /** 批注出处 */
    source: (paper: string, page: number) => `—— 《${paper}》第 ${page} 页`,
    aliases: (list: string) => `别名：${list}`,
  },
};
