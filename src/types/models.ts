// Paperloom 数据模型（与开发文档第 4、9.3 节对应）。
// 所有持久化实体都在这里定义；修改字段时要同步 db/schema.ts 的版本迁移和导入导出。

/** PDF 用户空间坐标下的矩形 (x1, y1, x2, y2)，原点在页面左下角 */
export type PdfRect = [number, number, number, number];

export interface Domain {
  id: string; // nanoid
  name: string; // "轨迹预测"
  parentId: string | null;
  color: string;
  order: number; // 同级排序
}

export interface Paper {
  id: string;
  fileHash: string; // SHA-256（hex），用于去重和校验批注
  title: string;
  authors: string[];
  year?: number;
  domainIds: string[]; // 多对多
  /** 自定义标签（经 lib/tags.ts 的 normalizeTags 处理：不区分大小写去重，保持添加顺序）；没有标签时省略该字段 */
  tags?: string[];
  pageCount: number;
  addedAt: number;
  lastOpenedAt?: number;
  /** 规范化的 DOI（小写、不带 https://doi.org/ 前缀）：用户填写，或查询引用数时从 PDF 识别并核对过 */
  doi?: string;
  /** 最近一次查询引用数的结果（D17） */
  citations?: PaperCitations;
}

/** 引用数查询结果。数据源 OpenAlex；查不到时也记下时间，批量查询时跳过最近查过的 */
export type PaperCitations =
  | {
      status: "found";
      count: number;
      /** OpenAlex 的作品 id，如 "W2963403868" */
      workId: string;
      /** doi：按 DOI 查到；title：按标题匹配（取正式发表、最新的版本） */
      matchedBy: "doi" | "title";
      matchedTitle: string;
      matchedYear?: number;
      /** 匹配到的版本的 DOI（按标题匹配时可能与论文自己的不同） */
      matchedDoi?: string;
      /** 匹配到的是预印本（没有正式发表的版本） */
      preprint?: boolean;
      fetchedAt: number;
    }
  | { status: "notFound"; fetchedAt: number };

/** PDF 二进制单独存放，主键为文件哈希 */
export interface FileRecord {
  hash: string;
  blob: Blob;
  size: number;
}

export interface QuoteSelector {
  exact: string;
  prefix: string; // 前 32 个规范化字符
  suffix: string; // 后 32 个规范化字符
}

export type AnchorStatus = "ok" | "relocated" | "orphaned";

/** 选区锚点：从选中文字创建批注或术语时，在模块之间传递的未保存位置信息 */
export interface SelectionAnchor {
  paperId: string;
  page: number; // 从 1 开始
  rects: PdfRect[];
  quote: QuoteSelector;
  fileHash: string;
}

export interface Annotation {
  id: string;
  paperId: string;
  page: number; // 从 1 开始
  /**
   * 高亮矩形（PDF 坐标，由字形映射计算）。换文件重新定位后暂为 []，等该页渲染时由高亮层补算写回；
   * 读取方必须处理空数组（例如跳转位置退回页顶）。
   */
  rects: PdfRect[];
  quote: QuoteSelector; // 备用锚点
  /**
   * 创建（或最近一次重新锚定）时 PDF 的哈希；与 Paper.fileHash 不一致说明换过文件。
   * 开发文档模型之外新增的字段；导入缺少该字段的旧数据时，应补为论文当前的哈希，避免被误判为换过文件。
   */
  fileHash: string;
  /** 缺省视为 "ok"；"orphaned" 表示换文件后找不到原文，等待用户手动处理 */
  anchorStatus?: AnchorStatus;
  color: string;
  note: string; // Markdown
  termId?: string; // 若由此批注创建术语
  createdAt: number;
  updatedAt: number;
}

export type MatchMode = "auto" | "caseSensitive" | "caseInsensitive";

export type TermScope = { kind: "global" } | { kind: "domains"; domainIds: string[] };

export interface Term {
  id: string;
  name: string; // 规范名，如 "Long Short-Term Memory"
  aliases: string[]; // ["LSTM", "LSTMs"]
  matchMode: MatchMode;
  scope: TermScope;
  note: string; // Markdown
  sourceAnnotationId?: string; // 首次定义的出处
  createdAt: number;
  updatedAt: number;
}

/** 术语出现位置缓存，可随时重建 */
export interface Occurrence {
  termId: string;
  paperId: string;
  pages: number[]; // 升序
  count: number;
  engineVersion: number; // 匹配规则变化后失效
}

/** 每页规范化文本缓存（派生数据，可随时重建）：供后台扫描 occurrences 和换文件后重新锚定使用 */
export interface PageText {
  paperId: string;
  page: number; // 从 1 开始
  text: string; // normalizeItems 的 text
  fileHash: string; // 提取时的 PDF；与 Paper.fileHash 不一致即失效（换过文件）
  engineVersion: number; // 规范化规则变化后失效
}

// ---- M5 笔记画布预留（第 9.3 节）。v1 只建表，不做界面 ----

export type EntityKind = "annotation" | "term" | "paper" | "note";

export interface EntityRef {
  kind: EntityKind;
  id: string;
}

export type LinkRelation = "supports" | "contradicts" | "extends" | "compares" | "partOf" | "custom";

/** 实体之间的连线，全局有效，与画布无关 */
export interface Link {
  id: string;
  from: EntityRef;
  to: EntityRef;
  relation: LinkRelation;
  label?: string;
  createdAt: number;
}

/** 笔记：画布上的自由笔记，或属于某个领域的领域笔记（D18；同样可以放上画布、连线） */
export interface Note {
  id: string;
  text: string; // Markdown
  /** 领域笔记所属的领域；没有时是画布上的自由笔记 */
  domainId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Board {
  id: string;
  name: string;
  domainIds: string[];
  createdAt: number;
  updatedAt: number;
  /** 旧字段：视口现在存在各浏览器的 localStorage（见 decisions D8），这里只作初始位置读取，不再写入 */
  viewport?: { x: number; y: number; zoom: number };
}

/** 某个实体在某块画布上的位置 */
export interface BoardNode {
  id: string;
  boardId: string;
  ref: EntityRef;
  x: number;
  y: number;
  w: number;
  h: number;
  groupId?: string;
}

/** 键值表：用户设置、上次备份时间等 */
export interface KvRecord {
  key: string;
  value: unknown;
}
