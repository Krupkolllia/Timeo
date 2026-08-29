import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { ensureSettings } from "@/db/settings";
import { bootstrapUser } from "@/db/bootstrap";
import {
  createHoliday,
  ensureHolidaysSeeded,
  listHolidays,
  restoreHoliday,
  softDeleteHoliday,
} from "@/db/holidays";
import { polishHolidaysForYear } from "@/lib/calc/holidays";
import type { Entry, Period } from "@/types/models";

const USER = "user-1";

let db: TimeoDB | undefined;

afterEach(async () => {
  await db?.delete();
  db = undefined;
});

function open(): TimeoDB {
  db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  return db;
}

describe("ensureHolidaysSeeded", () => {
  it("засевает текущий и следующий год", async () => {
    const database = open();
    await ensureSettings(database, USER);
    await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));

    const rows = await listHolidays(database, USER);
    expect(rows).toHaveLength(26);
    expect(new Set(rows.map((h) => h.date.slice(0, 4)))).toEqual(new Set(["2026", "2027"]));
    // Не помечены пользовательскими: это отличает засеянные строки от
    // добавленных руками (раздел 5.5).
    expect(rows.every((h) => h.is_custom === false)).toBe(true);
    expect((await database.settings.where("user_id").equals(USER).first())?.seeded_holiday_years).toEqual([2026, 2027]);
  });

  it("идемпотентен: повторный вызов не пишет ничего", async () => {
    const database = open();
    await ensureSettings(database, USER);
    const first = await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));
    const second = await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));

    expect(first).toBe(26);
    expect(second).toBe(0);
    expect(await database.holidays.count()).toBe(26);
  });

  it("параллельные вызовы не задваивают строки (двойной эффект StrictMode)", async () => {
    const database = open();
    await ensureSettings(database, USER);
    await Promise.all([
      ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29)),
      ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29)),
    ]);
    expect(await database.holidays.count()).toBe(26);
  });

  it("на следующий год досевает только недостающий год", async () => {
    const database = open();
    await ensureSettings(database, USER);
    await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));
    const added = await ensureHolidaysSeeded(database, USER, new Date(2027, 0, 2));

    expect(added).toBe(13);
    expect((await database.settings.where("user_id").equals(USER).first())?.seeded_holiday_years).toEqual([
      2026, 2027, 2028,
    ]);
    // 2026 и 2027 не засеяны второй раз.
    expect(await database.holidays.count()).toBe(39);
  });

  it("не воскрешает удалённый праздник при следующем посеве", async () => {
    const database = open();
    await ensureSettings(database, USER);
    await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));

    const mayDay = (await listHolidays(database, USER)).find((h) => h.date === "2026-05-01");
    expect(mayDay).toBeDefined();
    await softDeleteHoliday(database, mayDay!.id);

    await ensureHolidaysSeeded(database, USER, new Date(2026, 11, 31));
    await ensureHolidaysSeeded(database, USER, new Date(2027, 0, 1));

    expect((await listHolidays(database, USER)).some((h) => h.date === "2026-05-01")).toBe(false);
  });

  it("не воскрешает удалённый праздник даже если строка уже вычищена из базы", async () => {
    const database = open();
    await ensureSettings(database, USER);
    await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));

    const mayDay = (await listHolidays(database, USER)).find((h) => h.date === "2026-05-01");
    // Блок 8 удаляет мягко удалённые строки после распространения (инвариант
    // 38) — «год засеян» не должно зависеть от наличия строк.
    await database.holidays.delete(mayDay!.id);

    await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));
    expect((await listHolidays(database, USER)).some((h) => h.date === "2026-05-01")).toBe(false);
  });

  it("не сеет, пока нет строки настроек: отметить посев было бы негде", async () => {
    const database = open();
    expect(await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29))).toBe(0);
    expect(await database.holidays.count()).toBe(0);
  });

  it("сеет праздники только своему пользователю", async () => {
    const database = open();
    await ensureSettings(database, USER);
    await ensureSettings(database, "user-2");
    await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));

    expect(await listHolidays(database, "user-2")).toHaveLength(0);
    expect((await database.settings.where("user_id").equals("user-2").first())?.seeded_holiday_years).toEqual([]);
  });

  it("совпадает с чистым списком праздников года", async () => {
    const database = open();
    await ensureSettings(database, USER);
    await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));

    const seeded = (await listHolidays(database, USER))
      .filter((h) => h.date.startsWith("2026"))
      .map((h) => ({ date: h.date, name: h.name }));
    expect(seeded).toEqual(polishHolidaysForYear(2026));
  });
});

describe("bootstrapUser", () => {
  it("засевает праздники при первом запуске и не задваивает при втором", async () => {
    const database = open();
    await bootstrapUser(database, USER);
    const afterFirst = await database.holidays.count();
    await bootstrapUser(database, USER);

    expect(afterFirst).toBeGreaterThan(0);
    expect(await database.holidays.count()).toBe(afterFirst);
  });
});

describe("правка списка праздников", () => {
  it("создаёт праздник с любым содержимым: пустое имя не блокирует (инвариант 56)", async () => {
    const database = open();
    const created = await createHoliday(database, USER, { date: "2026-08-10", name: "" });

    expect(created.is_custom).toBe(true);
    expect((await listHolidays(database, USER)).map((h) => h.id)).toEqual([created.id]);
  });

  it("разрешает два праздника на одну дату (инвариант 53)", async () => {
    const database = open();
    await createHoliday(database, USER, { date: "2026-05-01", name: "Праздник труда" });
    await createHoliday(database, USER, { date: "2026-05-01", name: "День фирмы" });

    expect((await listHolidays(database, USER)).filter((h) => h.date === "2026-05-01")).toHaveLength(2);
  });

  it("отдаёт список в детерминированном порядке: по дате, затем по created_at и id", async () => {
    const database = open();
    const now = "2026-01-01T00:00:00.000Z";
    await database.holidays.bulkAdd([
      { id: "c", user_id: USER, created_at: now, updated_at: now, deleted_at: null, date: "2026-05-03", name: "3", is_custom: false },
      { id: "b", user_id: USER, created_at: now, updated_at: now, deleted_at: null, date: "2026-05-01", name: "b", is_custom: false },
      { id: "a", user_id: USER, created_at: now, updated_at: now, deleted_at: null, date: "2026-05-01", name: "a", is_custom: false },
    ]);

    expect((await listHolidays(database, USER)).map((h) => h.id)).toEqual(["a", "b", "c"]);
  });

  it("исключает мягко удалённые строки из выборки (инвариант 38) и возвращает их отменой", async () => {
    const database = open();
    const created = await createHoliday(database, USER, { date: "2026-08-10", name: "День фирмы" });
    await softDeleteHoliday(database, created.id);
    expect(await listHolidays(database, USER)).toHaveLength(0);
    // Строка не исчезла — её держит окно отмены.
    expect(await database.holidays.get(created.id)).toBeDefined();

    await restoreHoliday(database, created.id);
    expect(await listHolidays(database, USER)).toHaveLength(1);
  });

  it("не отдаёт чужие праздники", async () => {
    const database = open();
    await createHoliday(database, "user-2", { date: "2026-08-10", name: "Чужой" });
    expect(await listHolidays(database, USER)).toHaveLength(0);
  });
});

// --- Инварианты 51 и 52: список праздников ничего не пересчитывает ------------

async function seedEntryAndPeriods(database: TimeoDB): Promise<void> {
  const now = "2026-08-01T00:00:00.000Z";
  const stamps = { created_at: now, updated_at: now, deleted_at: null };
  const period = (id: string, month: number, isClosed: boolean): Period => ({
    id,
    user_id: USER,
    ...stamps,
    year: 2026,
    month,
    base_rate: 30,
    norm_hours: 160,
    extra_amount: 0,
    extra_note: "",
    is_closed: isClosed,
    closed_totals: isClosed ? { amount: 240, total_hours: 8, norm_hours_covered: 8 } : null,
    is_manual: false,
  });
  const entry = (id: string, date: string): Entry => ({
    id,
    user_id: USER,
    ...stamps,
    date,
    day_type_id: "dt-1",
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
  });

  await database.periods.bulkAdd([period("p-open", 8, false), period("p-closed", 7, true)]);
  await database.entries.bulkAdd([entry("e-open", "2026-08-10"), entry("e-closed", "2026-07-10")]);
}

describe("инварианты 51 и 52", () => {
  it("добавление праздника поверх существующей записи не меняет её сумму", async () => {
    const database = open();
    await seedEntryAndPeriods(database);

    await createHoliday(database, USER, { date: "2026-08-10", name: "День фирмы" });

    const entry = await database.entries.get("e-open");
    expect(entry?.amount).toBe(240);
    expect(entry?.multiplier).toBe(1);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("праздник внутри закрытого периода не меняет в нём ничего", async () => {
    const database = open();
    await seedEntryAndPeriods(database);

    await createHoliday(database, USER, { date: "2026-07-10", name: "День фирмы" });

    const entry = await database.entries.get("e-closed");
    expect(entry?.amount).toBe(240);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");
    const period = await database.periods.get("p-closed");
    expect(period?.closed_totals?.amount).toBe(240);
    expect(period?.updated_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("удаление праздника не меняет сумм", async () => {
    const database = open();
    await seedEntryAndPeriods(database);
    const created = await createHoliday(database, USER, { date: "2026-08-10", name: "День фирмы" });

    await softDeleteHoliday(database, created.id);

    const entry = await database.entries.get("e-open");
    expect(entry?.amount).toBe(240);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("посев праздников не меняет сумм ни в одном периоде", async () => {
    const database = open();
    await ensureSettings(database, USER);
    await seedEntryAndPeriods(database);
    const before = (await database.entries.toArray()).reduce((sum, e) => sum + e.amount, 0);

    await ensureHolidaysSeeded(database, USER, new Date(2026, 7, 29));

    const after = await database.entries.toArray();
    expect(after.reduce((sum, e) => sum + e.amount, 0)).toBe(before);
    for (const entry of after) expect(entry.updated_at).toBe("2026-08-01T00:00:00.000Z");
  });
});
