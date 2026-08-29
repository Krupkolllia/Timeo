import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/db";
import { importBackup, readBackup } from "@/db/backup";
import { parseBackup } from "@/lib/export/parse";
import { serializeBackup, type BackupFile } from "@/lib/export/backup";
import { calculatePeriodTotals } from "@/lib/calc/period";
import { RECOVERED_DAY_TYPE_NAME } from "@/lib/export/importPlan";
import { makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings, resetDb, USER_ID } from "@/test/factories";

const NOW = "2026-08-29T10:00:00.000Z";

/**
 * База «как у живого человека»: несколько периодов, закрытый, ручной, записи с
 * ручной суммой, закреплённый тип, архивный тип, мягко удалённые строки и два
 * праздника на одну дату.
 */
async function seedRichDatabase() {
  await db.settings.add(makeSettings({ seeded_holiday_years: [2026], default_base_rate: 33.3 }));
  await db.periods.bulkAdd([
    makePeriod({ id: "p-06", year: 2026, month: 6, base_rate: 30 }),
    makePeriod({
      id: "p-07",
      year: 2026,
      month: 7,
      base_rate: 33.3,
      is_closed: true,
      closed_totals: { amount: 4128.72, total_hours: 168, norm_hours_covered: 168 },
    }),
    makePeriod({
      id: "p-05",
      year: 2026,
      month: 5,
      is_manual: true,
      is_closed: true,
      base_rate: 0,
      closed_totals: { amount: 1500.5, total_hours: 100, norm_hours_covered: 100 },
    }),
    makePeriod({ id: "p-08", year: 2026, month: 8, base_rate: 33.3, extra_amount: -120.75, extra_note: "аванс" }),
    makePeriod({ id: "p-dead", year: 2025, month: 12, deleted_at: NOW }),
  ]);
  await db.day_types.bulkAdd([
    makeDayType({ id: "dt-hourly" }),
    makeDayType({ id: "dt-pinned", name: "Ночная", rate_mode: "pinned", default_rate: 60, sort_order: 1 }),
    makeDayType({ id: "dt-archived", name: "Старый", is_archived: true, sort_order: 2 }),
    makeDayType({ id: "dt-dead", name: "Удалённый", deleted_at: NOW, sort_order: 3 }),
  ]);
  await db.entries.bulkAdd([
    makeEntry({ id: "e-1", date: "2026-08-03", amount: 399.59999999999997, multiplier: 1.566666 }),
    makeEntry({ id: "e-2", date: "2026-08-04", amount_override: 777.77, amount: 777.77 }),
    makeEntry({ id: "e-3", date: "2026-08-05", day_type_id: "dt-pinned", rate_per_hour: 60, amount: 480 }),
    makeEntry({ id: "e-4", date: "2026-08-06", day_type_id: "dt-archived", amount: 111.11 }),
    makeEntry({ id: "e-7", date: "2026-07-10", amount: 240 }),
    makeEntry({ id: "e-dead", date: "2026-08-07", deleted_at: NOW }),
  ]);
  await db.holidays.bulkAdd([
    makeHoliday({ id: "h-1", date: "2026-08-15", name: "Успение" }),
    makeHoliday({ id: "h-2", date: "2026-08-15", name: "День фирмы", is_custom: true }),
    makeHoliday({ id: "h-dead", date: "2026-08-20", deleted_at: NOW }),
  ]);
}

async function snapshot() {
  const [settings, periods, day_types, entries, holidays] = await Promise.all([
    db.settings.toArray(),
    db.periods.toArray(),
    db.day_types.toArray(),
    db.entries.toArray(),
    db.holidays.toArray(),
  ]);
  const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return {
    settings: byId(settings),
    periods: byId(periods),
    day_types: byId(day_types),
    entries: byId(entries),
    holidays: byId(holidays),
  };
}

async function periodTotals(year: number, month: number) {
  const period = await db.periods.where("[user_id+year+month]").equals([USER_ID, year, month]).first();
  if (!period) return null;
  const entries = await db.entries.filter((entry) => entry.deleted_at === null).toArray();
  const dayTypes = await db.day_types.toArray();
  // Записи фильтруем по месяцу так же, как экраны: по датам периода.
  const inPeriod = entries.filter((entry) => {
    const [y, m] = entry.date.split("-").map(Number);
    return y === year && m === month;
  });
  return calculatePeriodTotals(period, inPeriod, new Map(dayTypes.map((dt) => [dt.id, dt])));
}

async function wipe() {
  await resetDb();
}

describe("readBackup", () => {
  beforeEach(resetDb);

  it("собирает все таблицы и не берёт мягко удалённые строки", async () => {
    await seedRichDatabase();
    const file = await readBackup(db, USER_ID, "0.1.7");

    expect(file.periods.map((row) => row.id).sort()).toEqual(["p-05", "p-06", "p-07", "p-08"]);
    expect(file.day_types.map((row) => row.id).sort()).toEqual(["dt-archived", "dt-hourly", "dt-pinned"]);
    expect(file.entries.map((row) => row.id).sort()).toEqual(["e-1", "e-2", "e-3", "e-4", "e-7"]);
    expect(file.holidays.map((row) => row.id).sort()).toEqual(["h-1", "h-2"]);
    expect(file.settings?.seeded_holiday_years).toEqual([2026]);
  });

  it("не берёт строки другого пользователя", async () => {
    await seedRichDatabase();
    await db.entries.add(makeEntry({ id: "e-foreign", user_id: "someone-else" }));

    const file = await readBackup(db, USER_ID, "0.1.7");
    expect(file.entries.map((row) => row.id)).not.toContain("e-foreign");
  });
});

describe("круговой рейс: экспорт → очистка → импорт", () => {
  beforeEach(resetDb);

  it("итоги каждого периода совпадают до гроша", async () => {
    await seedRichDatabase();

    const before = {
      may: await periodTotals(2026, 5),
      june: await periodTotals(2026, 6),
      july: await periodTotals(2026, 7),
      august: await periodTotals(2026, 8),
    };
    const text = serializeBackup(await readBackup(db, USER_ID, "0.1.7"));

    await wipe();
    const parsed = parseBackup(text, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await importBackup(db, USER_ID, parsed.file, "replace");

    expect(await periodTotals(2026, 5)).toEqual(before.may);
    expect(await periodTotals(2026, 6)).toEqual(before.june);
    expect(await periodTotals(2026, 7)).toEqual(before.july);
    expect(await periodTotals(2026, 8)).toEqual(before.august);
    // Не «примерно совпало»: сумма месяца с прочими начислениями и записью с
    // ручной суммой воспроизводится точно.
    expect(before.august?.amount).toBe(1647.73);
  });

  it("float-хвосты воспроизводятся бит в бит, а не переформатируются (раздел 5.4.1)", async () => {
    await seedRichDatabase();
    const text = serializeBackup(await readBackup(db, USER_ID, "0.1.7"));
    await wipe();
    const parsed = parseBackup(text, NOW);
    if (!parsed.ok) throw new Error("файл не разобрался");
    await importBackup(db, USER_ID, parsed.file, "replace");

    const entry = await db.entries.get("e-1");
    expect(entry?.amount).toBe(399.59999999999997);
    expect(entry?.multiplier).toBe(1.566666);
  });

  it("закрытый, ручной и обычный периоды переживают рейс со своими признаками", async () => {
    await seedRichDatabase();
    const text = serializeBackup(await readBackup(db, USER_ID, "0.1.7"));
    await wipe();
    const parsed = parseBackup(text, NOW);
    if (!parsed.ok) throw new Error("файл не разобрался");
    await importBackup(db, USER_ID, parsed.file, "replace");

    const manual = await db.periods.get("p-05");
    expect(manual).toMatchObject({ is_manual: true, is_closed: true });
    expect(manual?.closed_totals).toEqual({ amount: 1500.5, total_hours: 100, norm_hours_covered: 100 });
    expect((await db.periods.get("p-07"))?.is_closed).toBe(true);
    expect((await db.periods.get("p-08"))?.is_closed).toBe(false);
    expect((await db.day_types.get("dt-archived"))?.is_archived).toBe(true);
    expect((await db.day_types.get("dt-pinned"))?.rate_mode).toBe("pinned");
    expect((await db.entries.get("e-2"))?.amount_override).toBe(777.77);
    expect(await db.holidays.where("date").equals("2026-08-15").count()).toBe(2);
  });

  it("мягко удалённые строки не воскресают", async () => {
    await seedRichDatabase();
    const text = serializeBackup(await readBackup(db, USER_ID, "0.1.7"));
    await wipe();
    const parsed = parseBackup(text, NOW);
    if (!parsed.ok) throw new Error("файл не разобрался");
    await importBackup(db, USER_ID, parsed.file, "replace");

    expect(await db.entries.get("e-dead")).toBeUndefined();
    expect(await db.holidays.get("h-dead")).toBeUndefined();
    expect(await db.day_types.get("dt-dead")).toBeUndefined();
    expect(await db.periods.get("p-dead")).toBeUndefined();
  });

  it("файл с другого устройства ложится под локальным user_id, иначе он невидим", async () => {
    await seedRichDatabase();
    const text = serializeBackup(await readBackup(db, USER_ID, "0.1.7"));
    await wipe();
    const parsed = parseBackup(text, NOW);
    if (!parsed.ok) throw new Error("файл не разобрался");
    const foreign: BackupFile = {
      ...parsed.file,
      periods: parsed.file.periods.map((row) => ({ ...row, user_id: "phone-2" })),
      entries: parsed.file.entries.map((row) => ({ ...row, user_id: "phone-2" })),
      day_types: parsed.file.day_types.map((row) => ({ ...row, user_id: "phone-2" })),
      holidays: parsed.file.holidays.map((row) => ({ ...row, user_id: "phone-2" })),
      settings: parsed.file.settings ? { ...parsed.file.settings, user_id: "phone-2" } : null,
    };

    await importBackup(db, USER_ID, foreign, "replace");

    expect(await db.entries.where("user_id").equals(USER_ID).count()).toBe(5);
    expect(await db.settings.where("user_id").equals(USER_ID).count()).toBe(1);
  });
});

describe("атомарность импорта (инвариант 49)", () => {
  beforeEach(resetDb);

  it("обрезанный файл не доходит до базы вовсе", async () => {
    await seedRichDatabase();
    const before = await snapshot();

    const truncated = serializeBackup(await readBackup(db, USER_ID, "0.1.7")).slice(0, 200);
    const parsed = parseBackup(truncated, NOW);

    expect(parsed.ok).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it("валидный JSON не той формы не доходит до базы", async () => {
    await seedRichDatabase();
    const before = await snapshot();

    expect(parseBackup(JSON.stringify({ notes: ["купить хлеб"] }), NOW).ok).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it("файл, целый до последней записи, не применяется частично", async () => {
    await seedRichDatabase();
    const before = await snapshot();

    const file = await readBackup(db, USER_ID, "0.1.7");
    const broken = JSON.stringify({
      ...file,
      entries: [...file.entries, { ...makeEntry({ id: "e-broken" }), amount: "тысяча" }],
    });

    const parsed = parseBackup(broken, NOW);
    expect(parsed.ok).toBe(false);
    // Ни одной строки из целой части файла: половинчатый импорт — худшее, что
    // может случиться, потому что увидеть его нельзя.
    expect(await snapshot()).toEqual(before);
  });

  it("падение внутри транзакции откатывает уже записанное", async () => {
    await seedRichDatabase();
    const before = await snapshot();

    const file = await readBackup(db, USER_ID, "0.1.7");
    // Строка, которую Dexie не сможет записать: ключ должен быть строкой.
    const poisoned: BackupFile = {
      ...file,
      holidays: [...file.holidays, { ...makeHoliday({ id: "h-poison" }), id: undefined as unknown as string }],
    };

    await expect(importBackup(db, USER_ID, poisoned, "replace")).rejects.toBeTruthy();
    expect(await snapshot()).toEqual(before);
  });
});

describe("режим «добавить недостающее» (инвариант 47)", () => {
  beforeEach(resetDb);

  it("существующие строки не переписываются, недостающие добавляются", async () => {
    await seedRichDatabase();
    const file = await readBackup(db, USER_ID, "0.1.7");

    await wipe();
    await db.settings.add(makeSettings({ seeded_holiday_years: [2026] }));
    await db.day_types.add(makeDayType({ id: "dt-hourly", name: "Переименован на телефоне" }));
    await db.periods.add(makePeriod({ id: "p-08", year: 2026, month: 8, base_rate: 99 }));

    const counts = await importBackup(db, USER_ID, file, "merge");

    expect((await db.day_types.get("dt-hourly"))?.name).toBe("Переименован на телефоне");
    expect((await db.periods.get("p-08"))?.base_rate).toBe(99);
    expect(await db.periods.count()).toBe(4);
    expect(counts.skipped).toBeGreaterThan(0);
  });

  it("месяц, уже существующий в базе, не задваивается", async () => {
    await seedRichDatabase();
    const file = await readBackup(db, USER_ID, "0.1.7");

    await wipe();
    await db.settings.add(makeSettings());
    // Тот же месяц, но заведённый заново — другой идентификатор.
    await db.periods.add(makePeriod({ id: "p-other-id", year: 2026, month: 8, base_rate: 50 }));

    await importBackup(db, USER_ID, file, "merge");

    const august = await db.periods
      .where("[user_id+year+month]")
      .equals([USER_ID, 2026, 8])
      .toArray();
    expect(august).toHaveLength(1);
    expect(august[0].base_rate).toBe(50);
  });

  it("seeded_holiday_years объединяются, иначе посев задвоит праздники (раздел 5.5)", async () => {
    await seedRichDatabase();
    await db.settings.where("user_id").equals(USER_ID).modify({ seeded_holiday_years: [2027, 2028] });
    const file = await readBackup(db, USER_ID, "0.1.7");

    await wipe();
    await db.settings.add(makeSettings({ seeded_holiday_years: [2026] }));

    await importBackup(db, USER_ID, file, "merge");

    const settings = await db.settings.where("user_id").equals(USER_ID).first();
    expect(settings?.seeded_holiday_years).toEqual([2026, 2027, 2028]);
  });

  it("осиротевшая запись получает восстановительный тип, а не пропадает (инвариант 36)", async () => {
    const file: BackupFile = {
      schema_version: 1,
      exported_at: NOW,
      app_version: "0.1.7",
      settings: null,
      periods: [],
      day_types: [],
      entries: [makeEntry({ id: "e-orphan", day_type_id: "dt-vanished", amount: 654.32 })],
      holidays: [],
    };
    await db.settings.add(makeSettings());

    const counts = await importBackup(db, USER_ID, file, "merge");

    const entry = await db.entries.get("e-orphan");
    expect(entry?.amount).toBe(654.32);
    const dayType = await db.day_types.get(entry?.day_type_id ?? "");
    expect(dayType?.name).toBe(RECOVERED_DAY_TYPE_NAME);
    expect(counts.recovered_entries).toBe(1);
  });
});

describe("восстановление после смены локального идентификатора", () => {
  beforeEach(resetDb);

  it("«добавить недостающее» видит свою базу пустой, даже если в ней лежат строки прежнего user_id", async () => {
    await seedRichDatabase();
    const file = await readBackup(db, USER_ID, "0.1.7");

    // localStorage очистился отдельно от IndexedDB: идентификатор новый,
    // старые строки на месте и невидимы для всех запросов.
    const freshUser = "user-after-storage-wipe";

    const counts = await importBackup(db, freshUser, file, "merge");

    // Иначе каждый месяц из файла считался бы «уже существующим», и
    // восстановление молча не сделало бы ничего.
    expect(counts.periods).toBe(4);
    expect(counts.entries).toBe(5);
    expect(await db.periods.where("user_id").equals(freshUser).count()).toBe(4);
  });
});

describe("замена всего", () => {
  beforeEach(resetDb);

  it("строки прежнего локального пользователя не переживают замену", async () => {
    await db.settings.add(makeSettings({ id: "s-old", user_id: "old-local-user" }));
    await db.entries.add(makeEntry({ id: "e-old", user_id: "old-local-user" }));

    const file: BackupFile = {
      schema_version: 1,
      exported_at: NOW,
      app_version: "0.1.7",
      settings: makeSettings({ id: "s-new" }),
      periods: [],
      day_types: [],
      entries: [],
      holidays: [],
    };

    await importBackup(db, USER_ID, file, "replace");

    expect(await db.entries.count()).toBe(0);
    expect(await db.settings.count()).toBe(1);
  });
});
