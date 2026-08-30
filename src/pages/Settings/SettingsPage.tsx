import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router-dom";
import { TabBar } from "@/components/TabBar";
import { NumberInput } from "@/components/NumberInput";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { hasClosedPeriods } from "@/db/periods";
import { setPeriodStartDay, updateSettings } from "@/db/settings";
import type { PeriodNaming, Theme } from "@/types/models";
import { ru } from "@/i18n/ru";

const userId = getLocalUserId();

const CURRENCY_CHIPS = ["PLN", "EUR", "USD", "GBP", "UAH"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-app-fg/50">{title}</p>
      <div className="mt-2 flex flex-col gap-3 rounded-xl bg-app-fg/5 px-3 py-3">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="-my-2 flex h-11 w-11 shrink-0 items-center justify-end"
    >
      <span className={`relative block h-6 w-11 rounded-full transition-colors ${checked ? "bg-app-accent" : "bg-app-fg/20"}`}>
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-[left] ${checked ? "left-[22px]" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), []);
  const periodLocked = useLiveQuery(() => hasClosedPeriods(db, userId), []) ?? false;

  return (
    <div className="min-h-dvh bg-app-bg p-4 text-app-fg" style={{ paddingBottom: "calc(var(--tabbar-h) + 1rem)" }}>
      <h1 className="pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-4 text-lg font-semibold tracking-tight">
        {ru.settings.title}
      </h1>

      {settings && (
        <div className="flex flex-col gap-4">
          <Section title={ru.settings.newPeriodsSection}>
            <div>
              <label className="text-xs text-app-fg/50" htmlFor="settings-default-base-rate">
                {ru.settings.defaultBaseRate}
              </label>
              <NumberInput
                id="settings-default-base-rate"
                className="mt-1 w-full rounded-lg bg-app-bg px-2 py-3 text-lg"
                value={settings.default_base_rate}
                onChange={(default_base_rate) => void updateSettings(db, settings.id, { default_base_rate })}
              />
            </div>
            <div>
              <label className="text-xs text-app-fg/50" htmlFor="settings-default-norm-hours">
                {ru.settings.defaultNormHours}
              </label>
              <NumberInput
                id="settings-default-norm-hours"
                className="mt-1 w-full rounded-lg bg-app-bg px-2 py-3 text-lg"
                value={settings.default_norm_hours}
                onChange={(default_norm_hours) => void updateSettings(db, settings.id, { default_norm_hours })}
              />
            </div>
            <p className="text-xs text-app-fg/40">{ru.settings.newPeriodsHint}</p>
            <button
              className="-my-2 min-h-11 self-start px-0 text-sm font-semibold text-app-accent-text"
              onClick={() => navigate("/period")}
            >
              {ru.settings.currentPeriodRateLink}
            </button>
          </Section>

          <Section title={ru.settings.periodSection}>
            <div>
              <label className="text-xs text-app-fg/50" htmlFor="settings-period-start-day">
                {ru.settings.periodStartDay}
              </label>
              <NumberInput
                id="settings-period-start-day"
                disabled={periodLocked}
                inputMode="numeric"
                className="mt-1 w-full rounded-lg bg-app-bg px-2 py-3 text-lg disabled:opacity-50"
                value={settings.period_start_day}
                onChange={(day) => void setPeriodStartDay(db, userId, settings.id, Math.trunc(day))}
              />
              {periodLocked ? (
                <div className="mt-1 flex flex-col gap-1">
                  <p className="text-xs text-app-fg/40">{ru.settings.periodStartDayLocked}</p>
                  <button
                    className="-my-1 min-h-11 self-start px-0 text-left text-xs font-semibold text-app-accent-text"
                    onClick={() => navigate(`/settings/past-periods?return=${encodeURIComponent("/settings")}`)}
                  >
                    {ru.settings.periodStartDayList}
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-app-fg/40">{ru.settings.periodStartDayWarning}</p>
              )}
            </div>

            <div>
              <p className="text-xs text-app-fg/50">{ru.settings.periodNaming}</p>
              <div className="mt-1 flex gap-2">
                {(["start_month", "end_month"] as PeriodNaming[]).map((mode) => (
                  <button
                    key={mode}
                    aria-pressed={settings.period_naming === mode}
                    onClick={() => void updateSettings(db, settings.id, { period_naming: mode })}
                    className={`min-h-11 flex-1 rounded-lg px-3 text-sm ${
                      settings.period_naming === mode ? "bg-app-accent font-semibold text-app-accent-fg" : "bg-app-bg"
                    }`}
                  >
                    {mode === "start_month" ? ru.settings.periodNamingByStartMonth : ru.settings.periodNamingByEndMonth}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-app-fg/40">{ru.settings.periodNamingSameHint}</p>
            </div>
          </Section>

          <Section title={ru.settings.hoursSection}>
            <div>
              <label className="text-xs text-app-fg/50" htmlFor="settings-default-hours">
                {ru.settings.defaultHours}
              </label>
              <NumberInput
                id="settings-default-hours"
                className="mt-1 w-full rounded-lg bg-app-bg px-2 py-3 text-lg"
                value={settings.default_hours}
                onChange={(default_hours) => void updateSettings(db, settings.id, { default_hours })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{ru.settings.totalHoursPaidOnlyToggle}</p>
                <p className="mt-1 text-xs text-app-fg/40">{ru.settings.totalHoursPaidOnlyHint}</p>
              </div>
              <Toggle
                checked={settings.total_hours_paid_only}
                onChange={(total_hours_paid_only) => void updateSettings(db, settings.id, { total_hours_paid_only })}
                label={ru.settings.totalHoursPaidOnlyToggle}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm">{ru.settings.showShiftTimesToggle}</p>
                <p className="mt-1 text-xs text-app-fg/40">{ru.settings.showShiftTimesHint}</p>
              </div>
              <Toggle
                checked={settings.show_shift_times}
                onChange={(show_shift_times) => void updateSettings(db, settings.id, { show_shift_times })}
                label={ru.settings.showShiftTimesToggle}
              />
            </div>
          </Section>

          <Section title={ru.settings.currencySection}>
            <div className="flex flex-wrap gap-2">
              {CURRENCY_CHIPS.map((code) => (
                <button
                  key={code}
                  aria-pressed={settings.currency === code}
                  onClick={() => void updateSettings(db, settings.id, { currency: code })}
                  className={`min-h-11 rounded-lg px-3 text-sm ${
                    settings.currency === code ? "bg-app-accent font-semibold text-app-accent-fg" : "bg-app-bg"
                  }`}
                >
                  {code}
                </button>
              ))}
            </div>
            <input
              aria-label={ru.settings.currencyCustom}
              placeholder={ru.settings.currencyCustom}
              className="w-full rounded-lg bg-app-bg px-2 py-3 text-sm"
              value={settings.currency}
              onChange={(e) => void updateSettings(db, settings.id, { currency: e.target.value.slice(0, 5) })}
            />
          </Section>

          <Section title={ru.settings.appearanceSection}>
            <div className="flex gap-2">
              {(
                [
                  ["system", ru.settings.themeSystem],
                  ["light", ru.settings.themeLight],
                  ["dark", ru.settings.themeDark],
                ] as [Theme, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={settings.theme === value}
                  onClick={() => void updateSettings(db, settings.id, { theme: value })}
                  className={`min-h-11 flex-1 rounded-lg px-2 text-sm ${
                    settings.theme === value ? "bg-app-accent font-semibold text-app-accent-fg" : "bg-app-bg"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Section>

          <Section title={ru.settings.remindersSection}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm">{ru.settings.reminderEnabled}</p>
              <Toggle
                checked={settings.reminder_enabled}
                onChange={(reminder_enabled) => void updateSettings(db, settings.id, { reminder_enabled })}
                label={ru.settings.reminderEnabled}
              />
            </div>
            <div>
              <label className="text-xs text-app-fg/50" htmlFor="settings-reminder-time">
                {ru.settings.reminderTime}
              </label>
              <input
                id="settings-reminder-time"
                type="time"
                className="mt-1 w-full rounded-lg bg-app-bg px-2 py-3 text-lg"
                value={settings.reminder_time ?? ""}
                onChange={(e) =>
                  void updateSettings(db, settings.id, { reminder_time: e.target.value === "" ? null : e.target.value })
                }
              />
            </div>
            <p className="text-xs text-app-fg/40">{ru.settings.reminderNotice}</p>
          </Section>

          <Section title={ru.settings.rulesSection}>
            <button
              className="min-h-11 rounded-lg bg-app-bg px-3 py-3 text-left text-sm active:bg-app-fg/10"
              onClick={() => navigate(`/settings/day-types?return=${encodeURIComponent("/settings")}`)}
            >
              {ru.settings.dayTypesLink}
            </button>
            <button
              className="min-h-11 rounded-lg bg-app-bg px-3 py-3 text-left text-sm active:bg-app-fg/10"
              onClick={() => navigate(`/settings/holidays?return=${encodeURIComponent("/settings")}`)}
            >
              {ru.settings.holidaysLink}
            </button>
            <p className="text-xs text-app-fg/40">{ru.settings.holidaysLinkHint}</p>
          </Section>

          <p className="pb-2 text-xs text-app-fg/40">{ru.settings.footerNote}</p>
        </div>
      )}

      <TabBar />
    </div>
  );
}
