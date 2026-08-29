import { describe, expect, it } from "vitest";
import { BACKUP_SCHEMA_VERSION, backupFileName, buildBackup, serializeBackup } from "@/lib/export/backup";
import { makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings } from "@/test/factories";

const EXPORTED_AT = "2026-08-29T10:00:00.000Z";

function source(overrides: Partial<Parameters<typeof buildBackup>[0]> = {}) {
  return {
    settings: makeSettings(),
    periods: [makePeriod()],
    day_types: [makeDayType()],
    entries: [makeEntry()],
    holidays: [makeHoliday()],
    ...overrides,
  };
}

describe("buildBackup", () => {
  it("собирает все пять таблиц и версию формата (инвариант 46)", () => {
    const file = buildBackup(source(), EXPORTED_AT, "0.1.7");

    expect(file.schema_version).toBe(BACKUP_SCHEMA_VERSION);
    expect(file.exported_at).toBe(EXPORTED_AT);
    expect(file.app_version).toBe("0.1.7");
    expect(file.settings?.id).toBe("s-1");
    expect(file.periods).toHaveLength(1);
    expect(file.day_types).toHaveLength(1);
    expect(file.entries).toHaveLength(1);
    expect(file.holidays).toHaveLength(1);
  });

  it("мягко удалённые строки в файл не попадают", () => {
    const file = buildBackup(
      source({
        periods: [makePeriod(), makePeriod({ id: "p-dead", deleted_at: EXPORTED_AT })],
        day_types: [makeDayType(), makeDayType({ id: "dt-dead", deleted_at: EXPORTED_AT })],
        entries: [makeEntry(), makeEntry({ id: "e-dead", deleted_at: EXPORTED_AT })],
        holidays: [makeHoliday(), makeHoliday({ id: "h-dead", deleted_at: EXPORTED_AT })],
      }),
      EXPORTED_AT,
      "0.1.7",
    );

    expect(file.periods.map((row) => row.id)).toEqual(["p-2026-08"]);
    expect(file.day_types.map((row) => row.id)).toEqual(["dt-hourly"]);
    expect(file.entries.map((row) => row.id)).toEqual(["e-1"]);
    expect(file.holidays.map((row) => row.id)).toEqual(["h-1"]);
  });

  it("удалённая строка настроек не выдаёт себя за живую", () => {
    const file = buildBackup(source({ settings: makeSettings({ deleted_at: EXPORTED_AT }) }), EXPORTED_AT, "0.1.7");
    expect(file.settings).toBeNull();
  });

  it("float-суммы не переформатируются (раздел 5.4.1)", () => {
    const amount = 399.59999999999997;
    const file = buildBackup(source({ entries: [makeEntry({ amount, multiplier: 1.566666 })] }), EXPORTED_AT, "0.1.7");

    const roundTripped = JSON.parse(serializeBackup(file)) as { entries: { amount: number; multiplier: number }[] };
    expect(roundTripped.entries[0].amount).toBe(amount);
    expect(roundTripped.entries[0].multiplier).toBe(1.566666);
  });
});

describe("backupFileName", () => {
  it("берёт местную дату, а не UTC (инвариант 27)", () => {
    // 1 января 00:30 по местному времени: в UTC при положительном смещении это
    // ещё 31 декабря, и имя файла ушло бы на год назад.
    expect(backupFileName(new Date(2027, 0, 1, 0, 30))).toBe("timeo-2027-01-01.json");
  });

  it("дополняет месяц и день до двух цифр", () => {
    expect(backupFileName(new Date(2026, 8, 5))).toBe("timeo-2026-09-05.json");
  });
});
