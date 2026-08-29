import type { DayType, Entry, Holiday, Period, Settings } from "@/types/models";

/**
 * Версия ФОРМАТА ФАЙЛА резервной копии — не версия приложения и не версия
 * схемы Dexie.
 *
 * Правило подъёма (инварианты 48 и 50). Поднимать номер только тогда, когда
 * старый импортёр прочитал бы новый файл НЕВЕРНО: удалено поле, переименован
 * ключ, изменился смысл значения. Просто добавленное необязательное поле номер
 * не поднимает — старый читатель его проигнорирует и не ошибётся.
 *
 * Цена подъёма несимметрична и именно поэтому правило такое строгое: по
 * инварианту 48 файл с версией НОВЕЕ приложения импортировать нельзя вовсе. То
 * есть каждый подъём делает свежую копию нечитаемой на телефоне, который ещё не
 * обновился, — а это ровно тот телефон, который чаще всего и восстанавливают.
 * Обратная совместимость (инвариант 50) обеспечивается миграциями на импорте,
 * см. migrateBackup в lib/export/parse.ts.
 */
export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupFile {
  schema_version: number;
  exported_at: string;
  /**
   * Сборка, записавшая файл. Инвариантами не требуется и импортом не
   * используется: тестирование идёт по скриншотам (раздел 12 ТЗ), и без этого
   * поля по присланному файлу нельзя сказать, какая версия его сделала.
   */
  app_version: string;
  settings: Settings | null;
  periods: Period[];
  day_types: DayType[];
  entries: Entry[];
  holidays: Holiday[];
}

export interface BackupSource {
  settings: Settings | null;
  periods: Period[];
  day_types: DayType[];
  entries: Entry[];
  holidays: Holiday[];
}

function alive<T extends { deleted_at: string | null }>(rows: T[]): T[] {
  return rows.filter((row) => row.deleted_at === null);
}

/**
 * Раздел 8.8 и инвариант 46: одна структура со всеми пользовательскими
 * таблицами. push_subscriptions и токены сюда не попадают — их в локальной базе
 * нет вовсе.
 *
 * Мягко удалённые строки в файл НЕ идут. Инвариант 38 держит их до тех пор,
 * пока удаление не разойдётся по синхронизации, — это внутреннее дело блока 8,
 * а файл резервной копии не канал синхронизации, а снимок. Иначе
 * восстановление возвращало бы человеку ровно то, что он стёр, — та же
 * причина, по которой посев праздников не воскрешает удалённые даты (раздел
 * 5.5).
 *
 * Числа не переформатируются и не переокругляются: в базе лежат float'ы
 * (раздел 5.4.1), и JSON обязан воспроизвести их бит в бит, иначе итог периода
 * после восстановления разойдётся с исходным.
 */
export function buildBackup(source: BackupSource, exportedAt: string, appVersion: string): BackupFile {
  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    exported_at: exportedAt,
    app_version: appVersion,
    settings: source.settings && source.settings.deleted_at === null ? source.settings : null,
    periods: alive(source.periods),
    day_types: alive(source.day_types),
    entries: alive(source.entries),
    holidays: alive(source.holidays),
  };
}

export function serializeBackup(file: BackupFile): string {
  // Двухпробельный отступ, а не компактная строка: файл может открыться в
  // просмотрщике телефона, и человек должен увидеть свои данные, а не полотно.
  return JSON.stringify(file, null, 2);
}

/**
 * Имя файла с датой: в «Файлах» рядом лягут несколько копий, и отличать их по
 * «timeo-backup.json (2)» пользователь не должен. Дата берётся по местному
 * календарю (инвариант 27), а не через toISOString.
 */
export function backupFileName(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `timeo-${yyyy}-${mm}-${dd}.json`;
}
