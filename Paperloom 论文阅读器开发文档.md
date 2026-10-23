# Paperloom 论文阅读器开发文档

Oct 20, 2026 · @HorizonJang

## 1. 项目概述

Paperloom 是一个本地优先的网页版论文阅读器。它要做到一件现有工具做不到的事：**你给一个术语或缩写写一次笔记，它在所有论文里出现的每一处都会被标出，点一下就能打开这条笔记。**

**背景**：Zotero 能分组、能批注，但不会识别正文里的同一个词。Obsidian 能做术语链接，但要先把 PDF 转成 Markdown。MarginNote 功能全但太重。Semantic Reader 会给术语下定义，但那是 AI 写的，不是自己的笔记。

**目标（v1）**

1. 按领域分组管理多篇论文，一篇论文可以同时属于多个领域。
2. 在 PDF 原文上划线并写角注，角注显示在页边，和原文位置对齐。
3. 建立个人术语表：每个术语有别名（缩写、全称、复数等），所有论文里匹配到的位置都自动加下划线，点击后弹出笔记。
4. 数据可导出为 JSON 和 Markdown，能和 Obsidian 或 Zotero 互通。

**非目标（v1 不做）**：AI 自动生成定义、多设备同步、多人协作、扫描版 PDF 的 OCR、文献元数据抓取。

## 2. 需求

功能需求分四组，P0 是 v1 必须完成的。

| 编号 | 功能 | 说明 | 优先级 |
| --- | --- | --- | --- |
| F1.1 | 导入论文 | 拖入或选择 PDF；按文件哈希去重；可编辑标题、作者、年份 | P0 |
| F1.2 | 领域分组 | 领域可以嵌套（如 ATM / 轨迹预测）；一篇论文可属于多个领域 | P0 |
| F1.3 | 多篇同时打开 | 标签页切换；支持左右分屏对照两篇 | P0 |
| F2.1 | 划线批注 | 选中文字后高亮，可选颜色，附一条 Markdown 笔记 | P0 |
| F2.2 | 页边角注 | 笔记显示在页面右侧，与原文纵向对齐；重叠时自动错开 | P0 |
| F2.3 | 批注列表 | 按论文或领域列出所有批注，点击跳转到原文位置 | P1 |
| F3.1 | 创建术语 | 从选中文字一键创建；填写名称、别名、作用范围、笔记 | P0 |
| F3.2 | 自动标注 | 打开任意论文时，所有匹配到的术语加虚线下划线 | P0 |
| F3.3 | 点击弹出 | 点击下划线弹出卡片：你的笔记 + 该术语出现在哪些论文 | P0 |
| F3.4 | 作用范围 | 术语可设为全局或仅限某些领域，避免同一缩写在不同领域含义冲突（如 ATM） | P1 |
| F3.5 | 术语表视图 | 按领域浏览、搜索、编辑所有术语 | P1 |
| F4.1 | 导出 | 全部数据导出为 JSON；术语和批注导出为 Markdown | P1 |
| F4.2 | 导入备份 | 从 JSON 恢复 | P1 |

**非功能需求**

- **本地优先**：所有数据存在浏览器本地，离线可用，不上传任何文件。
- **性能**：单页渲染加术语标注在 200 ms 内完成；术语表 2000 条、单篇论文 50 页时不卡顿。
- **稳定锚定**：同一份 PDF 重新打开后，批注和角注位置不漂移。
- **可迁移**：数据格式公开、有版本号，以后换成桌面版也能直接读取。

## 3. 技术选型与整体架构

v1 做成纯前端单页应用，不需要后端。以后如果要做桌面版，可以用 Tauri 打包同一套代码。

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 框架 | React 18 + TypeScript + Vite | 生态成熟，类型安全，开发服务器启动快 |
| PDF 渲染 | pdfjs-dist（Mozilla pdf.js） | 提供 canvas 渲染和可选中的文本层，术语匹配依赖文本层 |
| 本地存储 | IndexedDB + Dexie.js | 可存 PDF 二进制文件和结构化数据，支持索引查询 |
| 状态管理 | Zustand | 轻量，适合跨组件共享当前论文、选中术语等状态 |
| 字符串匹配 | 自写 Aho-Corasick | 一次扫描同时匹配上千个术语，见第 6 节 |
| 笔记编辑 | CodeMirror 6 + markdown-it | Markdown 编辑与渲染，支持 KaTeX 公式 |
| UI | Tailwind CSS + Radix UI | Popover、Dialog 等无样式组件，自己控制外观 |
| 测试 | Vitest + Playwright | 匹配算法单元测试；阅读器端到端测试 |

整体分四层：界面层负责分组侧栏、阅读器和弹窗；领域服务层负责论文、批注、术语的增删改；术语引擎负责匹配和定位；存储层统一读写 IndexedDB。下图说明各模块的调用关系。

&#91;embedded content: 整体架构 · 4 层，箭头为调用方向\]

术语引擎不读写存储，只做纯计算：阅读器把每页文本交给它，后台 Worker 用它扫描全库，术语变更时由 TermService 触发重建。

## 4. 数据模型

共五张表。术语和论文之间不直接存关系，出现位置由术语引擎计算后缓存在 `occurrences` 表里。

```ts
interface Domain {
  id: string;            // nanoid
  name: string;          // "轨迹预测"
  parentId: string | null;
  color: string;
  order: number;
}

interface Paper {
  id: string;
  fileHash: string;      // SHA-256，用于去重和校验批注
  title: string;
  authors: string[];
  year?: number;
  domainIds: string[];   // 多对多
  pageCount: number;
  addedAt: number;
  lastOpenedAt?: number;
}
// PDF 二进制单独存在 files 表：{ hash, blob }

interface Annotation {
  id: string;
  paperId: string;
  page: number;                      // 从 1 开始
  rects: [number, number, number, number][]; // PDF 坐标 (x1,y1,x2,y2)
  quote: { exact: string; prefix: string; suffix: string }; // 备用锚点
  color: string;
  note: string;                      // Markdown
  termId?: string;                   // 若由此批注创建术语
  createdAt: number;
  updatedAt: number;
}

interface Term {
  id: string;
  name: string;          // 规范名，如 "Long Short-Term Memory"
  aliases: string[];     // ["LSTM", "LSTMs"]
  matchMode: "auto" | "caseSensitive" | "caseInsensitive";
  scope: { kind: "global" } | { kind: "domains"; domainIds: string[] };
  note: string;          // Markdown
  sourceAnnotationId?: string; // 首次定义的出处
  createdAt: number;
  updatedAt: number;
}

interface Occurrence {   // 缓存，可随时重建
  termId: string;
  paperId: string;
  pages: number[];
  count: number;
  engineVersion: number; // 匹配规则变化后失效
}
```

**设计要点**

- 批注同时存 PDF 坐标和原文引用（exact + 前后各 32 字符）。坐标用于快速绘制；引用用于坐标失效时重新定位。
- `matchMode: "auto"` 的规则：全大写的别名（如 ATM、LSTM）区分大小写，其余不区分。这能避免把普通单词 “atm” 误判成缩写。
- Dexie 索引：`papers: id, fileHash, *domainIds`；`annotations: id, paperId, [paperId+page]`；`terms: id, *aliases`；`occurrences: [termId+paperId], paperId`。

## 5. 核心模块设计

### 5.1 PDF 渲染（PdfViewer）

- 每页叠三层：canvas（图像）→ 文本层（pdf.js TextLayer，透明、可选中）→ 覆盖层（批注高亮和术语下划线）。
- 只渲染可视区域前后各 2 页，滚动时用 IntersectionObserver 懒加载，离开视野的页面释放 canvas。
- 缩放时三层统一使用 pdf.js 的 viewport 变换，覆盖层元素存 PDF 坐标，渲染时换算成屏幕坐标。

### 5.2 批注层（AnnotationLayer + MarginRail）

1. 用户选中文字后，读取 `window.getSelection()` 的 Range，取 `getClientRects()`，换算为 PDF 坐标并合并同一行的矩形。
2. 弹出小工具栏：高亮颜色、写笔记、“设为术语”。
3. 保存时同时记录原文引用（exact、prefix、suffix）。
4. 页边栏 MarginRail 在页面右侧绘制角注卡片，卡片的目标纵坐标等于批注第一个矩形的顶部。卡片重叠时，从上到下依次下推，并画一条细线连到原文。

### 5.3 术语引擎（TermEngine）

- 维护一个 Aho-Corasick 自动机，由所有术语的名称和别名生成，术语增删改时增量重建（2000 条约几十毫秒）。
- 输入一页的规范化文本，输出匹配列表 `{ termId, start, end }`。算法细节见第 6 节。
- 根据当前论文所属领域过滤作用范围不符的术语。
- 后台在 Web Worker 中扫描全部论文，写入 `occurrences` 缓存，用于弹窗里的“出现在哪些论文”。

### 5.4 术语弹窗（TermPopover）

- 点击下划线打开 Radix Popover，内容依次为：规范名和别名、你的笔记（可直接编辑）、出现该术语的论文列表（按领域分组，显示次数，点击跳转到第一次出现的位置）、“首次定义处”链接。
- 悬停 400 ms 显示只读预览，点击后进入可编辑状态。
- 在同一术语的弹窗里按 ↑/↓ 可在当前论文中跳到上一处或下一处出现位置。

### 5.5 分组侧栏（LibrarySidebar）

- 左侧是领域树，支持拖拽调整层级，可把论文拖到领域上完成归类。
- 点击领域显示其下论文（包含子领域），可按标题、年份、最近打开时间排序。
- 顶部全局搜索同时搜论文标题、批注内容和术语。

## 6. 关键算法：PDF 文本层术语匹配与定位

难点在于 PDF 里的文字是零散的文本片段，不是连续句子。处理流程是：先拼成一条规范化字符串并记下偏移映射，匹配完再映射回文本片段，最后算出屏幕上的矩形。

**第 1 步：拼接与规范化**

用 `page.getTextContent()` 取出文本片段 `items[]`，按顺序拼接成 `pageText`，同时为每个字符记录 `(itemIndex, charOffset)`。拼接时处理以下情况：

- **行尾连字符**：片段以 `-` 结尾且下一片段以小写字母开头时，删掉连字符，不插空格（trans- / former → transformer）。
- **连字**：ﬁ、ﬂ 等展开为 fi、fl，一个原字符对应多个规范字符。
- **空白**：连续空白和换行压缩为一个空格；片段之间没有空格但位置有间隔时，补一个空格。
- **大小写**：另存一份小写副本，供不区分大小写的模式使用。

**第 2 步：多模式匹配**

- 每个术语生成若干表面形式：名称、别名，以及自动派生的复数（加 s、es）和带连字符与不带连字符两种写法。
- 区分大小写与不区分大小写的形式分别建两个 Aho-Corasick 自动机，在原文和小写副本上各扫一遍，复杂度为 O(文本长度 + 匹配数)。
- **词边界检查**：命中位置的前后必须是非字母数字字符，避免缩写命中长单词的一部分（例如 “ATM” 不应命中 “ATMOSPHERE”）。
- **重叠消解**：按起点排序，同一起点保留最长匹配，与已保留区间重叠的丢弃。这样 “Long Short-Term Memory” 不会再被拆出 “Memory” 一个术语。

**第 3 步：映射回屏幕**

- 用偏移表把 `[start, end)` 换回 `(itemIndex, charOffset)`，找到文本层中对应的 `<span>`。
- 用 DOM `Range` 的 `setStart` 和 `setEnd` 选中这段文字，调用 `getClientRects()` 得到矩形（跨行时会有多个）。
- 把矩形转成相对页面的坐标，在覆盖层上画虚线下划线，并绑定 `data-term-id` 供点击使用。

**第 4 步：批注重新锚定**

打开论文时先校验 `fileHash`。哈希一致就直接用存储的 PDF 坐标；不一致（例如换了 arXiv 新版本）时，用 `quote.exact` 在全文中查找，若有多处则用 prefix 和 suffix 的相似度选最优；都找不到就把批注标为“未定位”，放进批注列表里等用户手动处理。

**测试用例（Vitest）**：连字符断行、连字、全大写缩写与普通单词、嵌套术语、跨两行的术语、同一页 500 次匹配的耗时。

## 7. 目录结构与开发里程碑

```text
paperlens/
├─ src/
│  ├─ app/               # 路由、布局、全局状态（Zustand）
│  ├─ components/
│  │  ├─ library/        # LibrarySidebar、领域树、论文列表
│  │  ├─ viewer/         # PdfViewer、PageView、文本层
│  │  ├─ annotation/     # AnnotationLayer、MarginRail、选区工具栏
│  │  └─ term/           # TermPopover、TermEditor、GlossaryView
│  ├─ engine/
│  │  ├─ normalize.ts    # 文本拼接与偏移映射
│  │  ├─ ahoCorasick.ts  # 多模式匹配自动机
│  │  ├─ matcher.ts      # 词边界、重叠消解、作用范围过滤
│  │  └─ anchor.ts       # 批注重新锚定
│  ├─ workers/
│  │  └─ indexer.worker.ts  # 后台扫描全部论文，写 occurrences
│  ├─ db/
│  │  ├─ schema.ts       # Dexie 表与索引、数据版本迁移
│  │  └─ repo/           # papers、annotations、terms 的读写
│  └─ lib/               # 坐标换算、哈希、导入导出
├─ tests/
│  ├─ engine/            # Vitest 单元测试
│  └─ e2e/               # Playwright 端到端测试
└─ fixtures/             # 测试用 PDF：双栏、连字、断行
```

&#91;embedded content: 开发路线 · 4 个阶段，每个阶段末尾有验收标准\]

工期按业余时间估计，可按实际进度调整。每个阶段通过验收标准后再进入下一阶段；M1 和 M2 完成后已经可以替代日常的 PDF 阅读器使用。

## 8. 风险与后续扩展

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 双栏排版导致文本片段顺序错乱 | 跨栏拼接产生假匹配，或术语被拆断 | 按片段坐标先分栏再排序；只在同一栏内连接相邻行 |
| 公式和特殊字体抽不出文字 | 公式里的符号无法被标注 | v1 接受此限制；后续可接入 MinerU 或 Nougat 先转结构化文本 |
| 同一缩写在不同领域含义不同 | 弹出错误的笔记 | 作用范围（F3.4）；同时命中多个术语时弹窗列出全部候选 |
| 浏览器清除站点数据 | 本地数据丢失 | 启动时调用 `navigator.storage.persist()`；每周提醒导出备份 |
| 术语过多导致页面满是下划线 | 干扰阅读 | 设置“每页每个术语只标第一次”和一键隐藏全部下划线 |

**后续扩展（v2 以后）**

- 与 Zotero 双向同步：通过 Zotero 本地 API 读取文库和分类，导入已有批注。
- 导出到 Obsidian：每个术语生成一个 Markdown 文件，带 aliases 字段和反向链接。
- AI 辅助：为新术语生成定义草稿，由你修改后保存；从论文中自动发现候选缩写（如 “Long Short-Term Memory (LSTM)” 这种定义句式）。
- Tauri 桌面版：直接读写本地文件夹中的 PDF，数据存为 SQLite。

## 9. 扩展评估：批注网络整理（笔记画布）

**结论：中等复杂度，排在 v1 之后作为 M5（约 2 周）；但它需要的数据结构要在 M1 就预留，否则后期改动代价很大。**

### 9.1 目标

阅读时只管记录批注和术语，读完后到一块画布上重新整理：把批注拖进来，按主题分组，用带标签的连线连成网状结构。和 MarginNote 的区别是：

- **网状而不是树状**：任意两条笔记都可以连线，一条笔记可以有多个上游，不强制只有一个父节点。
- **画布上放的是引用，不是副本**：在画布上修改笔记，PDF 页边的角注同步更新，反过来也一样。
- **连线全局有效**：在一块画布上建立的连接，在其他画布和术语弹窗的“相关笔记”里都能看到。
- **多块画布**：同一批笔记可以按不同主题整理成多块画布，例如一块按方法，一块按数据集。

### 9.2 交互流程

1. 阅读时新建的批注自动进入“未整理”收件箱。
2. 打开画布，从左侧收件箱把批注、术语或整篇论文拖到画布上；也可以直接写自由笔记卡片。
3. 从一个节点的边缘拖出连线到另一个节点，可选关系类型（支持、反驳、扩展、对比、属于）或自定义文字。
4. 用分组框把节点圈成主题区域，分组框可折叠。
5. 双击批注节点回到 PDF 原文位置；PDF 页边的角注上显示连线数量，点击可跳到画布。

### 9.3 新增数据模型

```ts
interface Link {          // 全局，与画布无关
  id: string;
  from: EntityRef;
  to: EntityRef;
  relation: "supports" | "contradicts" | "extends" | "compares" | "partOf" | "custom";
  label?: string;
  createdAt: number;
}

type EntityRef = { kind: "annotation" | "term" | "paper" | "note"; id: string };

interface Note {          // 只存在于画布上的自由笔记
  id: string;
  text: string;           // Markdown
}

interface Board {
  id: string;
  name: string;
  domainIds: string[];
}

interface BoardNode {     // 某个实体在某块画布上的位置
  boardId: string;
  ref: EntityRef;
  x: number; y: number; w: number; h: number;
  groupId?: string;
}
```

关键设计：**连线属于实体之间，位置属于画布。** 这样同一条批注可以出现在多块画布上，连线只存一份。

### 9.4 技术方案与工作量

| 部分 | 方案 | 难度 |
| --- | --- | --- |
| 画布、缩放、拖拽、连线 | React Flow（@xyflow/react），开箱即用 | 低 |
| 节点内容与 PDF 同步 | 节点只存引用，从同一个 Zustand store 读取 | 低 |
| 收件箱与拖入画布 | 查询 boardNodes 中未出现的批注 | 低 |
| 分组框与折叠 | React Flow 的子节点（parentId）功能 | 中 |
| 自动布局 | elkjs，按连线做分层或力导向布局，作为可选按钮 | 中 |
| 大画布性能 | 500 个节点以上时只渲染可视区域；节点内 Markdown 延迟渲染 | 中 |
| 导出 | 导出为 JSON Canvas 格式（Obsidian 的 .canvas 文件使用的开放格式），可直接在 Obsidian 中打开 | 低 |

**工作量估计**：基础版（画布、拖入、连线、跳回原文、导出）约 1 周；分组、自动布局、性能优化再加约 1 周。

### 9.5 对 v1 的影响

- **M1 中预留**：`links`、`notes`、`boards`、`boardNodes` 四张表的结构和 Dexie 索引，以及 `EntityRef` 类型。成本不到半天。
- **M3 中顺带实现**：术语弹窗里显示“相关笔记”列表（读取 links 表），这样画布上线前就能在阅读时手动建立连接。
- **风险**：画布容易变成第二个需要维护的地方。建议 M5 先只做基础版，用一两周后再决定是否做自动布局等功能。

## 10. 当前现状与进度（2026-10-23）

**一句话**：v1 的 M1–M5 已全部完成，并已开源发布（MIT）：仓库 <https://github.com/Horizon-42/paperloom>，在线版 <https://horizon-42.github.io/paperloom/>（GitHub Pages，推送到 main 后自动构建部署）。实现与本文的差异及原因都记在 `docs/decisions.md`（D1–D17）。

### 10.1 v1 目标完成情况

| 目标（§1） | 状态 | 说明 |
| --- | --- | --- |
| 1. 按领域分组，一篇论文可属于多个领域 | 完成 | 侧栏是一棵领域树：领域像文件夹一样嵌套、展开收起，论文就在其中（D15）；论文拖到领域上是**移动**（移出拖出时所在的领域，可撤销），右键「添加到领域」保留原领域（D14） |
| 2. 原文划线、页边角注与原文对齐 | 完成 | 文字定位改用字形映射，高亮精确到词（D1）；角注栏是文档级覆盖层（D4） |
| 3. 个人术语表，所有论文中自动下划线 | 完成 | 别名、作用范围、同时命中时列出全部候选；后台 Worker 索引全部论文（D7） |
| 4. 导出 JSON / Markdown，与 Obsidian 互通 | 完成 | JSON 完整备份（不含 PDF 本身）；Markdown 导出；画布导出为 JSON Canvas |

### 10.2 开发路线之外新增的功能

- **本地存储服务**（D9）：`npm run dev` 时数据镜像到 `data/`，IndexedDB 是工作副本；多标签页选一个负责写文件夹。
- **项目**（D10）：每个项目一套独立数据，`data/projects/<id>/`；附旧数据迁移脚本。
- **论文标签**（D11）：行按钮 / T 键 / 右键菜单 / 阅读器工具栏添加，按标签筛选。
- **在线版**：无本地服务时数据只在浏览器里，首次打开提示导出备份；pdf.js 附属资源按页面地址解析，子路径部署可用。
- **中英文界面**（D13）：文案全部在 `src/i18n/locales/`，新用户默认英文，升级前就在用的保持中文；EN | CN 切换。
- **对外名称 Paperloom（织读）**（D12），内部标识仍为 paperlens。
- **侧栏领域树**（D15，2026-10-23）：取代原来"领域树 + 所选领域的论文列表"的上下两栏。多领域的论文在每个领域下各出现一次并带标记；末尾「未分类」；
  「按领域 | 全部」视图切换（「全部」是带作者、标签的详细平铺列表）；按标签筛选时隐藏没有匹配的领域；选中的领域是导入目标；支持键盘导航。
- **导入到指定领域**（D16，2026-10-23）：领域行上的导入按钮（「+」右边）和右键菜单项；从系统把 PDF 拖到领域树的行上即导入到对应领域（拖到「未分类」上不归类）。
- **术语表导出为 LaTeX acro 格式**（D16）：「导出 .tex」生成 `glossary.tex`（开头注释说明用法），有筛选时可只导出当前列表；
  每条术语可复制它的 `\DeclareAcronym`（术语表列表条目右侧、⌘/Ctrl + C，论文里的术语弹窗）。中文全称配英文全称时写成 `foreign`。
- **引用数与 DOI**（D17，2026-10-23）：论文可填 DOI；引用数来自 OpenAlex——先按 DOI（没填时从 PDF 前两页识别），查不到再按标题匹配、取正式发表的最新版本。
  只在用户点击时联网（第一次有说明），单篇或批量查询，按引用数排序。领域树里的论文行改为与「全部」列表同样式；双击领域展开收起；新建术语时按首字母推断缩写并直接加进别名。

### 10.3 §8 风险的应对现状

| 风险 | 现状 |
| --- | --- |
| 双栏排版文本顺序错乱 | 不按坐标重排，改用硬边界防止跨栏假匹配（D3） |
| 公式和特殊字体抽不出文字 | 仍是限制，未接入 MinerU / Nougat |
| 同一缩写在不同领域含义不同 | 作用范围 + 候选列表，已完成 |
| 浏览器清除站点数据 | 启动时调用 `navigator.storage.persist()`；本地运行时有 `data/` 镜像；在线版首次提示导出备份 |
| 下划线过多干扰阅读 | 工具栏开关：「每页每个术语只标第一次」「隐藏全部术语下划线」 |

### 10.4 §9 笔记画布

基础版已完成（D8）：多块画布、收件箱拖入、连线与关系、跳回原文、导出 JSON Canvas、大画布只渲染可视区域。**未做**：分组框（`BoardNode.groupId` 仍预留）、elkjs 自动布局。

### 10.5 后续扩展（§8）的进度

| 扩展 | 状态 |
| --- | --- |
| 与 Zotero 双向同步 | 未开始 |
| 导出到 Obsidian | 部分完成：术语和批注导出 Markdown（`data/markdown/` 自动镜像），画布导出 `.canvas`；每术语一个带 aliases 的文件尚未做 |
| AI 辅助 | 未做 AI；术语编辑器能识别 “Long Short-Term Memory (LSTM)” 这类定义句式并建议名称和缩写（规则算法，不调用模型） |
| Tauri 桌面版 | 未开始；本地版用 `npm run dev` + `data/` 文件夹代替 |

### 10.6 质量与测试

- 类型检查（app + node）；Vitest 单元测试 705 个；Playwright e2e 按模块各有配置（viewer、annotation、term、glossary、canvas、storage、projects、tags、i18n、static），各自全部通过。
- 真实论文用例只在本机运行：`PAPERLENS_LITERATURE_DIR` 指向论文目录，用哪几篇写在 git 忽略的 `tests/e2e/real-papers.local.json`。
- 重要改动合并前由独立 agent 审阅（侧栏领域树经过两轮；D16 一轮，acro 的属性名按 acro 3.8 源码核对，本机没有 TeX、未实际编译）。
- 已知问题：默认的 `npm run e2e` 会跑全部用例（单一 1280×720 视口、并发），其中 9 个（画布、阅读器缩放、字形映射、术语下划线贴合、批注卡片、在线版 CMap）失败，
  用各模块自己的配置运行则全部通过（2026-10-23 在 main 上同样如此，不是新改动引起的；原因与改法见 `docs/open-items.md`）；
  可选的文库性能测试（`PAPERLENS_PERF=1`）里冷启动到第一行的耗时在本机约 400 ms，超过 300 ms 的阈值（改动前同样如此）。
- 待办与已知问题集中记在 `docs/open-items.md`。领域树遗留的小问题：重命名中的领域被滚出可视区时，Firefox 下可能丢失输入；把论文拖回它本来所在的领域仍显示可放置（实际不做任何事）；
  拖动结束的兜底处理只在 Chromium 上验证过；每一行都是一个 Tab 停靠点；领域树视图在 2000 篇论文下的性能还没有专门测试。

### 10.7 下一步候选

- 画布分组框与自动布局（§9.4 第二周的工作）。
- Zotero 文库与批注导入。
- 每个术语导出一个 Obsidian 文件（带 aliases 与反向链接）。
- 公式与扫描件：评估接入结构化文本或 OCR。
- 领域树的遗留问题（见 10.6），以及"全部"视图里也能拖到领域上归类（目前只能用右键菜单或编辑信息）。
