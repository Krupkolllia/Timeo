import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import {
  applyDayTypeChange,
  countDayTypeChangeTargets,
  createDayType,
  deleteDayType,
  ensureDayTypesSeeded,
  listDayTypes,
  PRESET_DAY_TYPES,
  reorderDayTypes,
  restoreDayType,
  setDayTypeArchived,
  updateDayType,
  type DayTypeDraft,
} from "@/db/dayTypes";
import type { Entry, Holiday, Period } from "@/types/models";

let db: TimeoDB | undefined;

afterEach(async () => {
  await db?.delete();
  db = undefined;
});

function openDb(): TimeoDB {
  db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  return db;
}

describe("ensureDayTypesSeeded", () => {
  it("seeds all preset day types for a new user", async () => {
    const database = openDb();

    await ensureDayTypesSeeded(database, "user-1");

    const rows = await database.day_types.where("user_id").equals("user-1").toArray();
    expect(rows).toHaveLength(PRESET_DAY_TYPES.length);
    expect(rows.map((r) => r.name).sort()).toEqual(PRESET_DAY_TYPES.map((p) => p.name).sort());
  });

  it("marks vacation and sick leave to ignore automatic weekend/holiday multipliers", async () => {
    const database = openDb();

    await ensureDayTypesSeeded(database, "user-1");

    const rows = await database.day_types.where("user_id").equals("user-1").toArray();
    const vacation = rows.find((r) => r.name === "Отпуск");
    const sickLeave = rows.find((r) => r.name === "Больничный");
    expect(vacation?.ignore_auto_multipliers).toBe(true);
    expect(sickLeave?.ignore_auto_multipliers).toBe(true);
  });

  it("is idempotent — running it again does not duplicate rows", async () => {
    const database = openDb();

    await ensureDayTypesSeeded(database, "user-1");
    await ensureDayTypesSeeded(database, "user-1");

    const rows = await database.day_types.where("user_id").equals("user-1").toArray();
    expect(rows).toHaveLength(PRESET_DAY_TYPES.length);
  });

  it("never duplicates the preset when called concurrently (e.g. React StrictMode double effect)", async () => {
    const database = openDb();

    await Promise.all([ensureDayTypesSeeded(database, "user-1"), ensureDayTypesSeeded(database, "user-1")]);

    const rows = await database.day_types.where("user_id").equals("user-1").toArray();
    expect(rows).toHaveLength(PRESET_DAY_TYPES.length);
  });

  it("seeds independently per user", async () => {
    const database = openDb();

    await ensureDayTypesSeeded(database, "user-1");
    await ensureDayTypesSeeded(database, "user-2");

    const user1Rows = await database.day_types.where("user_id").equals("user-1").toArray();
    const user2Rows = await database.day_types.where("user_id").equals("user-2").toArray();
    expect(user1Rows).toHaveLength(PRESET_DAY_TYPES.length);
    expect(user2Rows).toHaveLength(PRESET_DAY_TYPES.length);
  });
});

const USER = "user-1";
const WEEKEND = { saturday: 1.5, sunday: 2, holiday: 2.5 };
const SCOPE = { year: 2026, month: 8, periodStartDay: 1, weekendMultipliers: WEEKEND };

function draft(overrides: Partial<DayTypeDraft> = {}): DayTypeDraft {
  return {
    name: "Рабочий день",
    color: "#38bdf8",
    label: "Р",
    note: "",
    pay_mode: "hourly",
    rate_mode: "multiplier",
    fixed_amount: null,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    ...overrides,
  };
}

async function seedPeriod(database: TimeoDB, patch: Partial<Period> = {}): Promise<void> {
  await database.periods.add({
    id: "p-2026-08",
    user_id: USER,
    created_at: "",
    updated_at: "",
    deleted_at: null,
    year: 2026,
    month: 8,
    base_rate: 30,
    norm_hours: 160,
    extra_amount: 0,
    extra_note: "",
    is_closed: false,
    closed_totals: null,
    is_manual: false,
    ...patch,
  });
}

async function seedEntry(database: TimeoDB, dayTypeId: string, patch: Partial<Entry> = {}): Promise<Entry> {
  const entry: Entry = {
    id: "e-1",
    user_id: USER,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    deleted_at: null,
    date: "2026-08-10",
    day_type_id: dayTypeId,
    hours: 8,
    multiplier: 1,
    rate_per_hour: 30,
    rate_is_manual: false,
    amount: 240,
    amount_override: null,
    start_time: null,
    end_time: null,
    break_minutes: null,
    duration_is_manual: false,
    note: "",
    rate_source: "period_base",
    ...patch,
  };
  await database.entries.add(entry);
  return entry;
}

describe("createDayType", () => {
  it("ставит новый тип в конец списка", async () => {
    const database = openDb();

    const first = await createDayType(database, USER, draft({ name: "Первый" }));
    const second = await createDayType(database, USER, draft({ name: "Второй" }));

    expect(second.sort_order).toBe(first.sort_order + 1);
    expect(second.is_archived).toBe(false);
    expect(second.deleted_at).toBeNull();
  });

  it("не выдаёт один и тот же порядок двум параллельным созданиям", async () => {
    const database = openDb();

    const [a, b] = await Promise.all([
      createDayType(database, USER, draft({ name: "A" })),
      createDayType(database, USER, draft({ name: "B" })),
    ]);

    expect(a.sort_order).not.toBe(b.sort_order);
  });

  it("не блокирует пустое имя, нулевой множитель и отрицательную ставку (инвариант 54)", async () => {
    const database = openDb();

    const row = await createDayType(
      database,
      USER,
      draft({ name: "", label: "", default_multiplier: 0, default_rate: -10, rate_mode: "pinned" }),
    );

    expect(await database.day_types.get(row.id)).toBeDefined();
  });
});

describe("listDayTypes", () => {
  it("отдаёт архивные, но не отдаёт удалённые (инвариант 38)", async () => {
    const database = openDb();
    const kept = await createDayType(database, USER, draft({ name: "Обычный" }));
    const archived = await createDayType(database, USER, draft({ name: "Архивный" }));
    const removed = await createDayType(database, USER, draft({ name: "Удалённый" }));
    await setDayTypeArchived(database, archived.id, true);
    await deleteDayType(database, removed.id);

    const rows = await listDayTypes(database, USER);

    expect(rows.map((r) => r.id).sort()).toEqual([kept.id, archived.id].sort());
  });
});

describe("updateDayType", () => {
  it("не изменяет ни одной существующей записи (инвариант 10)", async () => {
    const database = openDb();
    await seedPeriod(database);
    const dayType = await createDayType(database, USER, draft());
    const before = await seedEntry(database, dayType.id);

    await updateDayType(database, dayType.id, { default_multiplier: 2, name: "Другое" });

    const after = await database.entries.get(before.id);
    expect(after).toEqual(before);
  });
});

describe("setDayTypeArchived", () => {
  it("архивирует и возвращает обратно (инвариант 12)", async () => {
    const database = openDb();
    const dayType = await createDayType(database, USER, draft());

    await setDayTypeArchived(database, dayType.id, true);
    expect((await database.day_types.get(dayType.id))?.is_archived).toBe(true);

    await setDayTypeArchived(database, dayType.id, false);
    expect((await database.day_types.get(dayType.id))?.is_archived).toBe(false);
  });
});

describe("deleteDayType", () => {
  it("отказывает, пока на тип ссылается запись (инварианты 11 и 35)", async () => {
    const database = openDb();
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id);

    const result = await deleteDayType(database, dayType.id);

    expect(result).toEqual({ deleted: false, referencingEntries: 1 });
    expect((await database.day_types.get(dayType.id))?.deleted_at).toBeNull();
  });

  it("не считает ссылками записи другого пользователя", async () => {
    // После миграции локальных данных при первом входе (блок 8) в базе
    // окажутся строки под двумя user_id. Чужая запись отказывала бы в удалении
    // без объяснения.
    const database = openDb();
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id, { id: "e-other-user", user_id: "user-2" });

    expect((await deleteDayType(database, dayType.id)).deleted).toBe(true);
  });

  it("отказывает и из-за мягко удалённой записи: её ещё держит окно отмены", async () => {
    const database = openDb();
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id, { deleted_at: "2026-08-10T10:00:00.000Z" });

    expect((await deleteDayType(database, dayType.id)).deleted).toBe(false);
  });

  it("удаляет мягко и восстанавливается, когда ссылок нет (CLAUDE.md: необратимо ничего)", async () => {
    const database = openDb();
    const dayType = await createDayType(database, USER, draft());

    expect((await deleteDayType(database, dayType.id)).deleted).toBe(true);
    expect((await database.day_types.get(dayType.id))?.deleted_at).not.toBeNull();

    await restoreDayType(database, dayType.id);
    expect((await database.day_types.get(dayType.id))?.deleted_at).toBeNull();
  });
});

describe("reorderDayTypes", () => {
  it("перенумеровывает и мягко удалённые типы: иначе отмена удаления даёт два одинаковых номера", async () => {
    const database = openDb();
    const a = await createDayType(database, USER, draft({ name: "A" }));
    const b = await createDayType(database, USER, draft({ name: "B" }));
    const c = await createDayType(database, USER, draft({ name: "C" }));
    await deleteDayType(database, b.id);

    // Экран удалённый тип не видит и в порядке его не присылает.
    await reorderDayTypes(database, USER, [c.id, a.id]);
    await restoreDayType(database, b.id);

    const orders = (await listDayTypes(database, USER)).map((row) => row.sort_order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("переставляет типы в заданном порядке", async () => {
    const database = openDb();
    const a = await createDayType(database, USER, draft({ name: "A" }));
    const b = await createDayType(database, USER, draft({ name: "B" }));
    const c = await createDayType(database, USER, draft({ name: "C" }));

    await reorderDayTypes(database, USER, [c.id, a.id, b.id]);

    const rows = await listDayTypes(database, USER);
    expect(rows.map((r) => r.name)).toEqual(["C", "A", "B"]);
  });
});

describe("countDayTypeChangeTargets / applyDayTypeChange (раздел 6.7)", () => {
  it("считает и обновляет записи текущего периода после финансовой правки", async () => {
    const database = openDb();
    await seedPeriod(database);
    const dayType = await createDayType(database, USER, draft());
    const entry = await seedEntry(database, dayType.id);
    await updateDayType(database, dayType.id, { default_multiplier: 1.5 });

    const scope = { ...SCOPE, dayTypeId: dayType.id };
    expect(await countDayTypeChangeTargets(database, USER, scope)).toBe(1);

    expect(await applyDayTypeChange(database, USER, scope)).toBe(1);
    const updated = await database.entries.get(entry.id);
    expect(updated?.amount).toBe(360);
    expect(updated?.multiplier).toBe(1.5);
    // Время правки обновляется: это настоящее изменение записи, в отличие от
    // миграции.
    expect(updated?.updated_at).not.toBe(entry.updated_at);
  });

  it("не считает и не трогает записи закрытого периода (инвариант 2)", async () => {
    const database = openDb();
    await seedPeriod(database, { is_closed: true, closed_totals: { amount: 240, total_hours: 8, norm_hours_covered: 8 } });
    const dayType = await createDayType(database, USER, draft());
    const entry = await seedEntry(database, dayType.id);
    await updateDayType(database, dayType.id, { default_multiplier: 1.5 });

    const scope = { ...SCOPE, dayTypeId: dayType.id };
    expect(await countDayTypeChangeTargets(database, USER, scope)).toBe(0);
    expect(await applyDayTypeChange(database, USER, scope)).toBe(0);
    expect((await database.entries.get(entry.id))?.amount).toBe(240);
  });

  it("не трогает записи прошлого периода даже при согласии (раздел 6.7)", async () => {
    const database = openDb();
    await seedPeriod(database);
    const dayType = await createDayType(database, USER, draft());
    const past = await seedEntry(database, dayType.id, { id: "e-past", date: "2026-07-20" });
    await updateDayType(database, dayType.id, { default_multiplier: 1.5 });

    expect(await applyDayTypeChange(database, USER, { ...SCOPE, dayTypeId: dayType.id })).toBe(0);
    expect((await database.entries.get(past.id))?.amount).toBe(240);
  });

  it("исключает записи с ручной ставкой и ручной суммой из счёта и из обновления", async () => {
    const database = openDb();
    await seedPeriod(database);
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id, { id: "e-manual", rate_is_manual: true, rate_per_hour: 50, amount: 400 });
    await seedEntry(database, dayType.id, { id: "e-override", date: "2026-08-11", amount_override: 500, amount: 500 });
    await updateDayType(database, dayType.id, { default_multiplier: 1.5 });

    expect(await countDayTypeChangeTargets(database, USER, { ...SCOPE, dayTypeId: dayType.id })).toBe(0);
    expect((await database.entries.get("e-manual"))?.amount).toBe(400);
    expect((await database.entries.get("e-override"))?.amount).toBe(500);
  });

  it("учитывает праздник при пересчёте", async () => {
    const database = openDb();
    await seedPeriod(database);
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id, { date: "2026-08-12" });
    await database.holidays.add({
      id: "h-1",
      user_id: USER,
      created_at: "",
      updated_at: "",
      deleted_at: null,
      date: "2026-08-12",
      name: "Праздник",
      is_custom: false,
    });
    await updateDayType(database, dayType.id, { default_multiplier: 1.5 });

    await applyDayTypeChange(database, USER, { ...SCOPE, dayTypeId: dayType.id });
    // Правило праздника заменяет множитель типа дня, а не перемножается с ним.
    expect((await database.entries.get("e-1"))?.multiplier).toBe(2.5);
  });

  it("обновляет записи pinned-типа и во второй раз (флаг ручной ставки поставил сам механизм)", async () => {
    const database = openDb();
    await seedPeriod(database);
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id);
    const scope = { ...SCOPE, dayTypeId: dayType.id };

    await updateDayType(database, dayType.id, { rate_mode: "pinned", default_rate: 50 });
    expect(await applyDayTypeChange(database, USER, scope)).toBe(1);
    expect((await database.entries.get("e-1"))?.amount).toBe(400);

    // Вторая правка той же ставки: без исключения по rate_source запись уже
    // помечена rate_is_manual и молча выпадала бы из пересчёта навсегда.
    await updateDayType(database, dayType.id, { default_rate: 60 });
    expect(await countDayTypeChangeTargets(database, USER, scope)).toBe(1);
    expect(await applyDayTypeChange(database, USER, scope)).toBe(1);
    expect((await database.entries.get("e-1"))?.amount).toBe(480);
  });

  it("возвращает записи к базовой ставке, когда замок открывают обратно", async () => {
    const database = openDb();
    await seedPeriod(database);
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id);
    const scope = { ...SCOPE, dayTypeId: dayType.id };

    await updateDayType(database, dayType.id, { rate_mode: "pinned", default_rate: 50 });
    await applyDayTypeChange(database, USER, scope);

    await updateDayType(database, dayType.id, { rate_mode: "multiplier" });
    await applyDayTypeChange(database, USER, scope);

    const entry = await database.entries.get("e-1");
    expect(entry?.rate_per_hour).toBe(30);
    expect(entry?.rate_is_manual).toBe(false);
    expect(entry?.rate_source).toBe("period_base");
    expect(entry?.amount).toBe(240);
  });

  it("по-прежнему не трогает ставку, вписанную человеком", async () => {
    const database = openDb();
    await seedPeriod(database);
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id, { rate_is_manual: true, rate_source: "manual", rate_per_hour: 50, amount: 400 });

    await updateDayType(database, dayType.id, { rate_mode: "pinned", default_rate: 70 });

    expect(await countDayTypeChangeTargets(database, USER, { ...SCOPE, dayTypeId: dayType.id })).toBe(0);
    expect((await database.entries.get("e-1"))?.amount).toBe(400);
  });

  it("возвращает ноль, когда типа дня или периода нет", async () => {
    const database = openDb();
    const dayType = await createDayType(database, USER, draft());

    // Периода нет вовсе.
    expect(await countDayTypeChangeTargets(database, USER, { ...SCOPE, dayTypeId: dayType.id })).toBe(0);

    // Типа дня нет (удалён).
    await seedPeriod(database);
    await deleteDayType(database, dayType.id);
    expect(await countDayTypeChangeTargets(database, USER, { ...SCOPE, dayTypeId: dayType.id })).toBe(0);
    expect(await countDayTypeChangeTargets(database, USER, { ...SCOPE, dayTypeId: "нет-такого" })).toBe(0);
  });
});

describe("раздел 6.7 на праздничных датах", () => {
  async function seedHoliday(database: TimeoDB, patch: Partial<Holiday> = {}): Promise<void> {
    await database.holidays.add({
      id: "h-1",
      user_id: USER,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted_at: null,
      date: "2026-08-10",
      name: "День фирмы",
      is_custom: true,
      ...patch,
    });
  }

  it("праздник даёт свой множитель при согласии на обновление", async () => {
    const database = openDb();
    await seedPeriod(database);
    await seedHoliday(database);
    const dayType = await createDayType(database, USER, draft());
    // Запись создана до праздника и хранит собственный снимок (раздел 5.4).
    const entry = await seedEntry(database, dayType.id);
    await updateDayType(database, dayType.id, { default_hours: 7 });

    const scope = { ...SCOPE, dayTypeId: dayType.id };
    // Ветка праздника в resolveMultiplier достижима только теперь, когда
    // праздники существуют: ×2.5 вместо ×1.
    expect(await countDayTypeChangeTargets(database, USER, scope)).toBe(1);
    expect(await applyDayTypeChange(database, USER, scope)).toBe(1);

    const updated = await database.entries.get(entry.id);
    expect(updated?.multiplier).toBe(2.5);
    expect(updated?.amount).toBe(600);
  });

  it("мягко удалённый праздник не участвует (инвариант 38)", async () => {
    const database = openDb();
    await seedPeriod(database);
    await seedHoliday(database, { deleted_at: "2026-02-01T00:00:00.000Z" });
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id);

    expect(await countDayTypeChangeTargets(database, USER, { ...SCOPE, dayTypeId: dayType.id })).toBe(0);
  });

  it("чужой праздник не участвует", async () => {
    const database = openDb();
    await seedPeriod(database);
    await seedHoliday(database, { user_id: "user-2" });
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id);

    expect(await countDayTypeChangeTargets(database, USER, { ...SCOPE, dayTypeId: dayType.id })).toBe(0);
  });

  it("два праздника на дате дают один множитель, какой бы из них ни победил", async () => {
    const database = openDb();
    await seedPeriod(database);
    // Именно поэтому инвариант 53 решает только показанное имя: множитель у
    // всех праздников один и тот же (weekend_multipliers.holiday), и выбор
    // строки не может изменить ни одной суммы. Сам выбор проверяют тесты
    // buildHolidayByDate и экранов.
    await seedHoliday(database, { id: "h-late", created_at: "2026-03-01T00:00:00.000Z" });
    await seedHoliday(database, { id: "h-early", created_at: "2026-01-01T00:00:00.000Z", name: "Успение" });
    const dayType = await createDayType(database, USER, draft());
    const entry = await seedEntry(database, dayType.id);

    const scope = { ...SCOPE, dayTypeId: dayType.id };
    await applyDayTypeChange(database, USER, scope);
    expect((await database.entries.get(entry.id))?.multiplier).toBe(2.5);
  });

  it("праздник вне границ периода не влияет на записи текущего (инвариант 1)", async () => {
    const database = openDb();
    await seedPeriod(database);
    await seedHoliday(database, { date: "2026-07-10" });
    const dayType = await createDayType(database, USER, draft());
    await seedEntry(database, dayType.id);

    expect(await countDayTypeChangeTargets(database, USER, { ...SCOPE, dayTypeId: dayType.id })).toBe(0);
  });
});
