import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsPage } from "@/pages/Settings/SettingsPage";
import { ru } from "@/i18n/ru";

describe("SettingsPage", () => {
  it("показывает версию сборки — по ней опознают установленный билд (раздел 12)", () => {
    render(<SettingsPage />);
    expect(screen.getByText(new RegExp(`${ru.settings.version} \\d+\\.\\d+\\.\\d+`))).toBeInTheDocument();
  });
});
