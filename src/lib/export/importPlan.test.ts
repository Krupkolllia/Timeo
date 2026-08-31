import { describe, expect, it } from "vitest";
import { buildBackup, type BackupFile } from "@/lib/export/backup";
import { planImport, RECOVERED_DAY_TYPE_NAME, type ImportMode } from "@/lib/export/importPlan";
import { makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings } from "@/test/factories";
import type { DayType, Entry, Holiday, Period, Settings } from "@/types/models";

const NOW = "2026-08-29T10:00:00.000Z";
const LOCAL_USER = "user-local";

function file(parts: Partial<Omit<BackupFile, "schema_version" | "exported_at" | "app_version">> = {}): BackupFile {
  return buildBackup(
    {
      settings: parts.settings ?? null,
      periods: parts.periods ?? [],
      day_types: parts.day_types ?? [],
      entries: parts.entries ?? [],
      holidays: parts.holidays ?? [],
    },
    NOW,
    "0.1.7",
  );
}

function current(parts: {
  settings?: Settings | null;
  periods?: Period[];
  day_types?: DayType[];
  entries?: Entry[];
  holidays?: Holiday[];
} = {}) {
  return {
    settings: parts.settings ?? null,
    periods: parts.periods ?? [],
    day_types: parts.day_types ?? [],
    entries: parts.entries ?? [],
    holidays: parts.holidays ?? [],
  };
}

function ids() {
  let counter = 0;
  return () => `new-${++counter}`;
}

function plan(
  backup: BackupFile,
  db: ReturnType<typeof current>,
  mode: ImportMode = "merge",
  newId: () => string = ids(),
) {
  return planImport({ file: backup, current: db, mode, userId: LOCAL_USER, newId });
}

describe("planImport — идентификаторы типов дня (инвариант 36)", () => {
  it("идентификатор свободен: тип восстанавливается под своим", () => {
    const result = plan(file({ day_types: [makeDayType({ id: "dt-x" })] }), current());

    expect(result.day_types.map((row) => row.id)).toEqual(["dt-x"]);
    expect(result.counts.recreated_day_types).toBe(0);
  });

  it("тот же идентификатор и тот же тип: ничего не перезаписывается", () => {
    const existing = makeDayType({ id: "dt-x", name: "Переименован на телефоне" });
    const imported = makeDayType({ id: "dt-x", name: "Как было в файле" });

    const result = plan(file({ day_types: [imported] }), current({ day_types: [existing] }));

    expect(result.day_types).toEqual([]);
    expect(result.counts.skipped).toBe(1);
  });

  it("идентификатор занят ДРУГИМ типом: создаётся новый, записи перенаправляются", () => {
    const existing = makeDayType({ id: "dt-x", name: "Местный", created_at: "2026-01-01T00:00:00.000Z" });
    const imported = makeDayType({ id: "dt-x", name: "Из файла", created_at: "2026-05-05T00:00:00.000Z" });
    const entry = makeEntry({ id: "e-x", day_type_id: "dt-x" });

    const result = plan(file({ day_types: [imported], entries: [entry] }), current({ day_types: [existing] }));

    expect(result.day_types).toHaveLength(1);
    const created = result.day_types[0];
    expect(created.id).toBe("new-1");
    expect(created.name).toBe("Из файла");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].day_type_id).toBe("new-1");
    expect(result.counts.recreated_day_types).toBe(1);
    expect(result.counts.repointed_entries).toBe(1);
  });

  it("тип записи отсутствует и в файле, и в базе: заводится восстановительный тип", () => {
    const orphan = makeEntry({ id: "e-orphan", day_type_id: "dt-missing", amount: 512.5 });

    const result = plan(file({ entries: [orphan] }), current());

    // Осиротевших записей после импорта быть не может (инвариант 36), а
    // выбросить запись нельзя — в ней лежит сумма.
    expect(result.day_types).toHaveLength(1);
    expect(result.day_types[0].name).toBe(RECOVERED_DAY_TYPE_NAME);
    expect(result.day_types[0].is_archived).toBe(true);
    expect(result.entries[0].day_type_id).toBe(result.day_types[0].id);
    expect(result.entries[0].amount).toBe(512.5);
    expect(result.counts.recovered_entries).toBe(1);
  });

  it("восстановительный тип создаётся один на все осиротевшие записи", () => {
    const result = plan(
      file({
        entries: [
          makeEntry({ id: "e-1", day_type_id: "dt-missing" }),
          makeEntry({ id: "e-2", day_type_id: "dt-other-missing" }),
        ],
      }),
      current(),
    );

    expect(result.day_types).toHaveLength(1);
    expect(new Set(result.entries.map((row) => row.day_type_id)).size).toBe(1);
    expect(result.counts.recovered_entries).toBe(2);
  });

  it("тип есть только в базе — запись ссылается на него и никуда не перенаправляется", () => {
    const local = makeDayType({ id: "dt-local" });
    const result = plan(
      file({ entries: [makeEntry({ id: "e-1", day_type_id: "dt-local" })] }),
      current({ day_types: [local] }),
    );

    expect(result.day_types).toEqual([]);
    expect(result.entries[0].day_type_id).toBe("dt-local");
    expect(result.counts.repointed_entries).toBe(0);
  });

  it("ни одна запись плана не остаётся без типа дня", () => {
    const result = plan(
      file({
        day_types: [makeDayType({ id: "dt-collide", created_at: "2026-05-05T00:00:00.000Z" })],
        entries: [
          makeEntry({ id: "e-1", day_type_id: "dt-collide" }),
          makeEntry({ id: "e-2", day_type_id: "dt-nowhere" }),
          makeEntry({ id: "e-3", day_type_id: "dt-local" }),
        ],
      }),
      current({
        day_types: [
          makeDayType({ id: "dt-collide", created_at: "2026-01-01T00:00:00.000Z" }),
          makeDayType({ id: "dt-local" }),
        ],
      }),
    );

    const known = new Set([...result.day_types.map((row) => row.id), "dt-collide", "dt-local"]);
    for (const entry of result.entries) expect(known.has(entry.day_type_id)).toBe(true);
  });
});

describe("planImport — режимы (инвариант 47)", () => {
  it("replace: база очищается, строки ложатся под своими идентификаторами", () => {
    const result = plan(
      file({ settings: makeSettings({ id: "s-file" }), periods: [makePeriod({ id: "p-file" })] }),
      current({ settings: makeSettings({ id: "s-local" }), periods: [makePeriod({ id: "p-local" })] }),
      "replace",
    );

    expect(result.clearAll).toBe(true);
    expect(result.settings?.id).toBe("s-file");
    expect(result.periods.map((row) => row.id)).toEqual(["p-file"]);
    expect(result.counts.skipped).toBe(0);
  });

  it("merge: существующий месяц не переписывается (инварианты 1 и 2)", () => {
    const localClosed = makePeriod({ id: "p-local", year: 2026, month: 8, is_closed: true });
    const imported = makePeriod({ id: "p-file", year: 2026, month: 8, base_rate: 999 });

    const result = plan(file({ periods: [imported] }), current({ periods: [localClosed] }));

    expect(result.periods).toEqual([]);
    expect(result.counts.skipped).toBe(1);
  });

  it("merge: месяц, которого нет, добавляется", () => {
    const result = plan(
      file({ periods: [makePeriod({ id: "p-july", year: 2026, month: 7 })] }),
      current({ periods: [makePeriod({ id: "p-aug", year: 2026, month: 8 })] }),
    );

    expect(result.periods.map((row) => row.id)).toEqual(["p-july"]);
    expect(result.counts.periods).toBe(1);
  });

  it("файл с двумя периодами на один месяц не раздваивает месяц", () => {
    // Выборка периода берёт .first(): две живые строки на один year+month —
    // это месяц, который навсегда показывает то одни итоги, то другие.
    const result = plan(
      file({
        periods: [
          makePeriod({ id: "p-late", year: 2026, month: 8, base_rate: 99, created_at: "2026-02-01T00:00:00.000Z" }),
          makePeriod({ id: "p-early", year: 2026, month: 8, base_rate: 30, created_at: "2026-01-01T00:00:00.000Z" }),
        ],
      }),
      current(),
      "replace",
    );

    expect(result.periods.map((row) => row.id)).toEqual(["p-early"]);
  });

  it("merge: два праздника на одну дату законны (инвариант 53)", () => {
    const local = makeHoliday({ id: "h-local", date: "2026-08-15", name: "Успение" });
    const imported = makeHoliday({ id: "h-file", date: "2026-08-15", name: "День фирмы" });

    const result = plan(file({ holidays: [imported] }), current({ holidays: [local] }));

    expect(result.holidays.map((row) => row.name)).toEqual(["День фирмы"]);
  });

  it("merge: занятый идентификатор записи не перетирает местную строку", () => {
    const local = makeEntry({ id: "e-x", amount: 100, created_at: "2026-01-01T00:00:00.000Z" });
    const imported = makeEntry({ id: "e-x", amount: 200, created_at: "2026-05-05T00:00:00.000Z" });

    const result = plan(file({ entries: [imported] }), current({ entries: [local], day_types: [makeDayType()] }));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).not.toBe("e-x");
    expect(result.entries[0].amount).toBe(200);
  });

  it("merge: мягко удалённая местная строка тоже занимает идентификатор", () => {
    const deletedLocal = makeHoliday({ id: "h-x", deleted_at: NOW, created_at: "2026-01-01T00:00:00.000Z" });
    const imported = makeHoliday({ id: "h-x", created_at: "2026-01-01T00:00:00.000Z" });

    const result = plan(file({ holidays: [imported] }), current({ holidays: [deletedLocal] }));

    // Та же строка, удалённая на этом устройстве: «добавить недостающее» не
    // воскрешает удалённое.
    expect(result.holidays).toEqual([]);
    expect(result.counts.skipped).toBe(1);
  });
});

describe("planImport — настройки", () => {
  it("merge объединяет seeded_holiday_years, иначе посев задвоит праздники (раздел 5.5)", () => {
    const local = makeSettings({ seeded_holiday_years: [2026] });
    const imported = makeSettings({ id: "s-file", seeded_holiday_years: [2027, 2028] });

    const result = plan(file({ settings: imported }), current({ settings: local }));

    expect(result.settings).toBeNull();
    expect(result.settingsPatch).toEqual({ seeded_holiday_years: [2026, 2027, 2028] });
  });

  it("merge в базу без настроек кладёт строку из файла целиком", () => {
    const result = plan(file({ settings: makeSettings({ id: "s-file" }) }), current({ settings: null }));
    expect(result.settings?.id).toBe("s-file");
  });

  it("все строки переписываются на локального пользователя", () => {
    const foreign = "user-from-another-phone";
    const result = plan(
      file({
        settings: makeSettings({ user_id: foreign }),
        periods: [makePeriod({ user_id: foreign })],
        day_types: [makeDayType({ user_id: foreign })],
        entries: [makeEntry({ user_id: foreign })],
        holidays: [makeHoliday({ user_id: foreign })],
      }),
      current(),
      "replace",
    );

    const users = [
      result.settings?.user_id,
      ...result.periods.map((row) => row.user_id),
      ...result.day_types.map((row) => row.user_id),
      ...result.entries.map((row) => row.user_id),
      ...result.holidays.map((row) => row.user_id),
    ];
    expect(new Set(users)).toEqual(new Set([LOCAL_USER]));
  });
});

describe("planImport: мягко удалённые строки", () => {
  it("инвариант 38: удалённый период не занимает свой месяц при слиянии", () => {
    const deleted = makePeriod({ id: "p-08", year: 2026, month: 8, deleted_at: "2026-08-20T10:00:00.000Z" });
    const imported = makePeriod({ id: "p-08-file", year: 2026, month: 8, base_rate: 41 });

    const plan = planImport({
      file: file({ periods: [imported] }),
      current: { settings: null, periods: [deleted], day_types: [], entries: [], holidays: [] },
      mode: "merge" as ImportMode,
      userId: LOCAL_USER,
      newId: () => "generated",
    });

    expect(plan.periods.map((row) => row.base_rate)).toEqual([41]);
  });
});

describe("planImport: пресеты с разными id", () => {
  it("одинаковый тип из файла не добавляется вторым, записи цепляются к своему", () => {
    // Ровно случай входа в аккаунт: тот же пресет, засеянный на другом
    // устройстве, приезжает с другим идентификатором.
    const local = makeDayType({ id: "dt-local", name: "Рабочий день", pay_mode: "hourly" });
    const imported = makeDayType({ id: "dt-cloud", name: "Рабочий день", pay_mode: "hourly" });
    const entry = makeEntry({ id: "e-1", day_type_id: "dt-cloud" });

    const plan = planImport({
      file: file({ day_types: [imported], entries: [entry] }),
      current: { settings: null, periods: [], day_types: [local], entries: [], holidays: [] },
      mode: "merge" as ImportMode,
      userId: LOCAL_USER,
      newId: () => "generated",
    });

    expect(plan.day_types).toEqual([]);
    expect(plan.entries.map((row) => row.day_type_id)).toEqual(["dt-local"]);
  });

  it("одно имя, но разная оплата — это разные типы, они не схлопываются", () => {
    const local = makeDayType({ id: "dt-local", name: "Отпуск", pay_mode: "hourly" });
    const imported = makeDayType({ id: "dt-cloud", name: "Отпуск", pay_mode: "unpaid" });

    const plan = planImport({
      file: file({ day_types: [imported] }),
      current: { settings: null, periods: [], day_types: [local], entries: [], holidays: [] },
      mode: "merge" as ImportMode,
      userId: LOCAL_USER,
      newId: () => "generated",
    });

    expect(plan.day_types.map((row) => row.id)).toEqual(["dt-cloud"]);
  });
});
