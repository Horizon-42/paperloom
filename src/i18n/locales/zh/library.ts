// library 模块的界面文案（中文，是各语言文案的结构来源）：文库侧栏、领域、论文列表、标签、导入、项目。
export default {
  sidebar: {
    ariaLabel: "文库",
    importTitle: "导入 PDF（也可直接拖入窗口）",
    importButton: "导入",
    viewsLabel: "主视图",
    views: { reader: "阅读", glossary: "术语表", annotations: "批注", canvas: "画布" },
    resizeLabel: "调整侧栏宽度（双击恢复默认）",
    dropToImport: "松开以导入 PDF",
    dropInto: (domain: string) => `将归入「${domain}」`,
    /** 拖到「未分类」上 */
    dropUnfiled: "不归入任何领域",
  },

  search: {
    /** 只有论文一组时的占位文字 */
    placeholderPapers: "搜索论文标题、作者、标签",
    /** 有多组时：各组名称（如"论文、批注、术语"） */
    /** 搜索范围不止一两类时只说"全部"（侧栏放不下完整列表） */
    placeholder: (groups: readonly string[]) => (groups.length >= 3 ? "搜索全部（#标签）" : `搜索${groups.join("、")}（#标签）`),
    title: "搜索论文标题、作者、标签；以 # 开头只搜标签，如 #待读",
    ariaLabel: "全局搜索",
    clear: "清除搜索",
    results: "搜索结果",
    resultCount: (n: number) => `${n} 项`,
    noMatch: (q: string) => `没有找到与「${q}」匹配的内容`,
    showingFirst: (n: number) => `（显示前 ${n} 项）`,
    paperGroup: "论文",
  },

  domains: {
    navLabel: "领域",
    all: "全部论文",
    unfiled: "未分类",
    newDomain: "新建领域",
    treeLabel: "领域树",
    empty: "还没有领域。点击 + 新建，然后把论文拖到领域上归类。",
    dropToRoot: "拖到这里移到顶层",
    collapse: "折叠",
    expand: "展开",
    newSubdomain: "新建子领域",
    importHere: "导入论文到此领域…",
    importInto: (domain: string) => `导入 PDF 到「${domain}」（也可以把文件拖到这一行上）`,
    more: "更多",
    actions: "领域操作",
    changeColor: "更改颜色",
    nameLabel: "领域名称",
    color: "颜色",
    deleteDomain: "删除领域…",
    /** 新建领域时的默认名（存进数据库） */
    defaultName: "新领域",
    colors: {
      blue: "蓝",
      green: "绿",
      amber: "琥珀",
      red: "红",
      purple: "紫",
      cyan: "青",
      pink: "粉",
      orange: "橙",
      lime: "黄绿",
      indigo: "靛",
      gray: "灰",
    },
  },

  paperList: {
    ariaLabel: "论文列表",
    /** 按标签筛选后为空 */
    noTagged: (tags: readonly string[]) => (tags.length === 1 ? `没有带「${tags[0]}」标签的论文。` : "没有同时带有这些标签的论文。"),
    clearTagFilter: "清除标签筛选",
    emptyLibrary: "文库是空的。点击上方「导入」选择 PDF，或直接把 PDF 拖进窗口。",
    noPapers: "没有论文。",
    tagFilterBar: "标签筛选",
    clear: "清除",
    filterByTag: "按标签筛选",
    filterByTagCount: (n: number) => `按标签筛选（已选 ${n} 个）`,
    filterAllHint: "（同时带有所选标签）",
    manageTags: "管理标签…",
    sortLabel: (label: string) => `排序：${label}`,
    sortHeading: "排序方式",
    sort: { added: "添加时间", title: "标题", year: "年份", lastOpened: "最近打开" },
  },

  paperRow: {
    unknownAuthors: "作者未知",
    domains: (names: readonly string[]) => `领域：${names.join("、")}`,
    editTags: "编辑标签（T）",
    /** 作者太多时："张三, 李四, 王五 等" */
    authorsEtAl: (shown: string) => `${shown} 等`,
  },

  paperMenu: {
    open: "打开",
    editInfo: "编辑信息…",
    tags: "标签…",
    replacePdf: "替换 PDF 文件…",
    removeFromDomain: (name: string) => `从「${name}」移除`,
    /** 子菜单：保留已有领域，再加入一个 */
    addToDomain: "添加到领域",
    noDomains: "还没有领域",
    deletePaper: "删除论文…",
  },

  /** 把论文拖到领域上（移动） */
  movePaper: {
    moved: (name: string) => `已移到「${name}」`,
    /** 拖到「未分类」上：移出拖出时所在的领域 */
    removedFrom: (name: string) => `已移出「${name}」`,
    movedToUnfiled: "已移到「未分类」",
  },

  /** 侧栏的论文视图：领域树 / 全部论文 */
  tree: {
    viewLabel: "论文视图",
    byField: "按领域",
    all: "全部",
    /** 论文行上的标记：也在其他领域里 */
    alsoIn: (paths: readonly string[]) => `也在：${paths.join("、")}`,
  },

  editPaper: {
    title: "编辑论文信息",
    yearInvalid: "年份应为四位数字",
    titleRequired: "标题不能为空",
    titleLabel: "标题",
    authorsLabel: "作者",
    authorsHint: "（逗号或分号分隔）",
    authorsPlaceholder: "张三, 李四",
    yearLabel: "年份",
    tagsLabel: "标签",
    tagsHint: "（回车或逗号添加）",
    tagsPlaceholder: "如：待读、综述",
    domainsLabel: "所属领域",
    selectedCount: (n: number) => `已选 ${n} 个`,
    removeDomain: (name: string) => `移除 ${name}`,
    noDomains: "还没有领域，可在侧栏中新建",
    filterDomains: "筛选领域",
    noMatchingDomains: "没有匹配的领域",
    footer: (pages: number, date: string) => `${pages} 页 · 添加于 ${date}`,
  },

  deletePaper: {
    title: "删除论文？",
    /** annotationCount 还没读出来时为 null */
    body: (annotationCount: number | null) =>
      `将同时删除这篇论文的 PDF 文件${annotationCount ? `、${annotationCount} 条批注` : "、批注"}、术语出现记录，以及指向它或其批注的连线和画布节点。术语本身会保留。此操作无法撤销。`,
    confirm: "删除论文",
  },

  deleteDomain: {
    title: (name: string) => `删除领域「${name}」？`,
    descendants: (n: number) => `同时删除其下 ${n} 个子领域`,
    papers: (n: number) => (n > 0 ? `${n} 篇论文将移出这些领域` : "这些领域下没有论文"),
    papersNote: "（论文本身不会删除）",
    terms: (n: number) => `${n} 个术语的作用范围将移除这些领域`,
    termsNote: "（若范围因此变空，术语将不在任何论文中生效）",
    confirm: "删除领域",
  },

  tags: {
    groupLabel: "标签",
    remove: (tag: string) => `移除标签「${tag}」`,
    filterBy: (tag: string) => `按「${tag}」筛选`,
    unfilter: (tag: string) => `取消按「${tag}」筛选`,
    noTags: "还没有标签。在论文上按 T，或右键选择「标签…」添加。",
    emptyName: "标签名不能为空",
    /** 阅读器工具栏上的标签按钮 */
    control: {
      label: (tags: readonly string[]) => `标签：${tags.join("、")}（T 编辑）`,
      add: "加标签（T）",
      addShort: "加标签",
    },
    editor: {
      ariaLabel: "编辑标签",
      heading: "标签",
      inputLabel: "添加标签",
      hint: "回车添加 · 逗号分隔多个 · Esc 关闭",
    },
    input: {
      placeholder: "添加标签…",
      suggestions: "标签建议",
      existing: "已有标签",
      /** {tag} 处嵌入加粗的标签名 */
      create: "新建标签「{tag}」",
      already: (tag: string) => `已经有「${tag}」了`,
      allAdded: "文库里的标签都已加上。输入新标签名后回车。",
      emptyHint: "输入标签名后回车；用逗号分隔可一次添加多个。",
      backspaceAgain: (tag: string) => `再按退格移除标签「${tag}」`,
    },
    manage: {
      title: "管理标签",
      summary: (n: number) => `共 ${n} 个标签。改成已有的标签名会合并为一个；删除只从论文上去掉标签，论文本身保留。`,
      listLabel: "所有标签",
      done: "完成",
      merged: (from: string, to: string, n: number) => `已把「${from}」合并到「${to}」（${n} 篇论文）`,
      renamed: (from: string, to: string, n: number) => `已把「${from}」改名为「${to}」（${n} 篇论文）`,
      deleted: (tag: string, n: number) => `已从 ${n} 篇论文上删除标签「${tag}」`,
      newNameLabel: (tag: string) => `「${tag}」的新名称`,
      merge: "合并",
      mergeHint: (name: string, n: number) => `已有标签「${name}」（${n} 篇论文），保存后两者合并为一个。`,
      /** {tag} 处嵌入加粗的标签名 */
      deleteConfirm: (n: number) => `从 ${n} 篇论文上删除「{tag}」？`,
      keepPapers: "论文本身保留。",
      count: (n: number) => `${n} 篇`,
      renameLabel: (tag: string) => `重命名「${tag}」`,
      deleteLabel: (tag: string) => `删除「${tag}」`,
    },
  },

  importStatus: {
    added: "新增",
    duplicate: "重复",
    failed: "失败",
    addedCount: (n: number) => `新增 ${n} 篇`,
    duplicateCount: (n: number) => `重复 ${n} 篇`,
    failedCount: (n: number) => `失败 ${n} 篇`,
    close: "关闭导入结果",
    showDetails: "查看详情",
    hideDetails: "收起详情",
    alreadyInLibrary: (title?: string) => `已在文库中${title ? `：${title}` : ""}`,
    oneDuplicate: (name: string) => `「${name}」已在文库中`,
    oneAdded: "已导入 1 篇论文",
    oneFailed: "导入失败",
    allDuplicates: "这些论文都已在文库中",
    done: "导入完成",
    progress: (current: number, total: number) => `正在导入 ${current}/${total}`,
  },

  /** 导入 PDF 时的错误（显示在导入结果里）与默认标题 */
  importErrors: {
    encrypted: "PDF 已加密，暂不支持",
    corrupt: "文件已损坏或不是有效的 PDF",
    unreadable: "无法读取文件",
    notPdf: "不是 PDF 文件",
    noPages: "PDF 没有页面",
    unknown: "未知错误",
    /** 文件名里也取不出标题时的默认标题（存进数据库） */
    untitled: "未命名论文",
  },

  projects: {
    /** 默认项目的显示名：登记表里存的仍是原始中文名，只在显示时替换（见 lib/project.ts 的 projectDisplayName） */
    defaultName: "我的项目",
    switcherTitle: (name: string) => `项目：${name}（点击切换）`,
    switcherAria: (name: string) => `当前项目：${name}，切换项目`,
    menuHeading: "项目",
    menuLocalNote: "（未连接本地服务：列表只保存在本浏览器）",
    menuErrorNote: "（本地服务的项目列表暂时无法读取）",
    browserOnly: "仅本浏览器",
    openInNewTab: "在新标签页打开",
    openNameInNewTab: (name: string) => `在新标签页打开「${name}」`,
    newProject: "新建项目…",
    renameCurrent: "重命名当前项目…",
    manage: "管理/删除项目…",
    registryError: (error: string | null) => `本地服务的项目列表无法读取：${error ?? ""}`,
    registryErrorHelp: "现在只能使用本浏览器中的数据，项目的新建、重命名、删除已停用。请检查 data/projects.json 后刷新页面。",
    create: {
      title: "新建项目",
      descServer: "每个项目的论文、批注、术语和画布完全分开，数据保存在 data/projects/ 下各自的文件夹里。",
      descLocal: "未连接本地服务：新项目只保存在本浏览器中（之后用 npm run dev 启动时会自动建立它的文件夹）。",
      nameLabel: "项目名称",
      namePlaceholder: "例如：RoFormer 精读",
      openInNewTab: "在新标签页打开（当前标签页保持不变）",
      creating: "正在创建…",
      submit: "创建并打开",
    },
    rename: {
      title: "重命名当前项目",
      note: (id: string) => `只改显示的名称，文件夹 data/projects/${id}/ 不变。`,
    },
    manageDialog: {
      title: "管理项目",
      current: "当前",
      browserLocation: (id: string) => `本浏览器 · ${id}`,
      open: "打开",
      newTab: "新标签页",
      delete: "删除…",
      deleteKeepBrowser: "仍然删除（保留本浏览器中的数据库）",
      deleting: "正在删除…",
      deleteProject: "删除项目",
      currentNote: "当前打开的项目不能删除；要删除它，先切换到其他项目。",
      deleteFailed: (reason: string) => `删除失败：${reason}`,
      confirmServer: (name: string) =>
        `「${name}」的论文、批注、术语和画布将从项目列表中移除，数据移到 data/trash/projects/，不会物理删除；确认本浏览器中的数据都已保存到文件夹后，本浏览器中它的数据库也会一并删除。`,
      confirmListOnly: (name: string) => `未连接本地服务：只会把「${name}」从本浏览器的项目列表中移除，它的文件夹和本浏览器中的数据库都保留。`,
      confirmLocal: (name: string) => `「${name}」只在本浏览器中：删除前会先下载一份 JSON 备份（不含 PDF 文件），然后删除本浏览器中它的全部数据。`,
      result: {
        listOnly: (name: string) => `已从本浏览器的项目列表中移除「${name}」（未连接本地服务：它的文件夹和本浏览器中的数据库都保留）`,
        trashed: (name: string, path: string) => `已删除「${name}」：文件夹已移到 data/${path}/`,
        deleted: (name: string) => `已删除「${name}」`,
        exported: (file: string) => `删除前已下载备份 ${file}`,
        kept: "本浏览器中它的数据库已保留（打开这个项目的地址可以导出）",
        blocked: "本浏览器中它的数据库正被占用，未能删除（不影响其他项目）",
        failed: "本浏览器中它的数据库未能删除（不影响其他项目）",
        join: (parts: readonly string[]) => parts.join("；"),
      },
    },
    errors: {
      nameRequired: "请输入项目名称",
      nameTooLong: (max: number) => `项目名称最多 ${max} 个字符`,
      nameControlChars: "项目名称不能包含控制字符",
      noResponse: "本地服务没有响应",
      listUnavailable: (reason: string | null) => `本地服务的项目列表暂时无法读取（${reason ?? "未知错误"}），请先解决后刷新页面`,
      needsMigration: "数据需要先迁移到项目结构",
      notFound: "没有这个项目",
      deleteCurrent: "不能删除当前打开的项目",
      deleteLast: "不能删除最后一个项目",
      openElsewhere: (name: string) => `「${name}」正在其他标签页中打开，请先关闭那些标签页再删除`,
      unsynced: (name: string, detail: string) =>
        `「${name}」在本浏览器中有尚未保存到文件夹的内容（${detail}），删除会丢失它们。请先打开它，等左下角显示"已保存"后再删除。`,
      cannotVerify: "无法连接本地服务，不能确认文件夹里的数据是否完整",
      libraryMismatch: "文件夹里的 library.json 与本浏览器的数据不一致，可能有尚未保存的改动",
      noLibrary: "文件夹里还没有 library.json",
      pdfsMissing: (n: number) => `${n} 个 PDF 还没有保存到文件夹`,
    },
  },
};
