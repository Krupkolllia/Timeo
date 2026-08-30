import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { SettingsPage } from "@/pages/Settings/SettingsPage";
import { makeSettings, resetDb } from "@/test/factories";
import { ru } from "@/i18n/ru";

const userId = getLocalUserId();

beforeEach(resetDb);

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

describe("SettingsPage", () => {
  it("показывает версию сборки — по ней опознают установленный билд (раздел 12)", () => {
    renderSettings();
    expect(screen.getByText(new RegExp(`${ru.settings.version} \\d+\\.\\d+\\.\\d+`))).toBeInTheDocument();
  });

  it("раздел 6.5: переключатель отражает и меняет total_hours_paid_only", async () => {
    await db.settings.add(makeSettings({ user_id: userId, id: "s-local", total_hours_paid_only: true }));
    renderSettings();

    const toggle = await screen.findByRole("switch", { name: ru.settings.totalHoursPaidOnlyToggle });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    await waitFor(async () => {
      const settings = await db.settings.get("s-local");
      expect(settings?.total_hours_paid_only).toBe(false);
    });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });
});
