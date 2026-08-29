import { BACKUP_SCHEMA_VERSION, type BackupFile } from "@/lib/export/backup";
import { DEFAULT_SETTINGS } from "@/db/settings";
import { deriveDayTypeLabel } from "@/lib/format/dayType";
import type {
  DayType,
  Entry,
  Holiday,
  PayMode,
  Period,
  PeriodNaming,
  RateChangeMode,
  RateMode,
  RateSource,
  Settings,
  Theme,
} from "@/types/models";

export type BackupParseError =
  | { kind: "invalid_json" }
  | { kind: "not_a_backup" }
  | { kind: "unsupported_version"; version: number }
  | { kind: "invalid_table"; table: string; index: number };

export type BackupParseResult = { ok: true; file: BackupFile } | { ok: false; error: BackupParseError };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown, fallback: number): number {
  // Number.isFinite отсекает NaN и Infinity: JSON их не кодирует, но файл
  // мог быть склеен руками, а Infinity в сумме — это итог периода, который
  // ничем уже не чинится.
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Идентификатор — единственное поле, без которого строку нельзя ни вставить, ни связать. */
function requiredId(row: Json): string | null {
  const id = row.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

interface BaseFields {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function baseFields(row: Json, now: string): BaseFields | null {
  const id = requiredId(row);
  if (id === null) return null;
  const created_at = str(row.created_at, now);
  return {
    id,
    // user_id всё равно переписывается на локальный при импорте (иначе файл с
    // другого устройства лёг бы в базу невидимым для всех запросов), но пустая
    // строка честнее выдуманного значения.
    user_id: str(row.user_id, ""),
    created_at,
    updated_at: str(row.updated_at, created_at),
    deleted_at: nullableStr(row.deleted_at),
  };
}

const PERIOD_NAMINGS: readonly PeriodNaming[] = ["end_month", "start_month"];
const THEMES: readonly Theme[] = ["system", "light", "dark"];
const RATE_CHANGE_MODES: readonly RateChangeMode[] = [
  "recalculate_period",
  "apply_from_date",
  "apply_next_period",
];
const PAY_MODES: readonly PayMode[] = ["hourly", "fixed_amount", "unpaid"];
const RATE_MODES: readonly RateMode[] = ["multiplier", "pinned"];
const RATE_SOURCES: readonly RateSource[] = [
  "period_base",
  "weekend_rule",
  "holiday_rule",
  "day_type_default",
  "type_pinned",
  "manual",
  "frozen",
];

function parseSettings(value: unknown, now: string): Settings | null {
  if (!isRecord(value)) return null;
  const base = baseFields(value, now);
  if (!base) return null;

  const multipliers = isRecord(value.weekend_multipliers) ? value.weekend_multipliers : {};
  const seeded = Array.isArray(value.seeded_holiday_years)
    ? value.seeded_holiday_years.filter((year): year is number => typeof year === "number" && Number.isFinite(year))
    : [];
  const from = isRecord(value.default_base_rate_from_period) ? value.default_base_rate_from_period : null;

  return {
    ...base,
    currency: str(value.currency, DEFAULT_SETTINGS.currency),
    period_start_day: num(value.period_start_day, DEFAULT_SETTINGS.period_start_day),
    period_naming: oneOf(value.period_naming, PERIOD_NAMINGS, DEFAULT_SETTINGS.period_naming),
    default_hours: num(value.default_hours, DEFAULT_SETTINGS.default_hours),
    theme: oneOf(value.theme, THEMES, DEFAULT_SETTINGS.theme),
    show_shift_times: bool(value.show_shift_times, DEFAULT_SETTINGS.show_shift_times),
    reminder_enabled: bool(value.reminder_enabled, DEFAULT_SETTINGS.reminder_enabled),
    reminder_time: nullableStr(value.reminder_time),
    week_starts_on: "monday",
    weekend_multipliers: {
      saturday: num(multipliers.saturday, DEFAULT_SETTINGS.weekend_multipliers.saturday),
      sunday: num(multipliers.sunday, DEFAULT_SETTINGS.weekend_multipliers.sunday),
      holiday: num(multipliers.holiday, DEFAULT_SETTINGS.weekend_multipliers.holiday),
    },
    default_base_rate: num(value.default_base_rate, DEFAULT_SETTINGS.default_base_rate),
    default_norm_hours: num(value.default_norm_hours, DEFAULT_SETTINGS.default_norm_hours),
    default_base_rate_from_period:
      from && typeof from.year === "number" && typeof from.month === "number"
        ? { year: from.year, month: from.month }
        : null,
    preferred_rate_change_mode:
      typeof value.preferred_rate_change_mode === "string"
        ? oneOf(value.preferred_rate_change_mode, RATE_CHANGE_MODES, "recalculate_period")
        : null,
    seeded_holiday_years: seeded,
  };
}

function parsePeriod(value: unknown, now: string): Period | null {
  if (!isRecord(value)) return null;
  const base = baseFields(value, now);
  if (!base) return null;
  // Год и месяц — устойчивая личность периода (раздел 5.2). Без них строка не
  // принадлежит ни одному месяцу и не находится ни одним запросом.
  if (typeof value.year !== "number" || typeof value.month !== "number") return null;

  const totals = isRecord(value.closed_totals) ? value.closed_totals : null;
  return {
    ...base,
    year: value.year,
    month: value.month,
    base_rate: num(value.base_rate, 0),
    norm_hours: num(value.norm_hours, 0),
    extra_amount: num(value.extra_amount, 0),
    extra_note: str(value.extra_note, ""),
    is_closed: bool(value.is_closed, false),
    closed_totals: totals
      ? {
          amount: num(totals.amount, 0),
          total_hours: num(totals.total_hours, 0),
          norm_hours_covered: num(totals.norm_hours_covered, 0),
        }
      : null,
    is_manual: bool(value.is_manual, false),
  };
}

function parseDayType(value: unknown, now: string): DayType | null {
  if (!isRecord(value)) return null;
  const base = baseFields(value, now);
  if (!base) return null;

  const name = str(value.name, "");
  const default_rate = nullableNum(value.default_rate);
  return {
    ...base,
    name,
    color: str(value.color, "#94a3b8"),
    // Те же умолчания, что и в миграции version(6) схемы: файл, написанный
    // сборкой до блока 4, не должен рисовать пустой кружок на календаре.
    label: str(value.label, "") || deriveDayTypeLabel(name),
    note: str(value.note, ""),
    pay_mode: oneOf(value.pay_mode, PAY_MODES, "hourly"),
    // И тот же вывод режима из наличия ставки, что в version(6): иначе тип с
    // закреплённой ставкой из старого файла начал бы считаться по множителю.
    rate_mode: oneOf(value.rate_mode, RATE_MODES, default_rate !== null ? "pinned" : "multiplier"),
    fixed_amount: nullableNum(value.fixed_amount),
    counts_as_work: bool(value.counts_as_work, true),
    counts_toward_norm: bool(value.counts_toward_norm, true),
    default_hours: num(value.default_hours, DEFAULT_SETTINGS.default_hours),
    default_multiplier: num(value.default_multiplier, 1),
    default_rate,
    ignore_auto_multipliers: bool(value.ignore_auto_multipliers, false),
    sort_order: num(value.sort_order, 0),
    is_archived: bool(value.is_archived, false),
  };
}

function parseEntry(value: unknown, now: string): Entry | null {
  if (!isRecord(value)) return null;
  const base = baseFields(value, now);
  if (!base) return null;
  // Дата и тип дня обязательны: без даты запись не попадает ни в один период,
  // без типа дня она нарушает инвариант 35 ещё до всякого сопоставления
  // идентификаторов.
  if (typeof value.date !== "string" || typeof value.day_type_id !== "string") return null;
  if (value.day_type_id.length === 0) return null;
  // Сумма — единственное число, ради которого файл вообще существует.
  if (typeof value.amount !== "number" || !Number.isFinite(value.amount)) return null;

  return {
    ...base,
    date: value.date,
    day_type_id: value.day_type_id,
    hours: num(value.hours, 0),
    multiplier: num(value.multiplier, 1),
    rate_per_hour: num(value.rate_per_hour, 0),
    rate_is_manual: bool(value.rate_is_manual, false),
    amount: value.amount,
    amount_override: nullableNum(value.amount_override),
    start_time: nullableStr(value.start_time),
    end_time: nullableStr(value.end_time),
    break_minutes: nullableNum(value.break_minutes),
    note: str(value.note, ""),
    rate_source: oneOf(value.rate_source, RATE_SOURCES, "period_base"),
  };
}

function parseHoliday(value: unknown, now: string): Holiday | null {
  if (!isRecord(value)) return null;
  const base = baseFields(value, now);
  if (!base) return null;
  if (typeof value.date !== "string") return null;
  return { ...base, date: value.date, name: str(value.name, ""), is_custom: bool(value.is_custom, true) };
}

function parseTable<T>(
  raw: unknown,
  table: string,
  parseRow: (value: unknown, now: string) => T | null,
  now: string,
): { ok: true; rows: T[] } | { ok: false; error: BackupParseError } {
  // Отсутствующая таблица — это пустая таблица: файл старой версии мог не
  // знать о ней вовсе (инвариант 50). А вот не-массив на её месте — уже не
  // резервная копия.
  if (raw === undefined || raw === null) return { ok: true, rows: [] };
  if (!Array.isArray(raw)) return { ok: false, error: { kind: "invalid_table", table, index: -1 } };

  const rows: T[] = [];
  for (let index = 0; index < raw.length; index++) {
    const row = parseRow(raw[index], now);
    // Ни одной строки «на всякий случай»: файл, испорченный на последней
    // записи, обязан быть отвергнут целиком (инвариант 49), а не импортирован
    // на 99%.
    if (row === null) return { ok: false, error: { kind: "invalid_table", table, index } };
    rows.push(row);
  }
  return { ok: true, rows };
}

/**
 * Разбор и проверка файла резервной копии. Ничего не пишет и ничего не знает
 * ни про Dexie, ни про экран: по инварианту 49 проверка обязана целиком
 * закончиться ДО первой записи в базу.
 *
 * Заодно это и миграция (инвариант 50): недостающие поля заполняются теми же
 * умолчаниями, что и апгрейдеры схемы Dexie, поэтому файл, записанный более
 * старой сборкой, читается без отдельного кода на каждую версию.
 */
export function parseBackup(text: string, now: string): BackupParseResult {
  let raw: unknown;
  try {
    // Отметку порядка байтов (BOM) снимаем сами: JSON.parse на ней падает, а
    // файл, пересохранённый почтой или «Файлами», вполне может её получить —
    // и человек увидел бы «это не JSON» на собственной, целой копии.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, error: { kind: "invalid_json" } };
  }

  if (!isRecord(raw)) return { ok: false, error: { kind: "not_a_backup" } };
  const version = raw.schema_version;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { ok: false, error: { kind: "not_a_backup" } };
  }
  // Инвариант 48: файл новее приложения не применяется даже частично. Мы не
  // знаем, что означают его поля, и «прочитать сколько получится» здесь значит
  // тихо потерять часть журнала.
  if (version > BACKUP_SCHEMA_VERSION) return { ok: false, error: { kind: "unsupported_version", version } };

  const periods = parseTable(raw.periods, "periods", parsePeriod, now);
  if (!periods.ok) return periods;
  const dayTypes = parseTable(raw.day_types, "day_types", parseDayType, now);
  if (!dayTypes.ok) return dayTypes;
  const entries = parseTable(raw.entries, "entries", parseEntry, now);
  if (!entries.ok) return entries;
  const holidays = parseTable(raw.holidays, "holidays", parseHoliday, now);
  if (!holidays.ok) return holidays;

  // settings — не массив, а одна строка; её отсутствие законно (файл может
  // быть записан до появления строки настроек), но мусор на её месте — нет.
  const settingsRaw = raw.settings;
  const settings = settingsRaw === undefined || settingsRaw === null ? null : parseSettings(settingsRaw, now);
  if (settingsRaw !== undefined && settingsRaw !== null && settings === null) {
    return { ok: false, error: { kind: "invalid_table", table: "settings", index: -1 } };
  }

  return {
    ok: true,
    file: {
      schema_version: version,
      exported_at: str(raw.exported_at, now),
      app_version: str(raw.app_version, ""),
      settings,
      periods: periods.rows,
      day_types: dayTypes.rows,
      entries: entries.rows,
      holidays: holidays.rows,
    },
  };
}
