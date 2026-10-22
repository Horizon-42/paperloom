import { create } from "zustand";

/** 主区域显示什么：阅读器、术语表、批注列表或笔记画布 */
export type MainView = "reader" | "glossary" | "annotations" | "canvas";

interface AppState {
  view: MainView;
  setView: (view: MainView) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  view: "reader",
  setView: (view) => set({ view }),
}));
