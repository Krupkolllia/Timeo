import { describe, expect, it } from "vitest";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS } from "@/db/settings";
import type { Settings } from "@/types/models";

describe("settingsStore", () => {
  it("starts empty and takes the settings row", () => {
    expect(useSettingsStore.getState().settings).toBeNull();

    const settings: Settings = {
      id: "s1",
      user_id: "user-1",
      created_at: "",
      updated_at: "",
      deleted_at: null,
      ...DEFAULT_SETTINGS,
    };
    useSettingsStore.getState().setSettings(settings);

    expect(useSettingsStore.getState().settings).toBe(settings);
    useSettingsStore.setState({ settings: null });
  });
});
