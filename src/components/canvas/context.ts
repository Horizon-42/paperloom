// 画布内部共享的操作：节点/边组件通过 context 调用，避免把回调塞进每个节点的 data
import { createContext, useContext } from "react";
import type { EntityRef, Link } from "@/types/models";
import type { Geometry } from "./flow";

export interface CanvasActions {
  boardId: string;
  /** 从画布移除（只删 boardNode），带撤销提示 */
  removeNodes: (ids: string[]) => void;
  resizeNode: (id: string, g: Geometry) => void;
  /** 删除自由笔记（确认后级联删除连线和节点） */
  deleteNote: (noteId: string) => void;
  /** 打开连线编辑浮层（client 坐标） */
  openEdgeEditor: (linkId: string, at: { x: number; y: number }) => void;
  /** 该节点上另一端不在本画布的连线 */
  externalOf: (nodeId: string) => { link: Link; other: EntityRef }[];
  /** 把实体放到某个节点旁边（已在画布上则定位过去） */
  placeNear: (nodeId: string, ref: EntityRef) => void;
  /** 把论文的全部批注放到论文节点下方（已在画布上的跳过） */
  addPaperAnnotations: (nodeId: string, paperId: string) => void;
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null);

export function useCanvasActions(): CanvasActions {
  const v = useContext(CanvasActionsContext);
  if (!v) throw new Error("CanvasActionsContext 未提供");
  return v;
}

/** 画布向左侧面板暴露的操作（面板在 React Flow 视口之外） */
export interface BoardBridge {
  /** 放到视口中央；已在画布上时定位过去 */
  placeAtCenter: (ref: EntityRef) => void;
  /** 在视口中央新建自由笔记并进入编辑 */
  newNoteAtCenter: () => void;
  /** 定位到已有节点；不在画布上返回 false */
  focusRef: (ref: EntityRef) => boolean;
}
