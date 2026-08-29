import { describe, expect, it } from "vitest";
import { BACKUP_SCHEMA_VERSION, buildBackup, serializeBackup } from "@/lib/export/backup";
import { parseBackup } from "@/lib/export/parse";
import { makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings } from "@/test/factories";

const NOW = "2026-08-29T10:00:00.000Z";

function validFile() {
  return buildBackup(
    {
      settings: makeSettings(),
      periods: [makePeriod()],
      day_types: [makeDayType()],
      entries: [makeEntry()],
      holidays: [makeHoliday()],
    },
    NOW,
    "0.1.7",
  );
}

function parse(value: unknown) {
  return parseBackup(typeof value === "string" ? value : JSON.stringify(value), NOW);
}

describe("parseBackup — отказы", () => {
  it("обрезанный JSON", () => {
    const truncated = serializeBackup(validFile()).slice(0, 120);
    const result = parseBackup(truncated, NOW);
    expect(result).toEqual({ ok: false, error: { kind: "invalid_json" } });
  });

  it("валидный JSON, но не резервная копия", () => {
    expect(parse({ hello: "world" })).toEqual({ ok: false, error: { kind: "not_a_backup" } });
    expect(parse("[1,2,3]")).toEqual({ ok: false, error: { kind: "not_a_backup" } });
    expect(parse('"строка"')).toEqual({ ok: false, error: { kind: "not_a_backup" } });
  });

  it("версия новее приложения — отказ, а не частичное применение (инвариант 48)", () => {
    const file = { ...validFile(), schema_version: BACKUP_SCHEMA_VERSION + 1 };
    expect(parse(file)).toEqual({
      ok: false,
      error: { kind: "unsupported_version", version: BACKUP_SCHEMA_VERSION + 1 },
    });
  });

  it("файл, целый до последней записи, отвергается целиком (инвариант 49)", () => {
    const file = validFile();
    const broken = {
      ...file,
      entries: [makeEntry({ id: "e-good" }), { ...makeEntry({ id: "e-bad" }), amount: "много" }],
    };
    expect(parse(broken)).toEqual({ ok: false, error: { kind: "invalid_table", table: "entries", index: 1 } });
  });

  it("запись без даты или без типа дня — не запись", () => {
    const file = validFile();
    const noDate = parse({ ...file, entries: [{ ...makeEntry(), date: undefined }] });
    const noType = parse({ ...file, entries: [{ ...makeEntry(), day_type_id: "" }] });
    expect(noDate.ok).toBe(false);
    expect(noType.ok).toBe(false);
  });

  it("период без года и месяца не принадлежит ни одному месяцу", () => {
    const file = validFile();
    expect(parse({ ...file, periods: [{ ...makePeriod(), year: undefined }] })).toEqual({
      ok: false,
      error: { kind: "invalid_table", table: "periods", index: 0 },
    });
  });

  it("строка без идентификатора не принимается", () => {
    const file = validFile();
    expect(parse({ ...file, day_types: [{ ...makeDayType(), id: "" }] })).toEqual({
      ok: false,
      error: { kind: "invalid_table", table: "day_types", index: 0 },
    });
  });

  it("таблица, которая не массив", () => {
    const file = validFile();
    expect(parse({ ...file, holidays: { date: "2026-08-10" } })).toEqual({
      ok: false,
      error: { kind: "invalid_table", table: "holidays", index: -1 },
    });
  });

  it("мусор на месте настроек", () => {
    const file = validFile();
    expect(parse({ ...file, settings: 42 })).toEqual({
      ok: false,
      error: { kind: "invalid_table", table: "settings", index: -1 },
    });
  });

  it("NaN и Infinity в сумме не проходят", () => {
    const file = validFile();
    // JSON их не кодирует, но файл мог быть склеен руками, и Infinity в сумме
    // — это итог периода, который уже ничем не починить.
    expect(parse({ ...file, entries: [{ ...makeEntry(), amount: null }] }).ok).toBe(false);
  });
});

describe("parseBackup — приём", () => {
  it("свой же файл читается без изменений", () => {
    const file = validFile();
    const result = parseBackup(serializeBackup(file), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toEqual(file);
  });

  it("файл с отметкой порядка байтов (BOM) читается", () => {
    const result = parseBackup(`\uFEFF${serializeBackup(validFile())}`, NOW);
    expect(result.ok).toBe(true);
  });

  it("точные float-значения выживают разбор (раздел 5.4.1)", () => {
    const file = { ...validFile(), entries: [makeEntry({ amount: 399.59999999999997, multiplier: 1.566666 })] };
    const result = parse(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.entries[0].amount).toBe(399.59999999999997);
    expect(result.file.entries[0].multiplier).toBe(1.566666);
  });

  it("запись без duration_is_manual читается как ручная (инвариант 50)", () => {
    // Файл, записанный сборкой до раздела 6.1: времена в нём есть, но ни одно
    // hours из них не выводилось. Значение false включило бы вывод, и первая
    // же правка такого дня переписала бы настоящую сумму.
    const legacy = { ...makeEntry({ hours: 8, amount: 240 }), start_time: "08:00", end_time: "16:00" };
    delete (legacy as Record<string, unknown>).duration_is_manual;

    const result = parse({ ...validFile(), entries: [legacy] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.entries[0].duration_is_manual).toBe(true);
    expect(result.file.entries[0].hours).toBe(8);
    expect(result.file.entries[0].amount).toBe(240);
  });

  it("явный duration_is_manual: false переживает разбор", () => {
    const result = parse({ ...validFile(), entries: [makeEntry({ duration_is_manual: false })] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.entries[0].duration_is_manual).toBe(false);
  });

  it("файл более старой версии: недостающие поля заполняются миграцией (инвариант 50)", () => {
    // Такой файл записала бы сборка до блока 4: у типа дня нет ни значка, ни
    // note, ни rate_mode, а ставка задана — значит замок закрыт.
    const oldDayType = {
      id: "dt-old",
      user_id: "u",
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
      name: "Ночная смена",
      color: "#818cf8",
      pay_mode: "hourly",
      fixed_amount: null,
      counts_as_work: true,
      counts_toward_norm: true,
      default_hours: 8,
      default_multiplier: 1.5,
      default_rate: 60,
      ignore_auto_multipliers: false,
      sort_order: 1,
      is_archived: false,
    };
    const result = parse({ schema_version: 1, day_types: [oldDayType] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dayType = result.file.day_types[0];
    expect(dayType.label).toBe("Н");
    expect(dayType.note).toBe("");
    expect(dayType.rate_mode).toBe("pinned");
  });

  it("настройки старой сборки получают seeded_holiday_years и default_base_rate_from_period", () => {
    const result = parse({
      schema_version: 1,
      settings: { id: "s", user_id: "u", created_at: NOW, updated_at: NOW, deleted_at: null, currency: "PLN" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.settings?.seeded_holiday_years).toEqual([]);
    expect(result.file.settings?.default_base_rate_from_period).toBeNull();
    expect(result.file.settings?.period_start_day).toBe(1);
  });

  it("отсутствующие таблицы читаются как пустые", () => {
    const result = parse({ schema_version: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toMatchObject({ periods: [], day_types: [], entries: [], holidays: [], settings: null });
  });

  it("неизвестное значение перечисления заменяется умолчанием, а не рушит файл", () => {
    const result = parse({
      schema_version: 1,
      entries: [{ ...makeEntry(), rate_source: "с потолка" }],
      day_types: [{ ...makeDayType(), pay_mode: "бартер" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.entries[0].rate_source).toBe("period_base");
    expect(result.file.day_types[0].pay_mode).toBe("hourly");
  });
});
