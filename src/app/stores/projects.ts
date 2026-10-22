import { create } from "zustand";
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from "@/lib/project";

export interface ProjectInfo {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 没有本地服务时在本浏览器里新建的（还没有 data/projects/<id>/） */
  localOnly?: boolean;
}

/** 项目切换器的弹窗 */
export type ProjectDialog = "create" | "rename" | "manage" | null;

/**
 * 项目列表与切换器的界面状态。列表来自本地服务的 data/projects.json（没有服务时来自本浏览器的 localStorage），
 * 由 services/projects.ts 写入；当前项目在页面启动时确定，运行中不变。
 */
interface ProjectsState {
  currentId: string;
  projects: ProjectInfo[];
  /** server：列表来自本地服务；local：没有本地服务，只在本浏览器；error：本地服务在，但列表读不了（projects.json 损坏、没有响应） */
  source: "server" | "local" | "error";
  /** source 为 error 时的原因 */
  error: string | null;
  /** data/ 还是旧版结构 */
  needsMigration: boolean;
  dialog: ProjectDialog;
  openDialog: (dialog: ProjectDialog) => void;
}

export const useProjectsStore = create<ProjectsState>()((set) => ({
  currentId: DEFAULT_PROJECT_ID,
  projects: [{ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME, createdAt: 0, updatedAt: 0 }],
  source: "local",
  error: null,
  needsMigration: false,
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
}));

/** 当前项目的条目（列表里找不到时用 id 作名字） */
export function currentProject(s: Pick<ProjectsState, "currentId" | "projects">): ProjectInfo {
  return s.projects.find((p) => p.id === s.currentId) ?? { id: s.currentId, name: s.currentId === DEFAULT_PROJECT_ID ? DEFAULT_PROJECT_NAME : s.currentId, createdAt: 0, updatedAt: 0 };
}
