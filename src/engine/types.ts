// 术语引擎的公共接口（开发文档第 5.3、6 节）。
// 引擎是纯计算模块：不读写数据库、不依赖 DOM，可以在主线程和 Worker 中复用。

import type { MatchMode, TermScope } from "@/types/models";

/**
 * 规范化规则版本（normalize.ts：拼接、连字、行尾连字符、兼容字符、硬边界等）。
 * 变化时 pageTexts 全文缓存失效，需要从 PDF 重新提取（慢，约 0.25 s/篇），occurrences 也随之重算。
 */
export const NORMALIZE_VERSION = 1;

/**
 * 匹配规则版本（表面形式派生、大小写、词边界、重叠消解、作用范围）。
 * 变化时只有 occurrences 失效，用已缓存的全文重扫即可（快）。
 */
export const MATCH_VERSION = 1;

/**
 * pdf.js TextItem 的最小子集，便于测试时构造。
 * 输入数组必须已经过滤掉 TextMarkedContent，这样下标 i 与 TextLayer.textDivs[i] 一一对应。
 */
export interface TextItemLike {
  str: string;
  /** [a, b, c, d, e, f]，e/f 为 PDF 坐标下的基线起点 */
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

/** 第 1 步的产物：整页规范化文本及逐字符偏移映射 */
export interface NormalizedText {
  /** 规范化后的整页文本 */
  text: string;
  /** 小写副本，必须与 text 等长、逐字符对齐 */
  lower: string;
  /**
   * 第 i 个规范化字符来自哪个文本片段的哪个字符。
   * 拼接时插入的合成空格记为 itemIndex = -1, charOffset = -1。
   * 连字展开（ﬁ → fi）时多个规范字符指向同一个原字符。
   */
  itemIndex: Int32Array;
  charOffset: Int32Array;
}

/** 映射回文本片段后的位置：[start, end) 跨越一个或多个片段 */
export interface ItemRange {
  startItem: number;
  startOffset: number; // 在 items[startItem].str 中的偏移（含）
  endItem: number;
  endOffset: number; // 在 items[endItem].str 中的偏移（不含）
}

/** 术语引擎需要的最小术语信息 */
export interface TermLike {
  id: string;
  name: string;
  aliases: string[];
  matchMode: MatchMode;
  scope: TermScope;
}

/** 一次命中。多个术语共享同一表面形式（如两个领域都有 "ATM"）时 termIds 含多个候选 */
export interface TermMatch {
  termIds: string[];
  start: number; // 规范化文本中的偏移（含）
  end: number; // 不含
}

/** 作用范围过滤需要的上下文 */
export interface ScopeContext {
  /** 当前论文所属领域 */
  paperDomainIds: string[];
  /** 领域 id → 父领域 id，用于判断子领域继承父领域的术语 */
  domainParent: ReadonlyMap<string, string | null>;
}
