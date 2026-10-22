# Paperloom

本地优先的网页版论文阅读器。对外名称 Paperloom，内部标识仍叫 paperlens（见 docs/decisions.md D12）。需求与设计见 `Paperloom 论文阅读器开发文档.md`（下称"开发文档"），实现时以它为准。

## 命令

- `npm run dev` — 开发服务器（固定 5173，被占用时报错而不是换端口；多人并行时用 `npx vite --port <你的端口>`）。
  内置本地存储服务（`server/`，Vite 插件）：每个项目的数据自动镜像到 `<项目根>/data/projects/<项目 id>/`（见下方"项目"）。
  `PAPERLENS_DATA_DIR=<目录>` 改用其他目录；`PAPERLENS_STORAGE=off` 关闭存储服务。开发/预览服务器 `cors: false`，data/ 目录禁止静态访问（见 D9）。
- `npm run migrate:projects` — 把旧版的 `data/`（根目录下直接是 `library.json`）迁移到项目结构。不加参数只预览；
  `-- --apply` 执行（先完整备份到 `data-backup-before-projects-<时间>/`）；`--data <目录>`、`--name <项目名>`、`--ports <端口|none>`、
  `--no-process-scan`（不用 lsof 检查其他端口上的 node 进程）、`--force`（端口上的程序无法确认身份、或目录不像 Paperloom 数据时仍执行）（见 D10）。
- `npm run typecheck` — tsc 类型检查（app + node 两个 tsconfig）
- `npm test` — Vitest 单元测试（`tests/engine/**`、`tests/unit/**`）
- `npm run e2e` — Playwright（`tests/e2e/**`，自动在 5199 端口起服务）。各模块另有独立配置：
  `npx playwright test -c tests/e2e/<viewer|annotation|term|glossary|canvas|storage|projects|tags>.config.ts`；
  `PAPERLENS_LITERATURE_DIR=<你的论文目录>` 时额外跑真实论文用例

## 项目（notebook）与数据目录

每个项目是一套完全独立的数据（论文、批注、术语、画布、连线、设置），见 D10。一个浏览器标签页打开一个项目，几个标签页可以同时开不同的项目。

```
data/
  projects.json              项目登记表 { version: 1, projects: [{ id, name, createdAt, updatedAt }] }
  projects/<id>/             一个项目：library.json、pdfs/、markdown/、canvas/、backups/、trash/（结构即旧版的 data/ 根目录）
  trash/projects/<id>-<时间>/  删除的项目（整个目录移过来，从不物理删除）
```

- 当前项目在页面启动时确定一次（URL `?project=<id>` > 本浏览器上次打开的 > 列表第一个 > `default`），切换项目 = 带新的 `?project=` 重新加载页面。
  所以模块加载时就可以读 `currentProjectId()`，运行中不会变；`main.tsx` 确定项目之后才加载 `start.tsx`（应用本体）。
- 项目相关的命名都在 `src/lib/project.ts`：数据库名 `dbNameFor`（`default` → `paperlens`，其他 → `paperlens-p-<id>`）、
  localStorage 键 `projectKey`（`default` 用原来的键，其他加 `@<id>`）、`navigator.locks` / `BroadcastChannel` 名 `projectScoped`（都带 `:<id>`）、
  接口前缀 `projectApiBase`（`/__paperlens/p/<id>/storage`）。**新增按项目区分的 localStorage 键、锁、频道时都要经过它们**；
  只与本浏览器有关、与项目无关的（如批注的上次颜色）可以不分。
- Worker 读不到页面 URL：创建 Worker 时用 `workerName(kind)` 作名字，Worker 里的 `currentProjectId()` 从 `self.name` 解析；
  消息里带页面的 `db.name`，Worker 核对不一致时拒绝执行（调用方退回主线程）。新增 Worker 照此办理。
- 本地服务的接口：`/__paperlens/projects`（列表、新建、重命名、删除）、`/__paperlens/p/<id>/storage/...`（一个项目的数据）；
  旧的 `/__paperlens/storage/...` 一律 410。`data/` 还是旧版结构时服务拒绝一切写入，前端显示迁移提示。

## 技术栈

React 18 + TypeScript 5.9（strict）+ Vite 8、pdfjs-dist 6、Dexie 4 + dexie-react-hooks、Zustand 5、Tailwind CSS 4、Radix UI、CodeMirror 6 + markdown-it + KaTeX、Vitest + Playwright。

注意 pdfjs-dist 6 的 API 与旧版有差异（如 `PageViewport` 没有 `convertToViewportRectangle`、`PDFDocumentProxy` 没有 `destroy()`），以 `node_modules/pdfjs-dist/types` 为准。pdfjs-dist 锁定精确版本：字形映射依赖其内部的 operator list 格式，升级前必须跑字形回归测试。

设计决定（与开发文档的差异及原因）记录在 `docs/decisions.md`。**文字定位一律用 `src/lib/textGeometry.ts`，不要直接对文本层 span 做 DOM Range**（见 D1）。

## 分层与目录

```
src/
  app/            App.tsx 布局；stores/ 下是 Zustand 界面状态（每个模块一个文件）
  components/
    library/      领域树、论文列表、导入
    viewer/       ReaderArea（标签、分屏）、PdfViewer、PageView、文本层；overlays.ts 是覆盖层注册表
    annotation/   高亮、选区工具栏、MarginRail 角注、批注列表
    term/         术语下划线、TermPopover、TermEditor、GlossaryView
    canvas/       笔记画布（React Flow，懒加载）
    data/         保存状态、导出/导入对话框、冲突处理
    common/       通用组件（Markdown 编辑/渲染等）
  engine/         术语引擎：纯计算，不碰数据库和 DOM（可在 Worker 中运行）
  workers/        indexer.worker.ts 后台扫描
  db/             schema.ts（Dexie 表与索引）；repo/ 各表的读写
  services/       领域服务：跨表的业务逻辑（导入、级联删除、术语变更触发重建等）；storage/ 是与本地存储服务的同步；projects.ts 是项目列表与启动
  lib/            坐标换算、哈希、pdf.js 初始化、导入导出；project.ts 是当前项目与按项目区分的命名
  types/models.ts 所有持久化数据模型
server/           本地存储服务（Vite 插件，只接受本机请求）；projects.ts 是项目注册表
scripts/          migrate-projects.mjs（数据目录迁移到项目结构，纯 Node）、make-fixtures.ts
tests/engine, tests/unit  Vitest；tests/e2e  Playwright；fixtures/ 测试 PDF（只放自己生成的）
```

## 共享契约（改动前先和负责人确认，不要顺手改）

- `src/types/models.ts` — 数据模型
- `src/db/schema.ts` — 表结构。只能追加新版本迁移，不改已有版本
- `src/engine/types.ts` — 引擎接口；规范化规则变化时 `NORMALIZE_VERSION` +1（全文缓存失效、需重新提取），匹配规则变化时 `MATCH_VERSION` +1（只重扫 occurrences）
- `src/components/viewer/overlays.ts` — 覆盖层注册表：页面级 `pageOverlays`/`PageLayerContext`，文档级 `docOverlays`/`DocLayerContext`
- `src/lib/textGeometry.ts` — 文字定位（规范化区间 ↔ PDF 矩形、DOM 选区 → 规范化区间），基于字形映射
- `src/app/stores/reader.ts` — 标签页、分屏、`openPaper`、`jumpTo`
- `src/app/stores/termUi.ts` — `openTermEditor`（批注模块"设为术语"的入口）
- `src/lib/coords.ts` — PDF 坐标与屏幕坐标换算
- `src/lib/project.ts` — 当前项目、数据库名、按项目区分的键/锁/频道/接口前缀（改动会让已有数据或同步记录对不上）

## 约定

- 界面文案中英两套，都在 `src/i18n/locales/{zh,en}/<模块>.ts`（D13）：代码里用 `t.<模块>.<键>`（`import { t } from "@/i18n"`），
  带参数的文案写成函数（`t.library.paperCount(n)`），文案里嵌元素用 `<Trans text=… values={{…}} />`，时间用 `@/i18n/format`。
  **代码里不写死任何语言的界面文字**（`tests/unit/i18n/hardcoded.test.ts` 扫描检查）；中文文案是结构来源，英文必须一一对应（类型检查 + `messages.test.ts`）。
  代码标识符用英文；注释用中文，简洁，只解释不显而易见的地方。
- 导入路径用 `@/` 别名。
- 持久化数据在 Dexie 里，组件用 `useLiveQuery` 读取；Zustand 只放界面状态（当前标签、弹窗开关等），不要把数据库内容复制进 store。
- 数据库写操作集中在 `db/repo/` 和 `services/`，组件不直接写表。
- 样式用 Tailwind；弹层、对话框、菜单用 Radix 组件。
- 不随意新增依赖；确需新增时在汇报中说明理由。
- 开发模式下 `window.__paperlens` 暴露 `db` 和各 store，供 e2e 测试注入数据。
- **测试绝不能碰真实的 `data/`**：所有 Playwright 配置的 webServer 都要设 `PAPERLENS_STORAGE=off`（或指向临时的 `PAPERLENS_DATA_DIR`），并且 `reuseExistingServer: false`。
  迁移脚本的测试只用临时目录，并用 `--ports` 指定测试自己起的端口、加 `--no-process-scan`（缺省会探测 5173、4173 和本机其他 node 进程的端口）。
- 界面语言（D13）：启动时确定一次（`?lang=` > localStorage `paperlens.locale` > 浏览器语言 > 英文），切换 = 重新加载页面；
  Worker 名用 `workerName(workerKind(kind))` 把语言带进去。单元测试固定中文（`tests/setup.ts`），Playwright 配置都设 `locale: "zh-CN"`。
- 论文标签（D11）：`Paper.tags`，规范化与查询在 `src/lib/tags.ts`，写入经 `src/services/tagService.ts`；不加索引，筛选在内存里做。
- 导出/镜像不包含派生数据：`pageTexts`、`occurrences`、kv 中 `indexer:`、`storage:` 开头的记录。

## 隐私

真实论文用例通过 `PAPERLENS_LITERATURE_DIR` 指向本机的论文目录，只能原地读取。不要把真实论文复制进本仓库，不要上传到任何服务。
