import type { TimeoDB } from "@/db/schema";
import { resetSyncMeta } from "@/db/syncMeta";
import { buildBackup, type BackupFile } from "@/lib/export/backup";
import { planImport, type ImportCounts, type ImportMode } from "@/lib/export/importPlan";
import { SYNC_TABLES, type CloudGateway, type SyncTable } from "@/lib/sync/types";
import { stripServerColumn } from "@/lib/sync/merge";
import type { BaseRecord, DayType, Entry, Holiday, Period, Settings } from "@/types/models";

export interface DataSummary {
  periods: number;
  day_types: number;
  entries: number;
  holidays: number;
  /** Сколько месяцев с деньгами — то число, которым предупреждение говорит о цене ошибки. */
  months_with_money: number;
}

export const EMPTY_SUMMARY: DataSummary = {
  periods: 0,
  day_types: 0,
  entries: 0,
  holidays: 0,
  months_with_money: 0,
};

export function isEmptySummary(summary: DataSummary): boolean {
  return (
    summary.periods === 0 && summary.day_types === 0 && summary.entries === 0 && summary.holidays === 0
  );
}

function countMonthsWithMoney(periods: Period[], entries: Entry[]): number {
  const months = new Set<string>();
  for (const period of periods) {
    if (period.deleted_at !== null) continue;
    const closed = period.closed_totals;
    // Ключ ровно того же вида, что у записи ниже ("2026-07"): две разные формы
    // одного и того же месяца посчитали бы его дважды.
    if (period.extra_amount !== 0 || (closed && closed.amount !== 0)) {
      months.add(`${period.year}-${String(period.month).padStart(2, "0")}`);
    }
  }
  for (const entry of entries) {
    if (entry.deleted_at !== null || entry.amount === 0) continue;
    // Месяц записи, а не период: предупреждение говорит человеку про календарь,
    // а не про внутреннюю нарезку периодов, и точность до месяца тут довольно.
    months.add(entry.date.slice(0, 7));
  }
  return months.size;
}

export async function summarizeLocalData(db: TimeoDB, userId: string): Promise<DataSummary> {
  const [periods, day_types, entries, holidays] = await Promise.all([
    db.periods.where("user_id").equals(userId).toArray(),
    db.day_types.where("user_id").equals(userId).toArray(),
    db.entries.where("user_id").equals(userId).toArray(),
    db.holidays.where("user_id").equals(userId).toArray(),
  ]);

  const alive = <T extends BaseRecord>(rows: T[]): T[] => rows.filter((row) => row.deleted_at === null);

  return {
    periods: alive(periods).length,
    day_types: alive(day_types).length,
    entries: alive(entries).length,
    holidays: alive(holidays).length,
    months_with_money: countMonthsWithMoney(periods, entries),
  };
}

export function summarizeBackup(file: BackupFile): DataSummary {
  return {
    periods: file.periods.length,
    day_types: file.day_types.length,
    entries: file.entries.length,
    holidays: file.holidays.length,
    months_with_money: countMonthsWithMoney(file.periods, file.entries),
  };
}

const SNAPSHOT_PAGE = 500;

/**
 * Всё, что лежит в облаке под этим аккаунтом, в виде того же объекта, которым
 * пользуется восстановление из файла (раздел 8.8). Это не экономия строк: у
 * первого входа и у восстановления ОДНА задача — две копии данных и запрет на
 * молчаливое слияние (преамбула раздела 5, инвариант 47), — и решать её дважды
 * разными способами значит получить два разных поведения.
 */
export async function fetchCloudSnapshot(
  gateway: CloudGateway,
  userId: string,
  appVersion: string,
): Promise<BackupFile> {
  const collected: Record<SyncTable, BaseRecord[]> = {
    settings: [],
    day_types: [],
    periods: [],
    holidays: [],
    entries: [],
  };

  for (const table of SYNC_TABLES) {
    let cursor: string | null = null;
    for (;;) {
      const page = await gateway.pull(table, userId, cursor, SNAPSHOT_PAGE);
      if (page.rows.length === 0) break;
      for (const row of page.rows) collected[table].push(stripServerColumn(row));
      cursor = page.rows[page.rows.length - 1].server_updated_at;
      if (page.rows.length < SNAPSHOT_PAGE) break;
    }
  }

  const settingsRows = collected.settings as Settings[];
  return buildBackup(
    {
      settings: settingsRows.find((row) => row.deleted_at === null) ?? null,
      periods: collected.periods as Period[],
      day_types: collected.day_types as DayType[],
      entries: collected.entries as Entry[],
      holidays: collected.holidays as Holiday[],
    },
    new Date().toISOString(),
    appVersion,
  );
}

export interface AdoptInput {
  /** Анонимный идентификатор, под которым лежат локальные строки до входа. */
  localUserId: string;
  /** auth.uid вошедшего аккаунта. */
  cloudUserId: string;
  /** Что лежит в облаке. null — там пусто, спрашивать не о чем. */
  snapshot: BackupFile | null;
  /** Ответ человека на вопрос первого входа. Нужен только если в облаке есть данные. */
  mode: ImportMode | null;
}

/**
 * Первый вход: локальные строки переезжают на настоящий user_id, и, если в
 * облаке уже есть данные, применяется выбранный человеком режим.
 *
 * Всё это — одна транзакция на пять таблиц. Закрыть приложение посреди выбора
 * можно: до вызова этой функции в базе не меняется ничего, а после — уже всё.
 *
 * updated_at при переезде НЕ трогается. Содержимое строки не изменилось,
 * изменился владелец; поднятая отметка заставила бы историческую строку
 * выиграть last-write-wins у действительно более новой облачной версии. По той
 * же причине его не трогала ни одна из десяти миграций Dexie.
 */
export async function adoptAccount(db: TimeoDB, input: AdoptInput): Promise<ImportCounts | null> {
  const { localUserId, cloudUserId, snapshot, mode } = input;

  const counts = await db.transaction(
    "rw",
    [db.settings, db.periods, db.day_types, db.entries, db.holidays, db.sync_meta],
    async () => {
      await migrateUserId(db, localUserId, cloudUserId);

      if (!snapshot || mode === null) return null;

      const [settings, periods, day_types, entries, holidays] = await Promise.all([
        db.settings.where("user_id").equals(cloudUserId).first(),
        db.periods.where("user_id").equals(cloudUserId).toArray(),
        db.day_types.where("user_id").equals(cloudUserId).toArray(),
        db.entries.where("user_id").equals(cloudUserId).toArray(),
        db.holidays.where("user_id").equals(cloudUserId).toArray(),
      ]);

      const plan = planImport({
        file: snapshot,
        current: { settings: settings ?? null, periods, day_types, entries, holidays },
        mode,
        userId: cloudUserId,
        newId: () => crypto.randomUUID(),
      });

      if (plan.clearAll) {
        await Promise.all([
          db.settings.clear(),
          db.periods.clear(),
          db.day_types.clear(),
          db.entries.clear(),
          db.holidays.clear(),
        ]);
      }

      if (plan.settings) await db.settings.put(plan.settings);
      if (plan.settingsPatch && settings) {
        await db.settings.update(settings.id, { ...plan.settingsPatch, updated_at: new Date().toISOString() });
      }
      if (plan.day_types.length) await db.day_types.bulkPut(plan.day_types);
      if (plan.periods.length) await db.periods.bulkPut(plan.periods);
      if (plan.entries.length) await db.entries.bulkPut(plan.entries);
      if (plan.holidays.length) await db.holidays.bulkPut(plan.holidays);

      return plan.counts;
    },
  );

  // Курсоры и водяные знаки — от прошлой жизни базы: после переезда всё
  // выгружается заново, иначе часть строк никогда бы не уехала.
  await resetSyncMeta(db, cloudUserId);
  return counts;
}

async function migrateUserId(db: TimeoDB, from: string, to: string): Promise<void> {
  if (from === to) return;
  await Promise.all([
    db.settings.where("user_id").equals(from).modify({ user_id: to }),
    db.periods.where("user_id").equals(from).modify({ user_id: to }),
    db.day_types.where("user_id").equals(from).modify({ user_id: to }),
    db.entries.where("user_id").equals(from).modify({ user_id: to }),
    db.holidays.where("user_id").equals(from).modify({ user_id: to }),
  ]);
}

/**
 * Инвариант 44: вход под ДРУГИМ пользователем стирает локальные данные — и
 * только после явного подтверждения, которое запрашивает экран аккаунта.
 * Здесь стирание уже решённое.
 */
export async function wipeLocalData(db: TimeoDB): Promise<void> {
  await db.transaction(
    "rw",
    [db.settings, db.periods, db.day_types, db.entries, db.holidays, db.sync_meta],
    async () => {
      await Promise.all([
        db.settings.clear(),
        db.periods.clear(),
        db.day_types.clear(),
        db.entries.clear(),
        db.holidays.clear(),
        db.sync_meta.clear(),
      ]);
    },
  );
}
