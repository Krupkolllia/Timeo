import { create } from "zustand";
import type { Settings } from "@/types/models";

interface SettingsState {
  settings: Settings | null;
  setSettings: (settings: Settings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  setSettings: (settings) => set({ settings }),
}));
