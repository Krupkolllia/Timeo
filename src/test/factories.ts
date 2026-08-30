import { db } from "@/db/db";
import type { DayType, Entry, Holiday, Period, Settings } from "@/types/models";
import { DEFAULT_SETTINGS } from "@/db/settings";

export const USER_ID = "user-test";

const TIMESTAMPS = { created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z", deleted_at: null };

export function makeDayType(overrides: Partial<DayType> = {}): DayType {
  return {
    id: "dt-hourly",
    user_id: USER_ID,
    ...TIMESTAMPS,
    name: "Рабочий день",
    color: "#38bdf8",
    label: "Р",
    note: "",
    rate_mode: "multiplier",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 0,
    is_archived: false,
    ...overrides,
  };
}

export function makePeriod(overrides: Partial<Period> = {}): Period {
  return {
    id: "p-2026-08",
    user_id: USER_ID,
    ...TIMESTAMPS,
    year: 2026,
    month: 8,
    base_rate: 30,
    norm_hours: 160,
    extra_amount: 0,
    extra_note: "",
    is_closed: false,
    closed_totals: null,
    is_manual: false,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: "s-1",
    user_id: USER_ID,
    ...TIMESTAMPS,
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

export function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "e-1",
    user_id: USER_ID,
    ...TIMESTAMPS,
    date: "2026-08-10",
    day_type_id: "dt-hourly",
    hours: 8,
    multiplier: 1,
    rate_per_hour: 30,
    rate_is_manual: false,
    amount: 240,
    amount_override: null,
    start_time: null,
    end_time: null,
    break_minutes: null,
    paid_break_minutes: null,
    duration_is_manual: false,
    note: "",
    rate_source: "period_base",
    ...overrides,
  };
}

export function makeHoliday(overrides: Partial<Holiday> = {}): Holiday {
  return {
    id: "h-1",
    user_id: USER_ID,
    ...TIMESTAMPS,
    date: "2026-08-10",
    name: "Праздник",
    is_custom: false,
    ...overrides,
  };
}

/** Полная очистка singleton-базы между тестами: экраны читают именно её. */
export async function resetDb(): Promise<void> {
  await db.transaction("rw", db.settings, db.periods, db.day_types, db.entries, db.holidays, async () => {
    await Promise.all([
      db.settings.clear(),
      db.periods.clear(),
      db.day_types.clear(),
      db.entries.clear(),
      db.holidays.clear(),
    ]);
  });
}
