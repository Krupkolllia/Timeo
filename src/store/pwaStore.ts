import { create } from "zustand";

interface PwaState {
  needsRefresh: boolean;
  applyUpdate: () => void;
}

export const usePwaStore = create<PwaState>(() => ({
  needsRefresh: false,
  applyUpdate: () => {},
}));
