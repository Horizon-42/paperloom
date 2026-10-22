// 覆盖层注册表：批注、术语等模块把自己的组件注册到这里，阅读器负责按顺序渲染。
// 这样阅读器不需要直接依赖上层模块。
//
// 文字定位请用 src/lib/textGeometry.ts（基于字形映射，见 docs/decisions.md D1），
// 不要直接对文本层 span 做 DOM Range——文本层的字符位置是替代字体排出来的近似值。
import type { ComponentType } from "react";
import type { PageViewport } from "@/lib/pdf";
import type { NormalizedText, TextItemLike } from "@/engine/types";
import type { PaneId } from "@/app/stores/reader";

export interface PageTextInfo {
  /** 已过滤掉 TextMarkedContent 的文本片段，下标与 divs 一一对应 */
  items: TextItemLike[];
  /** pdf.js TextLayer.textDivs；空字符串片段对应的 span 不在 DOM 中。span 内可能有词级校正拆出的子 span */
  divs: HTMLElement[];
  /** 文本层容器 */
  layerEl: HTMLElement;
  /** engine/normalize 的结果，同一页只算一次 */
  normalized: NormalizedText;
  /**
   * 字形映射：与 items 一一对应，每个字符 4 个数 [x1, y1, x2, y2]（PDF 用户空间，y 向上），
   * 无法映射的字符为 NaN。字形映射尚未完成（首次 canvas 渲染完成前）时为 null。
   */
  charBoxes: Float32Array[] | null;
  /** 扫描件 + OCR 隐形文字层：定位精度受 OCR 质量限制，界面可提示 */
  scanned: boolean;
}

export interface PageLayerContext {
  paneId: PaneId;
  paperId: string;
  fileHash: string;
  pageNumber: number; // 从 1 开始
  /** 当前缩放下的 viewport，单位为 CSS 像素 */
  viewport: PageViewport;
  /** 页面容器，position: relative，尺寸等于 viewport */
  pageEl: HTMLElement;
  /** 该页所在分栏的滚动容器（监听滚动、把某处滚入视野用） */
  scrollEl: HTMLElement;
  /** 文本层渲染完成后才有值；charBoxes 可能稍晚到达（届时 ctx 会更新） */
  text: PageTextInfo | null;
}

export interface PageOverlayEntry {
  key: string;
  /**
   * under-text：画在 canvas 之上、文本层之下（纯展示，不挡选区），如高亮、下划线。
   * over-text：画在文本层之上，需自己控制 pointer-events，避免挡住文字选择。
   * margin：渲染在该页右侧的页边栏里（只在该页处于渲染范围时挂载）。
   */
  slot: "under-text" | "over-text" | "margin";
  Component: ComponentType<{ ctx: PageLayerContext }>;
}

/**
 * 注册必须在首次渲染前完成（在模块顶层 push，并在 App 中先 import 该模块），
 * PageView 渲染时读取本数组，晚注册的覆盖层要等下次重渲染才出现。
 * over-text 容器本身是 pointer-events: none，覆盖层里需要交互的元素要自己设为 auto。
 */
export const pageOverlays: PageOverlayEntry[] = [];

// ---- 文档级覆盖层：需要跨页布局的组件（如角注栏，卡片可能从一页溢出到下一页） ----

export interface DocPageLayout {
  pageNumber: number; // 从 1 开始
  /** 页面左上角相对文档内容区（滚动内容）左上角的位置，CSS 像素 */
  top: number;
  left: number;
  width: number;
  height: number;
  /** 该页在当前缩放下的 viewport（所有页都有，不论是否渲染），用于把 PDF 坐标换算为页内坐标 */
  viewport: PageViewport;
}

export interface DocLayerContext {
  paneId: PaneId;
  paperId: string;
  fileHash: string;
  pages: DocPageLayout[];
  /** 页边栏列相对文档内容区的横向位置和宽度 */
  marginLeft: number;
  marginWidth: number;
  /** 当前处于渲染范围的页码区间 [first, last]，可用于只渲染附近的卡片 */
  renderedRange: [number, number];
  /** 滚动容器（监听滚动、计算可视区域用） */
  scrollEl: HTMLElement;
}

export interface DocOverlayEntry {
  key: string;
  /**
   * margin：渲染在一个绝对定位容器中：原点为文档内容区左上角（与 DocPageLayout.top/left 同一坐标系），
   * 高度 = 文档总高度，横向从 0 覆盖到页边栏右缘（marginLeft + marginWidth），便于画从原文连到卡片的引线。
   * 容器 pointer-events: none，交互元素自行设为 auto。
   */
  slot: "margin";
  Component: ComponentType<{ ctx: DocLayerContext }>;
}

/** 注册规则同 pageOverlays */
export const docOverlays: DocOverlayEntry[] = [];
