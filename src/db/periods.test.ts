import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import {
  applyBaseRateChange,
  closePeriod,
  getOrCreatePeriod,
  hasClosedPeriods,
  reopenPeriod,
  updatePeriod,
} from "@/db/periods";
import { calculatePeriodTotals } from "@/lib/calc/period";
import type { DayType, Entry, Settings } from "@/types/models";

let db: TimeoDB | undefined;

afterEach(async () => {
  await db?.delete();
  db = undefined;
});

function openDb(): TimeoDB {
  db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  return db;
}

const settings = { default_base_rate: 25, default_norm_hours: 168, default_base_rate_from_period: null };

describe("getOrCreatePeriod", () => {
  it("creates a period from settings defaults when there is no previous period", async () => {
    const database = openDb();

    const period = await getOrCreatePeriod(database, "user-1", 2026, 1, settings);

    expect(period.base_rate).toBe(25);
    expect(period.norm_hours).toBe(168);
  });

  it("returns the same row on a second call instead of creating a duplicate", async () => {
    const database = openDb();

    const first = await getOrCreatePeriod(database, "user-1", 2026, 1, settings);
    const second = await getOrCreatePeriod(database, "user-1", 2026, 1, settings);

    expect(second.id).toBe(first.id);
    const rows = await database.periods.where({ user_id: "user-1", year: 2026, month: 1 }).toArray();
    expect(rows).toHaveLength(1);
  });

  it("copies base_rate/norm_hours from the previous period instead of settings defaults", async () => {
    const database = openDb();
    const january = await getOrCreatePeriod(database, "user-1", 2026, 1, settings);
    await database.periods.update(january.id, { base_rate: 40, norm_hours: 150 });

    const february = await getOrCreatePeriod(database, "user-1", 2026, 2, settings);

    expect(february.base_rate).toBe(40);
    expect(february.norm_hours).toBe(150);
  });

  it("copies values, not a reference — editing the new period never touches the previous one", async () => {
    const database = openDb();
    await getOrCreatePeriod(database, "user-1", 2026, 1, settings);
    const february = await getOrCreatePeriod(database, "user-1", 2026, 2, settings);

    await database.periods.update(february.id, { base_rate: 999 });

    const january = await database.periods.where({ user_id: "user-1", year: 2026, month: 1 }).first();
    expect(january?.base_rate).toBe(25);
  });

  it("falls back to settings defaults when the previous period is in a different year", async () => {
    const database = openDb();

    const january = await getOrCreatePeriod(database, "user-1", 2027, 1, settings);

    expect(january.base_rate).toBe(25);
    expect(january.norm_hours).toBe(168);
  });

  it("never creates two rows when called concurrently for the same period", async () => {
    const database = openDb();

    const [first, second] = await Promise.all([
      getOrCreatePeriod(database, "user-1", 2026, 1, settings),
      getOrCreatePeriod(database, "user-1", 2026, 1, settings),
    ]);

    expect(second.id).toBe(first.id);
    const rows = await database.periods.where({ user_id: "user-1", year: 2026, month: 1 }).toArray();
    expect(rows).toHaveLength(1);
  });
});

// --- Раздел 6.6 (смена базовой ставки) и 6.5 (закрытие периода) ---------------

const USER = "user-1";
const HOURLY = "dt-hourly";

async function seedDayTypes(database: TimeoDB): Promise<void> {
  const now = new Date().toISOString();
  const base = {
    user_id: USER,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    color: "#fff",
    label: "Р",
    note: "",
    rate_mode: "multiplier" as const,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    is_archived: false,
  };
  const rows: DayType[] = [
    { ...base, id: HOURLY, name: "Рабочий день", pay_mode: "hourly", fixed_amount: null, sort_order: 0 },
  ];
  await database.day_types.bulkAdd(rows);
}

async function seedSettings(database: TimeoDB): Promise<Settings> {
  const now = new Date().toISOString();
  const row: Settings = {
    id: "settings-1",
    user_id: USER,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    currency: "PLN",
    period_start_day: 1,
    period_naming: "end_month",
    default_hours: 8,
    theme: "system",
    show_shift_times: false,
    reminder_enabled: false,
    reminder_time: null,
    week_starts_on: "monday",
    weekend_multipliers: { saturday: 1, sunday: 1, holiday: 1 },
    default_base_rate: 25,
    default_norm_hours: 168,
    default_base_rate_from_period: null,
    preferred_rate_change_mode: null,
    seeded_holiday_years: [],
  };
  await database.settings.add(row);
  return row;
}

async function seedEntry(database: TimeoDB, overrides: Partial<Entry> & Pick<Entry, "id" | "date">): Promise<void> {
  const now = new Date().toISOString();
  await database.entries.add({
    user_id: USER,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    day_type_id: HOURLY,
    hours: 8,
    multiplier: 1,
    rate_per_hour: 30,
    rate_is_manual: false,
    amount: 240,
    amount_override: null,
    start_time: null,
    end_time: null,
    break_minutes: null,
    note: "",
    rate_source: "period_base",
    ...overrides,
  });
}

async function periodTotalAmount(database: TimeoDB, year: number, month: number): Promise<number> {
  const period = await database.periods.where({ user_id: USER, year, month }).first();
  if (!period) throw new Error("period not found");
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = `${year}-${String(month).padStart(2, "0")}-31`;
  const entries = await database.entries
    .where("date")
    .between(start, end, true, true)
    .filter((entry) => entry.user_id === USER && entry.deleted_at === null)
    .toArray();
  const dayTypes = await database.day_types.where("user_id").equals(USER).toArray();
  return calculatePeriodTotals(period, entries, new Map(dayTypes.map((dt) => [dt.id, dt]))).amount;
}

describe("getOrCreatePeriod — пропуски в цепочке периодов", () => {
  it("копирует из последнего существующего периода, а не из буквального предыдущего месяца", async () => {
    const database = openDb();
    const august = await getOrCreatePeriod(database, USER, 2026, 8, settings);
    await updatePeriod(database, august.id, { norm_hours: 150 });
    await database.periods.update(august.id, { base_rate: 42 });

    // Сентябрь пропущен: пользователь пролистал календарь с августа на октябрь.
    const october = await getOrCreatePeriod(database, USER, 2026, 10, settings);

    expect(october.base_rate).toBe(42);
    expect(october.norm_hours).toBe(150);
  });

  it("не создаёт пропущенные периоды по дороге (инвариант 7)", async () => {
    const database = openDb();
    await getOrCreatePeriod(database, USER, 2026, 8, settings);
    await getOrCreatePeriod(database, USER, 2026, 10, settings);

    const months = (await database.periods.where("user_id").equals(USER).toArray()).map((p) => p.month).sort((a, b) => a - b);
    expect(months).toEqual([8, 10]);
  });

  it("берёт default_base_rate, отмеченный режимом «со следующего периода»", async () => {
    const database = openDb();
    const august = await getOrCreatePeriod(database, USER, 2026, 8, settings);
    await database.periods.update(august.id, { base_rate: 50 });
    const withPending = {
      default_base_rate: 60,
      default_norm_hours: 168,
      default_base_rate_from_period: { year: 2026, month: 9 },
    };

    const september = await getOrCreatePeriod(database, USER, 2026, 9, withPending);

    expect(september.base_rate).toBe(60);
    // Норма часов режимом не затрагивается — она по-прежнему копируется.
    expect(september.norm_hours).toBe(august.norm_hours);
  });

  it("отмеченная ставка действует и после пропущенных месяцев", async () => {
    const database = openDb();
    const august = await getOrCreatePeriod(database, USER, 2026, 8, settings);
    await database.periods.update(august.id, { base_rate: 50 });
    const withPending = {
      default_base_rate: 60,
      default_norm_hours: 168,
      default_base_rate_from_period: { year: 2026, month: 9 },
    };

    const december = await getOrCreatePeriod(database, USER, 2026, 12, withPending);

    expect(december.base_rate).toBe(60);
  });

  it("после создания отмеченного периода дальнейшие копируют уже у него", async () => {
    const database = openDb();
    await getOrCreatePeriod(database, USER, 2026, 8, settings);
    const withPending = {
      default_base_rate: 60,
      default_norm_hours: 168,
      default_base_rate_from_period: { year: 2026, month: 9 },
    };
    const september = await getOrCreatePeriod(database, USER, 2026, 9, withPending);
    // Пользователь передумал и поправил сентябрь на его собственном экране.
    await database.periods.update(september.id, { base_rate: 70 });

    const october = await getOrCreatePeriod(database, USER, 2026, 10, withPending);

    expect(october.base_rate).toBe(70);
  });

  it("отметка не переписывает периоды раньше неё", async () => {
    const database = openDb();
    const may = await getOrCreatePeriod(database, USER, 2026, 5, settings);
    await database.periods.update(may.id, { base_rate: 50 });
    const withPending = {
      default_base_rate: 60,
      default_norm_hours: 168,
      default_base_rate_from_period: { year: 2026, month: 9 },
    };

    const june = await getOrCreatePeriod(database, USER, 2026, 6, withPending);

    expect(june.base_rate).toBe(50);
  });

  it("не берёт более поздний период за образец", async () => {
    const database = openDb();
    const october = await getOrCreatePeriod(database, USER, 2026, 10, settings);
    await database.periods.update(october.id, { base_rate: 99 });

    const august = await getOrCreatePeriod(database, USER, 2026, 8, settings);

    expect(august.base_rate).toBe(25);
  });
});

describe("applyBaseRateChange", () => {
  it("пересчитывает период и не сдвигает итог соседних периодов ни на грош", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 2, settings);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await getOrCreatePeriod(database, USER, 2026, 4, settings);
    await seedEntry(database, { id: "feb", date: "2026-02-10" });
    await seedEntry(database, { id: "mar", date: "2026-03-10" });
    await seedEntry(database, { id: "apr", date: "2026-04-10" });

    const februaryBefore = await periodTotalAmount(database, 2026, 2);
    const aprilBefore = await periodTotalAmount(database, 2026, 4);

    const result = await applyBaseRateChange(database, USER, {
      year: 2026,
      month: 3,
      newBaseRate: 40,
      mode: "recalculate_period",
      fromDateISO: null,
      periodStartDay: 1,
    });

    expect(result.updatedEntries).toBe(1);
    expect(await periodTotalAmount(database, 2026, 3)).toBe(320);
    expect(await periodTotalAmount(database, 2026, 2)).toBe(februaryBefore);
    expect(await periodTotalAmount(database, 2026, 4)).toBe(aprilBefore);
    expect((await database.entries.get("feb"))?.amount).toBe(240);
    expect((await database.entries.get("apr"))?.amount).toBe(240);
  });

  it("записывает новую базовую ставку в сам период", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);

    await applyBaseRateChange(database, USER, {
      year: 2026,
      month: 3,
      newBaseRate: 40,
      mode: "recalculate_period",
      fromDateISO: null,
      periodStartDay: 1,
    });

    const period = await database.periods.where({ user_id: USER, year: 2026, month: 3 }).first();
    expect(period?.base_rate).toBe(40);
  });

  it("сохраняет ставку записей с rate_is_manual при пересчёте периода", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "auto", date: "2026-03-05" });
    await seedEntry(database, {
      id: "manual",
      date: "2026-03-06",
      rate_is_manual: true,
      rate_per_hour: 55,
      amount: 440,
      rate_source: "manual",
    });

    await applyBaseRateChange(database, USER, {
      year: 2026,
      month: 3,
      newBaseRate: 40,
      mode: "recalculate_period",
      fromDateISO: null,
      periodStartDay: 1,
    });

    expect((await database.entries.get("auto"))?.rate_per_hour).toBe(40);
    expect((await database.entries.get("manual"))?.rate_per_hour).toBe(55);
    expect((await database.entries.get("manual"))?.amount).toBe(440);
  });

  it("режим «с даты» замораживает записи до даты и пересчитывает остальные", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "early", date: "2026-03-05" });
    await seedEntry(database, { id: "late", date: "2026-03-20" });

    await applyBaseRateChange(database, USER, {
      year: 2026,
      month: 3,
      newBaseRate: 40,
      mode: "apply_from_date",
      fromDateISO: "2026-03-15",
      periodStartDay: 1,
    });

    const early = await database.entries.get("early");
    expect(early?.rate_per_hour).toBe(30);
    expect(early?.amount).toBe(240);
    expect(early?.rate_is_manual).toBe(true);
    expect(early?.rate_source).toBe("frozen");
    expect((await database.entries.get("late"))?.rate_per_hour).toBe(40);
  });

  it("режим «со следующего периода» не трогает ни период, ни записи — только настройки", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "mar", date: "2026-03-10" });

    await applyBaseRateChange(database, USER, {
      year: 2026,
      month: 3,
      newBaseRate: 40,
      mode: "apply_next_period",
      fromDateISO: null,
      periodStartDay: 1,
    });

    const period = await database.periods.where({ user_id: USER, year: 2026, month: 3 }).first();
    expect(period?.base_rate).toBe(25);
    expect((await database.entries.get("mar"))?.amount).toBe(240);
    expect((await database.settings.get("settings-1"))?.default_base_rate).toBe(40);
    expect((await database.settings.get("settings-1"))?.default_base_rate_from_period).toEqual({
      year: 2026,
      month: 4,
    });
  });

  it("«со следующего периода» доходит до реально созданного следующего периода", async () => {
    const database = openDb();
    await seedDayTypes(database);
    const settingsRow = await seedSettings(database);
    const march = await getOrCreatePeriod(database, USER, 2026, 3, settingsRow);
    await database.periods.update(march.id, { base_rate: 50 });

    await applyBaseRateChange(database, USER, {
      year: 2026,
      month: 3,
      newBaseRate: 60,
      mode: "apply_next_period",
      fromDateISO: null,
      periodStartDay: 1,
    });

    const updatedSettings = await database.settings.get("settings-1");
    const april = await getOrCreatePeriod(database, USER, 2026, 4, updatedSettings!);
    expect(april.base_rate).toBe(60);
    // Март при этом не сдвинулся ни на грош.
    expect((await database.periods.get(march.id))?.base_rate).toBe(50);
  });

  it("запоминает выбранный режим в настройках", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);

    await applyBaseRateChange(database, USER, {
      year: 2026,
      month: 3,
      newBaseRate: 40,
      mode: "apply_from_date",
      fromDateISO: "2026-03-15",
      periodStartDay: 1,
    });

    expect((await database.settings.get("settings-1"))?.preferred_rate_change_mode).toBe("apply_from_date");
  });

  it("отказывается менять ставку закрытого периода (инвариант 2)", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "mar", date: "2026-03-10" });
    await closePeriod(database, USER, 2026, 3, 1);

    const result = await applyBaseRateChange(database, USER, {
      year: 2026,
      month: 3,
      newBaseRate: 40,
      mode: "recalculate_period",
      fromDateISO: null,
      periodStartDay: 1,
    });

    expect(result.skippedClosed).toBe(true);
    const period = await database.periods.where({ user_id: USER, year: 2026, month: 3 }).first();
    expect(period?.base_rate).toBe(25);
    expect((await database.entries.get("mar"))?.amount).toBe(240);
  });

  it("повторный пересчёт с той же ставкой не обновляет ни одной записи (инвариант 13)", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "mar", date: "2026-03-10" });

    const params = {
      year: 2026,
      month: 3,
      newBaseRate: 40,
      mode: "recalculate_period" as const,
      fromDateISO: null,
      periodStartDay: 1,
    };
    await applyBaseRateChange(database, USER, params);
    const second = await applyBaseRateChange(database, USER, params);

    expect(second.updatedEntries).toBe(0);
  });
});

describe("closePeriod / reopenPeriod", () => {
  it("записывает снимок итогов и перестаёт реагировать на правки записей", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "mar", date: "2026-03-10" });

    await closePeriod(database, USER, 2026, 3, 1);

    const period = await database.periods.where({ user_id: USER, year: 2026, month: 3 }).first();
    expect(period?.is_closed).toBe(true);
    expect(period?.closed_totals).toEqual({ amount: 240, total_hours: 8, norm_hours_covered: 8 });

    await database.entries.update("mar", { amount: 1000, hours: 20 });
    expect(await periodTotalAmount(database, 2026, 3)).toBe(240);
  });

  it("включает extra_amount в снимок", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    const period = await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "mar", date: "2026-03-10" });
    await updatePeriod(database, period.id, { extra_amount: 60 });

    await closePeriod(database, USER, 2026, 3, 1);

    const closed = await database.periods.get(period.id);
    expect(closed?.closed_totals?.amount).toBe(300);
  });

  it("повторное закрытие не переписывает снимок", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "mar", date: "2026-03-10" });
    await closePeriod(database, USER, 2026, 3, 1);

    await database.entries.update("mar", { amount: 1000 });
    await closePeriod(database, USER, 2026, 3, 1);

    const period = await database.periods.where({ user_id: USER, year: 2026, month: 3 }).first();
    expect(period?.closed_totals?.amount).toBe(240);
  });

  it("переоткрытие сохраняет снимок и возвращает суммирование по записям (инвариант 3)", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "mar", date: "2026-03-10" });
    await closePeriod(database, USER, 2026, 3, 1);
    await database.entries.update("mar", { amount: 400 });

    await reopenPeriod(database, USER, 2026, 3);

    const period = await database.periods.where({ user_id: USER, year: 2026, month: 3 }).first();
    expect(period?.is_closed).toBe(false);
    expect(period?.closed_totals?.amount).toBe(240);
    expect(await periodTotalAmount(database, 2026, 3)).toBe(400);
  });

  it("не суммирует записи соседних периодов в снимок", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await seedEntry(database, { id: "mar", date: "2026-03-10" });
    await seedEntry(database, { id: "feb", date: "2026-02-28" });
    await seedEntry(database, { id: "apr", date: "2026-04-01" });

    await closePeriod(database, USER, 2026, 3, 1);

    const period = await database.periods.where({ user_id: USER, year: 2026, month: 3 }).first();
    expect(period?.closed_totals?.amount).toBe(240);
  });

  it("updatePeriod не пишет в закрытый период (инвариант 2)", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    const period = await getOrCreatePeriod(database, USER, 2026, 3, settings);
    await updatePeriod(database, period.id, { extra_amount: 10, extra_note: "до закрытия" });
    await closePeriod(database, USER, 2026, 3, 1);

    await updatePeriod(database, period.id, { extra_amount: 999, extra_note: "после", norm_hours: 1 });

    const stored = await database.periods.get(period.id);
    expect(stored?.extra_amount).toBe(10);
    expect(stored?.extra_note).toBe("до закрытия");
    expect(stored?.norm_hours).toBe(168);
  });

  it("hasClosedPeriods отражает наличие закрытых периодов (инвариант 4)", async () => {
    const database = openDb();
    await seedDayTypes(database);
    await seedSettings(database);
    await getOrCreatePeriod(database, USER, 2026, 3, settings);

    expect(await hasClosedPeriods(database, USER)).toBe(false);
    await closePeriod(database, USER, 2026, 3, 1);
    expect(await hasClosedPeriods(database, USER)).toBe(true);
    await reopenPeriod(database, USER, 2026, 3);
    expect(await hasClosedPeriods(database, USER)).toBe(false);
  });
});

describe("защитные ветки слоя периодов", () => {
  it("мягко удалённый период не считается предыдущим", async () => {
    // Иначе новый период скопировал бы ставку у строки, которой для всех
    // остальных запросов уже не существует (инвариант 38).
    const database = openDb();
    const july = await getOrCreatePeriod(database, "user-1", 2026, 7, settings);
    await database.periods.update(july.id, { base_rate: 99, deleted_at: "2026-07-31T00:00:00.000Z" });

    const august = await getOrCreatePeriod(database, "user-1", 2026, 8, settings);
    expect(august.base_rate).toBe(25);
  });

  it("смена ставки несуществующего периода ничего не меняет и не считается закрытием", async () => {
    const database = openDb();
    const result = await applyBaseRateChange(database, "user-1", {
      year: 2026,
      month: 8,
      newBaseRate: 40,
      mode: "recalculate_period",
      fromDateISO: null,
      periodStartDay: 1,
    });

    expect(result).toEqual({ updatedEntries: 0, skippedClosed: false });
    expect(await database.periods.count()).toBe(0);
  });

  it("переоткрытие открытого или несуществующего периода ничего не делает", async () => {
    const database = openDb();
    await getOrCreatePeriod(database, "user-1", 2026, 8, settings);

    await reopenPeriod(database, "user-1", 2026, 8);
    const open = await database.periods.where({ user_id: "user-1", year: 2026, month: 8 }).first();
    expect(open?.is_closed).toBe(false);

    await expect(reopenPeriod(database, "user-1", 2030, 1)).resolves.toBeUndefined();
  });

  it("правка несуществующего периода молча ничего не делает", async () => {
    const database = openDb();
    await expect(updatePeriod(database, "нет-такого-периода", { norm_hours: 10 })).resolves.toBeUndefined();
    expect(await database.periods.count()).toBe(0);
  });
});
