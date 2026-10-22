// data 模块的界面文案（中文，是各语言文案的结构来源）：自动保存状态、数据与备份对话框、冲突与迁移提示、
// 导入导出、本地服务的错误、自动生成的 Markdown（data/markdown/，跟随界面语言）。

/** 本地服务的错误：服务端原文（中文，可能带参数）和响应体里的其他字段。见 services/storage/errors.ts */
export interface ServerErrorDetail {
  message?: string;
  data: Record<string, unknown>;
}

/** 有多种原文、或原文带参数的错误：中文直接用服务端原文 */
const original = (fallback: string) => (d: ServerErrorDetail) => d.message ?? fallback;

const TABLES: Record<string, string> = {
  domains: "领域",
  papers: "论文",
  annotations: "批注",
  terms: "术语",
  links: "连线",
  notes: "笔记",
  boards: "画布",
  boardNodes: "画布节点",
  kv: "设置",
};

export default {
  /** 侧栏底部的保存状态 */
  status: {
    probing: "正在连接本地服务…",
    offline: "未连接本地服务：数据只保存在本浏览器中",
    offlineRemind: (days: number) => `数据只在本浏览器中 · 已 ${days} 天未导出备份`,
    restoring: (dir: string) => `正在从 ${dir} 恢复…`,
    saving: "正在保存…",
    localEmpty: "本浏览器的数据已被清空，自动保存已暂停",
    newerFormat: (dir: string) => `${dir} 中的数据来自更新版本，自动保存已暂停`,
    dbReset: "本地数据库已被重置，自动保存已暂停",
    unreadable: (dir: string) => `${dir}library.json 无法读取，自动保存已暂停`,
    revision: "文件夹中的数据已被另一个窗口更新",
    saveFailed: "保存失败",
    needsMigration: "数据需要迁移到项目结构，自动保存已暂停",
    savedTo: (dir: string) => `已保存到 ${dir}`,
    pdfUpload: "正在保存 PDF",
    pdfFetch: "正在取回 PDF",
    /** 状态栏的提示：打开"数据与备份" */
    buttonTitle: (dir: string | null) => (dir ? `数据与备份（${dir}）` : "数据与备份"),
    closeNotice: "关闭提示",
  },
  /** 没有本地服务时的首次提示 */
  browserOnly: {
    heading: "数据只保存在这个浏览器里",
    body: "论文和批注不会上传到任何服务器。但清除浏览器的网站数据、换浏览器或换电脑后都会看不到，请定期导出备份。",
    exportBackup: "导出备份",
    dismiss: "知道了",
  },
  /** data/ 根目录下出现旧版文件 */
  strayLegacy: {
    /** 最多列出 shown 个，total 是总数 */
    files: (shown: readonly string[], total: number) => shown.join("、") + (total > shown.length ? ` 等 ${total} 项` : ""),
    heading: (files: string) => `data/ 根目录下有旧版本写入的文件：${files}`,
    body: "可能是迁移到项目结构之后又启动过旧版本。新版本不读取这些文件。如果在旧版本里做过改动，请在「数据与备份」中导入 data/library.json（导入前会自动备份当前数据）； 确认不需要之后，把这些文件移出 data/（例如移到 data-backup-before-projects-旧版残留/）。",
    hide: "暂时隐藏提示",
  },
  /** "数据与备份"对话框 */
  dialog: {
    title: "数据与备份",
    description: "自动保存状态、导出与导入备份",
    autoSave: {
      title: "自动保存",
      probing: "正在连接本地服务…",
      /** {cmd}、{dir} 是代码样式的命令和路径 */
      needsMigration: "数据需要迁移到项目结构：请运行 {cmd}。迁移前不会写入 {dir}，本浏览器中的数据不会丢失。",
      offlineWarning: "未连接本地服务：数据只保存在本浏览器中，清除浏览器数据（或换一个地址、端口打开）就看不到了。",
      offlineHowTo: "用 {cmd} 启动 Paperloom 时，数据会自动保存到项目的 {dir} 文件夹。没有本地服务时，建议每周导出一次 JSON 备份。",
      lastExport: (when: string) => `上次导出备份：${when}`,
      neverExported: "从未导出",
      exportNow: "（建议现在导出一份）",
      /** {dir}、{library}、{pdfs}、{backups} 是代码样式的路径 */
      onlineInfo:
        "数据自动保存在 {dir}：{library} 是全部笔记和批注，{pdfs} 是 PDF 原文件，{backups} 里有按小时滚动的历史版本。浏览器数据被清除时，打开 Paperloom 会自动从这里恢复。",
      lastSaved: (when: string) => `上次保存：${when}`,
      saving: "正在保存…",
      restoring: "正在恢复…",
      paused: "自动保存已暂停：文件夹中的数据与本浏览器不一致，请在提示中选择保留哪一份。",
      pdfUpload: "正在保存 PDF",
      pdfFetch: "正在从 data/pdfs 取回 PDF",
      missingPdfs: (n: number) => `${n} 个 PDF 文件在本浏览器和 data/pdfs 中都找不到，打开对应论文时请重新导入该文件。`,
      failedUploads: (n: number) => `${n} 个 PDF 无法保存到 data/pdfs（本地服务拒绝了，详见浏览器控制台），它们仍保存在本浏览器中。`,
      saveNow: "立即保存",
      /** 各项已格式化（如 "12 MB"）；trash、groups（附加文件组，如 "canvas/ 3 KB"）可省略 */
      usage: (u: { total: string; library: string; pdfs: string; backups: string; trash?: string | null; groups?: readonly string[] }) =>
        `占用空间 ${u.total}：library.json ${u.library}、pdfs/ ${u.pdfs}、backups/ ${u.backups}` +
        (u.trash ? `、trash/ ${u.trash}` : "") +
        (u.groups?.length ? `、${u.groups.join("、")}` : ""),
    },
    export: {
      title: "导出",
      exporting: "正在导出…",
      json: "导出 JSON 备份",
      regenerateMarkdown: "重新生成 Markdown",
      markdown: "导出 Markdown",
      downloaded: (name: string) => `已下载 ${name}`,
      updated: (path: string) => `已更新 ${path}/`,
      failed: (reason: string) => `导出失败：${reason}`,
      jsonNote: "JSON 备份包含全部论文信息、批注、术语、画布和设置，不含 PDF 文件。",
      /** {dir} 是代码样式的路径，{last} 是 lastGenerated 或空 */
      markdownFolder: "Markdown（每个术语、每篇论文一个文件，可用 Obsidian 打开）自动生成在 {dir}{last}。",
      lastGenerated: (when: string) => `，上次生成：${when}`,
      markdownCombined: "Markdown 导出为一个合并的 .md 文件（术语与批注）。",
      markdownFailed: (reason: string) => `Markdown 生成失败：${reason}`,
    },
    import: {
      title: "导入备份",
      intro: "从 JSON 备份恢复：会替换本浏览器中的全部数据。",
      reading: "正在读取…",
      importing: "正在导入…",
      choose: "选择 JSON 文件…",
      contains: (c: { papers: number; terms: number; annotations: number; boards: number; domains: number }) =>
        `包含 ${c.papers} 篇论文、${c.terms} 个术语、${c.annotations} 条批注、${c.boards} 块画布` + (c.domains ? `、${c.domains} 个领域` : ""),
      exportedAt: (when: string) => `（导出于 ${when}）`,
      warnOnline: (dir: string) => `导入会替换本浏览器中的全部数据。替换前会先把当前数据备份到 ${dir}/backups/。`,
      warnOffline: "导入会替换本浏览器中的全部数据。没有本地服务，请先下载当前数据的备份并确认已保存好。",
      downloadAgain: "重新下载备份",
      downloadFirst: "第一步：下载当前数据的备份",
      savedConfirm: (name: string) => `我已保存好 ${name}`,
      replace: "替换当前数据",
      backedUpTo: (path: string) => `原来的数据已备份到 ${path}`,
      downloadedAs: (name: string) => `原来的数据已下载为 ${name}`,
      pdfsNeeded: "本浏览器中没有的 PDF 需要重新导入（有本地服务时会自动从 data/pdfs 取回）",
      done: (c: { papers: number; terms: number; annotations: number }) => `已导入 ${c.papers} 篇论文、${c.terms} 个术语、${c.annotations} 条批注`,
      failed: (reason: string) => `导入失败：${reason}`,
      downloadFailed: (reason: string) => `下载备份失败：${reason}`,
    },
  },
  /** 文件夹与本浏览器的数据不一致时的对话框；dir 如 "data/projects/default/"（以 / 结尾） */
  conflict: {
    title: {
      revision: "文件夹中的数据已被另一个窗口更新",
      localEmpty: "本浏览器中的数据已被清空",
      newerFormat: (dir: string) => `${dir} 中的数据来自更新版本的 Paperloom`,
      dbReset: "本地数据库已被重置",
      unreadable: (dir: string) => `${dir}library.json 无法读取`,
    },
    recoverBackup: "从最近的可读备份恢复",
    loadFolder: "载入文件夹的数据（替换本浏览器中的数据）",
    restoreFrom: (dir: string) => `从 ${dir} 恢复（替换本浏览器中的数据）`,
    clearFolder: (dir: string) => `清空 ${dir} 中的数据`,
    writeCurrent: (dir: string) => `把当前数据写入 ${dir}（会先备份）`,
    overwriteDamaged: "用本浏览器的数据覆盖（损坏的文件会先备份）",
    overwriteFolder: "用本浏览器的数据覆盖文件夹",
    saving: "正在保存…",
    loading: "正在载入…",
    gotIt: "知道了",
    later: "稍后决定",
    /** 说明文字里的 {dir} 会显示为数据目录 */
    revisionBody: "另一个窗口（例如用另一个地址或端口打开的 Paperloom）向 {dir} 保存了数据，而本浏览器中也有尚未保存的改动。 自动保存已暂停，请选择保留哪一份。",
    backupNote: "被替换的那一份会先备份到 {dir}backups/。",
    localEmptyBody: "本浏览器中已经没有任何论文、批注和术语（可能清除了浏览器数据），但 {dir} 中还保存着数据。",
    localEmptyNote: "如果是有意删除了全部内容，可以选择清空文件夹中的数据（会先备份到 {dir}backups/）。",
    newerFormatBody: "请先更新 Paperloom 再打开。在此之前不会向 {dir} 写入任何内容，本浏览器中的改动仍然保存在浏览器里。",
    dbResetBody: "本浏览器的数据库被清空后重新建立了（例如清除了浏览器数据），现在里面只有之后新建的内容。为免用这点数据覆盖 {dir}中的完整文件库，自动保存已暂停。",
    dbResetNote: "两种选择都会先把将被替换的那一份备份到 {dir}backups/。",
    unreadableBody: "{dir}library.json 无法解析（可能被其他程序改坏了）。自动保存已暂停，不会用本浏览器的数据直接覆盖它。",
    unreadableNote: "可以用 {dir}backups/ 中最近一个可读的版本替换它（本浏览器的数据会先备份），或者用本浏览器的数据覆盖（损坏的文件会先另存）。",
  },
  /** data/ 还是旧版结构时的阻断提示 */
  migration: {
    title: "数据需要迁移到项目结构：请运行 npm run migrate:projects",
    oldLayout: (dir: string) => `${dir} 还是旧版的目录结构。新版本把每个项目的数据放在 data/projects/<项目>/ 下，原来的数据会成为第一个项目。`,
    /** {preview}、{apply} 是代码样式的命令 */
    howTo: "在项目目录里运行 {preview} 预览，确认后运行 {apply}（会先完整备份 data/）。",
    paused: "迁移完成前自动保存已暂停，不会写入 data/；本浏览器中的数据不会丢失。迁移后刷新本页即可继续。",
    reload: "已迁移，刷新页面",
  },
  /** 自动保存过程中的提示 */
  sync: {
    counts: (c: { papers?: number; terms?: number; annotations?: number; boards?: number }) =>
      [`${c.papers ?? 0} 篇论文`, `${c.terms ?? 0} 个术语`, `${c.annotations ?? 0} 条批注`, ...(c.boards ? [`${c.boards} 块画布`] : [])].join("、"),
    restoreFailed: (dir: string, reason: string) => `从 ${dir} 恢复失败：${reason}（刷新页面重试）`,
    shrinkBackup: (name: string) => `数据比上次保存时少了一半以上，之前的版本已备份为 backups/${name}`,
    saveFailed: (reason: string) => `保存失败：${reason}（稍后自动重试）`,
    restoring: (dir: string) => `正在从 ${dir} 恢复数据…`,
    pdfsLater: "PDF 会在打开时从 data/pdfs 读取，后台也在逐个取回",
    loadedFromOtherWindow: (counts: string) => `已载入其他窗口保存的数据：${counts}`,
    restoredFromBackup: (name: string, counts: string) => `已从备份 ${name} 恢复：${counts}`,
    restoredFrom: (dir: string, counts: string) => `已从 ${dir} 恢复：${counts}`,
    folderChangedAgain: "文件夹在此期间又被更新，请重新选择",
    ownerNoResponse: "负责保存的标签页没有响应",
  },
  /** 读取数据文件、导入 */
  format: {
    invalidJson: "不是有效的 JSON 文件",
    notPaperloom: "这不是 Paperloom 的备份文件",
    missingVersion: "备份文件缺少有效的数据格式版本",
    newerVersion: (version: number, supported: number) =>
      `这份数据来自更新版本的 Paperloom（数据格式 v${version}，当前只支持 v${supported}），请先更新应用`,
    missingTables: "备份文件缺少数据表",
    unreadableFile: "无法读取文件（不是有效的 JSON 或 gzip 文件）",
    untitledPaper: "未命名论文",
    untitledBoard: "未命名画布",
    /** table 是表名（papers、terms…） */
    skipped: (n: number, table: string) => `跳过 ${n} 条无效或引用缺失的${TABLES[table] ?? table}`,
    mergedPapers: (n: number) => `合并 ${n} 篇重复的论文`,
    annotationTermMissing: (n: number) => `${n} 条批注关联的术语不存在，已解除关联`,
    termSourceMissing: (n: number) => `${n} 个术语的出处批注不存在，已清除出处`,
    changedSinceBackup: "下载备份之后本地数据又有改动，请重新下载一份备份再导入",
    downloadBackupFirst: "请先下载当前数据的备份",
    localChanged: "本地数据在载入期间有新的改动，已取消载入",
  },
  errors: {
    cannotConnect: "无法连接本地服务",
    /** 本地服务返回的不是 JSON（或没有说明） */
    httpStatus: (status: number) => `本地服务返回 ${status}`,
    pdfCorrupt: "data/pdfs 中的文件已损坏（哈希不符）",
    noLibrary: "data/ 中没有 library.json",
    /** 本地服务（server/）的错误代码 → 文案 */
    server: {
      "not-loopback": "只接受本机请求",
      preflight: "不支持跨源访问",
      "bad-host": "Host 不是本机地址",
      "bad-origin": "不接受其他网站的请求",
      "cross-site": "不接受其他网站的请求",
      "missing-header": "缺少 X-PaperLens 请求头",
      "invalid-client": "缺少有效的 X-PaperLens-Client",
      "too-large": original("文件过大"),
      "invalid-json": "不是有效的 JSON",
      gone: "这个接口已停用（数据已按项目存放）：请刷新页面",
      method: "不支持的方法",
      "not-found": original("没有这个接口"),
      "unknown-project": "没有这个项目",
      "invalid-project": "无效的项目 id",
      "invalid-revision": original("revision 必须是正整数"),
      "invalid-format": original("不是 Paperloom 数据文件"),
      unreadable: "data/library.json 无法读取（可能已损坏），不能直接覆盖",
      conflict: "文件夹中的数据已被另一个窗口更新",
      "newer-format": "文件夹中的数据由更新版本的 Paperloom 写入，旧版本不能覆盖",
      "no-backup": "没有可读的备份",
      readable: "library.json 可以正常读取，不需要从备份恢复",
      "invalid-reason": "备份原因只能包含小写字母、数字和连字符，并以字母开头",
      "invalid-hash": "无效的文件哈希",
      "hash-mismatch": "文件内容与哈希不一致",
      "invalid-group": "无效的文件组名",
      "invalid-files": "files 必须是数组",
      "invalid-name": original("无效的文件名"),
      "duplicate-name": original("文件名重复"),
      busy: original("数据目录正被另一个进程写入，请稍后再试"),
      "registry-unreadable": original("data/projects.json 无法读取"),
      "project-dir-missing": original("项目目录不存在"),
      exists: original("已有这个项目"),
      "last-project": "不能删除最后一个项目",
      "project-active": original("这个项目正在别的窗口中打开：请先关闭它；刚关闭的话请稍等一分钟再试"),
      "needs-migration": "data/ 还是旧版的目录结构，需要先迁移到项目结构：请运行 npm run migrate:projects",
      internal: original("本地服务出错"),
    },
  },
  /** 自动生成的 Markdown（data/markdown/、没有本地服务时下载的合并文件） */
  markdown: {
    /** 标题清理后为空时的文件名 */
    untitledFile: "未命名",
    /** "标签：值" */
    field: (label: string, value: string) => `${label}：${value}`,
    list: (items: readonly string[]) => items.join("、"),
    /** 领域路径等较长的项之间 */
    longList: (items: readonly string[]) => items.join("；"),
    /** 页码列表；more 表示后面还有 */
    pages: (pages: readonly number[], more: boolean) => pages.join("、") + (more ? " 等" : ""),
    aliases: "别名",
    scope: "作用范围",
    domainDeleted: "（领域已删除）",
    noNote: "_（还没有笔记）_",
    appearsIn: "出现于",
    notFoundYet: "_（还没有在文库中找到）_",
    /** 术语出现在一篇论文中："12 次（第 1、3、5 页）" */
    occurrences: (count: number, pages: string) => `${count} 次（第 ${pages} 页）`,
    /** 合并文件里："标题（12 次）" */
    countIn: (title: string, count: number) => `${title}（${count} 次）`,
    orphaned: "_（换过 PDF 文件后未找到这段原文）_",
    term: "术语",
    authors: "作者",
    year: "年份",
    domains: "领域",
    tags: "标签",
    pageCount: "页数",
    annotations: (n: number) => `批注（${n}）`,
    noAnnotations: "_（还没有批注）_",
    page: (n: number) => `第 ${n} 页`,
    readme: `# Paperloom 笔记

此目录由 Paperloom 自动生成，每次保存时更新：

- \`terms/\`：每个术语一个文件（别名、作用范围、笔记、出现在哪些论文）
- \`papers/\`：每篇论文一个文件（元数据和全部批注）

在这里直接修改的内容会在下次保存时被覆盖，请在 Paperloom 中编辑。可以把这个目录作为 Obsidian 仓库打开。
`,
    combinedTitle: "Paperloom 导出",
    combinedSummary: (date: string, terms: number, papers: number) => `导出时间：${date}；术语 ${terms} 个，论文 ${papers} 篇。`,
    terms: "术语",
    noTerms: "_（没有术语）_",
    papersAndAnnotations: "论文与批注",
    noPapers: "_（没有论文）_",
  },
};
