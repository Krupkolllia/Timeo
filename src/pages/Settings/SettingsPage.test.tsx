import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { SettingsPage } from "@/pages/Settings/SettingsPage";
import { makeEntry, makePeriod, makeSettings, resetDb } from "@/test/factories";
import { ru } from "@/i18n/ru";

const userId = getLocalUserId();

beforeEach(resetDb);

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function seedSettings(overrides: Parameters<typeof makeSettings>[0] = {}) {
  const settings = makeSettings({ user_id: userId, id: "s-local", ...overrides });
  await db.settings.add(settings);
  return settings;
}

describe("SettingsPage", () => {
  it("экран не падает без строки настроек (инвариант 58)", () => {
    renderSettings();
    expect(screen.getByRole("heading", { name: ru.settings.title })).toBeInTheDocument();
  });

  it("раздел 6.5: переключатель отражает и меняет total_hours_paid_only", async () => {
    await seedSettings({ total_hours_paid_only: true });
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

  it("show_shift_times: переключатель отражает и меняет значение", async () => {
    await seedSettings({ show_shift_times: false });
    renderSettings();

    const toggle = await screen.findByRole("switch", { name: ru.settings.showShiftTimesToggle });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(async () => expect((await db.settings.get("s-local"))?.show_shift_times).toBe(true));
  });

  it("базовая ставка и норма по умолчанию доезжают в Dexie", async () => {
    await seedSettings();
    renderSettings();

    const rateInput = await screen.findByLabelText(ru.settings.defaultBaseRate);
    fireEvent.change(rateInput, { target: { value: "37.5" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.default_base_rate).toBe(37.5));

    const normInput = screen.getByLabelText(ru.settings.defaultNormHours);
    fireEvent.change(normInput, { target: { value: "173" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.default_norm_hours).toBe(173));
  });

  it("часы по умолчанию доезжают в Dexie", async () => {
    await seedSettings();
    renderSettings();

    const input = await screen.findByLabelText(ru.settings.defaultHours);
    fireEvent.change(input, { target: { value: "6.5" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.default_hours).toBe(6.5));
  });

  it("день начала периода без закрытых периодов меняется", async () => {
    await seedSettings({ period_start_day: 1 });
    renderSettings();

    const input = await screen.findByLabelText(ru.settings.periodStartDay);
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "15" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.period_start_day).toBe(15));
  });

  it("день начала периода блокируется при закрытом периоде (инвариант 4) и ведёт на список", async () => {
    const settings = await seedSettings({ period_start_day: 1 });
    await db.periods.add(makePeriod({ user_id: userId, is_closed: true }));
    renderSettings();

    const input = await screen.findByLabelText(ru.settings.periodStartDay);
    await waitFor(() => expect(input).toBeDisabled());
    expect(screen.getByText(ru.settings.periodStartDayLocked)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.settings.periodStartDayList }));
    expect(screen.getByTestId("location").textContent).toBe(
      "/settings/past-periods?return=%2Fsettings",
    );
    expect((await db.settings.get(settings.id))?.period_start_day).toBe(1);
  });

  it("мягко удалённый закрытый период не блокирует поле (инвариант 38)", async () => {
    await seedSettings({ period_start_day: 1 });
    await db.periods.add(makePeriod({ user_id: userId, is_closed: true, deleted_at: "2026-08-01T00:00:00.000Z" }));
    renderSettings();

    const input = await screen.findByLabelText(ru.settings.periodStartDay);
    await waitFor(() => expect(input).not.toBeDisabled());
  });

  it("название периода переключается сегментом", async () => {
    await seedSettings({ period_naming: "end_month" });
    renderSettings();

    const button = await screen.findByRole("button", { name: ru.settings.periodNamingByStartMonth });
    fireEvent.click(button);
    await waitFor(async () => expect((await db.settings.get("s-local"))?.period_naming).toBe("start_month"));
  });

  it("валюта: чип и своё поле пишут currency", async () => {
    await seedSettings({ currency: "PLN" });
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: "EUR" }));
    await waitFor(async () => expect((await db.settings.get("s-local"))?.currency).toBe("EUR"));

    const custom = screen.getByLabelText(ru.settings.currencyCustom);
    fireEvent.change(custom, { target: { value: "zł.long" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.currency).toBe("zł.lo"));
  });

  it("своё поле валюты не откатывается к эху предыдущей буквы (свой буфер, как у NumberInput)", async () => {
    await seedSettings({ currency: "PLN" });
    renderSettings();

    const custom = await screen.findByLabelText(ru.settings.currencyCustom);
    fireEvent.change(custom, { target: { value: "z" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.currency).toBe("z"));
    fireEvent.change(custom, { target: { value: "zl" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.currency).toBe("zl"));
    fireEvent.change(custom, { target: { value: "zlo" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.currency).toBe("zlo"));
    expect(custom).toHaveValue("zlo");
  });

  it("тема применяется мгновенно", async () => {
    await seedSettings({ theme: "system" });
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: ru.settings.themeLight }));
    await waitFor(async () => expect((await db.settings.get("s-local"))?.theme).toBe("light"));
  });

  it("раздел 24: отрицательная базовая ставка сохраняется с мягким предупреждением", async () => {
    await seedSettings();
    renderSettings();

    const rateInput = await screen.findByLabelText(ru.settings.defaultBaseRate);
    fireEvent.change(rateInput, { target: { value: "-50" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.default_base_rate).toBe(-50));
    expect(rateInput).toHaveValue("-50");
  });

  it("раздел 33: поле времени напоминания не подставляется само", async () => {
    await seedSettings({ reminder_time: null });
    renderSettings();

    const timeInput = await screen.findByLabelText(ru.settings.reminderTime);
    expect(timeInput).toHaveValue("");
  });

  it("напоминания: тумблер и время пишут в Dexie", async () => {
    await seedSettings({ reminder_enabled: false, reminder_time: null });
    renderSettings();

    const toggle = await screen.findByRole("switch", { name: ru.settings.reminderEnabled });
    fireEvent.click(toggle);
    await waitFor(async () => expect((await db.settings.get("s-local"))?.reminder_enabled).toBe(true));

    const timeInput = screen.getByLabelText(ru.settings.reminderTime);
    fireEvent.change(timeInput, { target: { value: "07:45" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.reminder_time).toBe("07:45"));
  });

  it("«Ставка текущего периода» ведёт с явными year/month, а не голым /period", async () => {
    await seedSettings({ period_start_day: 1 });
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: ru.settings.currentPeriodRateLink }));
    expect(screen.getByTestId("location").textContent).toMatch(/^\/period\?year=\d+&month=\d+$/);
  });

  it("ссылки на типы дня и праздники несут return=/settings", async () => {
    await seedSettings();
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: ru.settings.dayTypesLink }));
    expect(screen.getByTestId("location").textContent).toBe("/settings/day-types?return=%2Fsettings");
  });

  it("инвариант 51: правка каждой настройки не трогает записи и закрытый период", async () => {
    await seedSettings();
    await db.entries.add(makeEntry({ user_id: userId, id: "e-1", updated_at: "2026-08-01T00:00:00.000Z" }));
    await db.periods.add(
      makePeriod({
        user_id: userId,
        id: "p-closed",
        year: 2026,
        month: 7,
        is_closed: true,
        updated_at: "2026-07-01T00:00:00.000Z",
      }),
    );
    renderSettings();

    fireEvent.change(await screen.findByLabelText(ru.settings.defaultBaseRate), { target: { value: "37.5" } });
    fireEvent.change(screen.getByLabelText(ru.settings.defaultNormHours), { target: { value: "173" } });
    fireEvent.change(screen.getByLabelText(ru.settings.defaultHours), { target: { value: "6.5" } });
    fireEvent.click(screen.getByRole("switch", { name: ru.settings.totalHoursPaidOnlyToggle }));
    fireEvent.click(screen.getByRole("switch", { name: ru.settings.showShiftTimesToggle }));
    fireEvent.click(screen.getByRole("button", { name: "EUR" }));
    fireEvent.click(screen.getByRole("button", { name: ru.settings.themeLight }));
    fireEvent.click(screen.getByRole("switch", { name: ru.settings.reminderEnabled }));
    fireEvent.change(screen.getByLabelText(ru.settings.reminderTime), { target: { value: "07:45" } });

    await waitFor(async () => expect((await db.settings.get("s-local"))?.currency).toBe("EUR"));

    const entry = await db.entries.get("e-1");
    expect(entry?.amount).toBe(240);
    expect(entry?.hours).toBe(8);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    const closedPeriod = await db.periods.get("p-closed");
    expect(closedPeriod?.is_closed).toBe(true);
    expect(closedPeriod?.updated_at).toBe("2026-07-01T00:00:00.000Z");
  });
});
