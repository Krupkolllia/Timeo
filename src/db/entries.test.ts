import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { createEntry, listActiveEntriesForDate, restoreEntry, softDeleteEntry, updateEntry } from "@/db/entries";
import type { Entry } from "@/types/models";

let db: TimeoDB | undefined;

afterEach(async () => {
  await db?.delete();
  db = undefined;
});

function openDb(): TimeoDB {
  db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  return db;
}

const baseFields: Omit<Entry, "id" | "created_at" | "updated_at" | "deleted_at"> = {
  user_id: "user-1",
  date: "2026-01-05",
  day_type_id: "dt-1",
  hours: 8,
  multiplier: 1,
  rate_per_hour: 20,
  rate_is_manual: false,
  amount: 160,
  amount_override: null,
  start_time: null,
  end_time: null,
  break_minutes: null,
  paid_break_minutes: null,
  duration_is_manual: false,
  note: "",
  rate_source: "period_base",
};

/**
 * createEntry возвращает null, если дата попала в закрытый период (инвариант 2).
 * В этих тестах ни периодов, ни настроек нет вовсе, поэтому отказ означал бы
 * поломку самой защиты, а не ожидаемое поведение — падаем сразу.
 */
async function createOrFail(
  database: TimeoDB,
  fields: Omit<Entry, "id" | "created_at" | "updated_at" | "deleted_at">,
): Promise<Entry> {
  const created = await createEntry(database, fields);
  if (!created) throw new Error("createEntry refused a write with no period in the database");
  return created;
}

describe("createEntry", () => {
  it("generates id/timestamps and persists the row", async () => {
    const database = openDb();

    const entry = await createOrFail(database, baseFields);

    expect(entry.id).toBeTruthy();
    expect(entry.deleted_at).toBeNull();
    const stored = await database.entries.get(entry.id);
    expect(stored).toMatchObject(baseFields);
  });
});

describe("listActiveEntriesForDate", () => {
  it("returns only entries for the given user and date, excluding soft-deleted ones", async () => {
    const database = openDb();
    const mine = await createOrFail(database, baseFields);
    await createOrFail(database, { ...baseFields, user_id: "user-2" });
    await createOrFail(database, { ...baseFields, date: "2026-01-06" });
    const deleted = await createOrFail(database, baseFields);
    await softDeleteEntry(database, deleted.id);

    const result = await listActiveEntriesForDate(database, "user-1", "2026-01-05");

    expect(result.map((e) => e.id)).toEqual([mine.id]);
  });
});

describe("updateEntry", () => {
  it("applies a partial patch and bumps updated_at", async () => {
    const database = openDb();
    const entry = await createOrFail(database, baseFields);

    await updateEntry(database, entry.id, { hours: 10, amount: 200 });

    const updated = await database.entries.get(entry.id);
    expect(updated?.hours).toBe(10);
    expect(updated?.amount).toBe(200);
    expect(updated?.note).toBe(""); // untouched fields survive a partial patch
    expect(updated?.updated_at).not.toBe(entry.updated_at);
  });
});

describe("softDeleteEntry / restoreEntry", () => {
  it("soft-deletes without removing the row, and restore clears deleted_at", async () => {
    const database = openDb();
    const entry = await createOrFail(database, baseFields);

    await softDeleteEntry(database, entry.id);
    const deleted = await database.entries.get(entry.id);
    expect(deleted?.deleted_at).not.toBeNull();
    expect(await listActiveEntriesForDate(database, "user-1", "2026-01-05")).toHaveLength(0);

    await restoreEntry(database, entry.id);
    const restored = await database.entries.get(entry.id);
    expect(restored?.deleted_at).toBeNull();
    expect(await listActiveEntriesForDate(database, "user-1", "2026-01-05")).toHaveLength(1);
  });
});

// --- Инвариант 2: закрытый период неизменяем ---------------------------------

const CLOSED_USER = "user-1";

async function seedOpenPeriodAndSettings(database: TimeoDB): Promise<string> {
  const now = new Date().toISOString();
  await database.settings.add({
    id: "settings-1",
    user_id: CLOSED_USER,
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
    total_hours_paid_only: true,
  });
  const id = crypto.randomUUID();
  await database.periods.add({
    id,
    user_id: CLOSED_USER,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    year: 2026,
    month: 1,
    base_rate: 25,
    norm_hours: 168,
    extra_amount: 0,
    extra_note: "",
    is_closed: false,
    closed_totals: null,
    is_manual: false,
  });
  return id;
}

describe("защита закрытого периода", () => {
  it("createEntry отказывает и ничего не пишет", async () => {
    const database = openDb();
    const periodId = await seedOpenPeriodAndSettings(database);
    await database.periods.update(periodId, { is_closed: true });

    const created = await createEntry(database, baseFields);

    expect(created).toBeNull();
    expect(await database.entries.count()).toBe(0);
  });

  it("updateEntry не трогает запись закрытого периода", async () => {
    const database = openDb();
    const periodId = await seedOpenPeriodAndSettings(database);
    const entry = await createOrFail(database, baseFields);
    await database.periods.update(periodId, { is_closed: true });

    await updateEntry(database, entry.id, { hours: 99, amount: 9999 });

    const stored = await database.entries.get(entry.id);
    expect(stored?.hours).toBe(8);
    expect(stored?.amount).toBe(160);
    expect(stored?.updated_at).toBe(entry.updated_at);
  });

  it("softDeleteEntry и restoreEntry в закрытом периоде не срабатывают", async () => {
    const database = openDb();
    const periodId = await seedOpenPeriodAndSettings(database);
    const entry = await createOrFail(database, baseFields);
    await database.periods.update(periodId, { is_closed: true });

    await softDeleteEntry(database, entry.id);
    expect((await database.entries.get(entry.id))?.deleted_at).toBeNull();

    await database.periods.update(periodId, { is_closed: false });
    await softDeleteEntry(database, entry.id);
    await database.periods.update(periodId, { is_closed: true });
    await restoreEntry(database, entry.id);
    expect((await database.entries.get(entry.id))?.deleted_at).not.toBeNull();
  });

  it("открытый период правится как раньше", async () => {
    const database = openDb();
    await seedOpenPeriodAndSettings(database);
    const entry = await createOrFail(database, baseFields);

    await updateEntry(database, entry.id, { hours: 10 });

    expect((await database.entries.get(entry.id))?.hours).toBe(10);
  });

  it("дата соседнего открытого периода не задета закрытием января", async () => {
    const database = openDb();
    const periodId = await seedOpenPeriodAndSettings(database);
    await database.periods.update(periodId, { is_closed: true });

    const february = await createEntry(database, { ...baseFields, date: "2026-02-03" });

    expect(february).not.toBeNull();
  });

  it("правка несуществующей записи молча ничего не делает", async () => {
    // Запись могла быть удалена на другом устройстве между рендером и правкой:
    // падать здесь нечем, но и создавать строку из патча нельзя.
    const database = openDb();
    await expect(updateEntry(database, "нет-такой-записи", { hours: 5 })).resolves.toBeUndefined();
    expect(await database.entries.count()).toBe(0);
  });
});
