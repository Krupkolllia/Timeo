import type { TimeoDB } from "@/db/schema";
import { buildBackup, type BackupFile } from "@/lib/export/backup";
import { planImport, type ImportCounts, type ImportMode } from "@/lib/export/importPlan";

/**
 * Раздел 8.8, инвариант 46. Читаются только строки этого пользователя; мягко
 * удалённые отсеивает buildBackup.
 */
export async function readBackup(db: TimeoDB, userId: string, appVersion: string): Promise<BackupFile> {
  const [settings, periods, day_types, entries, holidays] = await db.transaction(
    "r",
    db.settings,
    db.periods,
    db.day_types,
    db.entries,
    db.holidays,
    async () =>
      Promise.all([
        db.settings.where("user_id").equals(userId).first(),
        db.periods.where("user_id").equals(userId).toArray(),
        db.day_types.where("user_id").equals(userId).toArray(),
        db.entries.where("user_id").equals(userId).toArray(),
        db.holidays.where("user_id").equals(userId).toArray(),
      ]),
  );

  return buildBackup(
    { settings: settings ?? null, periods, day_types, entries, holidays },
    new Date().toISOString(),
    appVersion,
  );
}

/**
 * Инвариант 49: импорт атомарен. Разбор и проверка файла закончились раньше
 * (lib/export/parse.ts), план строится чистой функцией, и одна rw-транзакция
 * над всеми пятью таблицами либо выполняется целиком, либо не меняет ничего.
 *
 * Текущее состояние читается ВНУТРИ транзакции, а не приходит с экрана: между
 * рендером и нажатием кнопки успевает измениться что угодно, а решение «эта
 * строка уже есть» принимается именно по нему.
 */
export async function importBackup(
  db: TimeoDB,
  userId: string,
  file: BackupFile,
  mode: ImportMode,
): Promise<ImportCounts> {
  return db.transaction("rw", db.settings, db.periods, db.day_types, db.entries, db.holidays, async () => {
    // Только строки этого пользователя. Соблазн взять все (чтобы чужой
    // идентификатор случайно не оказался занят) ведёт к худшему: если
    // localStorage очистился отдельно от IndexedDB, локальный user_id стал
    // новым, а старые строки остались в базе — и тогда «добавить недостающее»
    // объявило бы каждый месяц уже существующим и молча не восстановило
    // НИЧЕГО. Это ровно тот случай, ради которого экран и написан.
    const [settings, periods, day_types, entries, holidays] = await Promise.all([
      db.settings.where("user_id").equals(userId).first(),
      db.periods.where("user_id").equals(userId).toArray(),
      db.day_types.where("user_id").equals(userId).toArray(),
      db.entries.where("user_id").equals(userId).toArray(),
      db.holidays.where("user_id").equals(userId).toArray(),
    ]);

    const plan = planImport({
      file,
      current: { settings: settings ?? null, periods, day_types, entries, holidays },
      mode,
      userId,
      newId: () => crypto.randomUUID(),
    });

    if (plan.clearAll) {
      // «Заменить всё» — значит всё: строки, оставшиеся от другого локального
      // user_id (localStorage мог быть очищен отдельно от IndexedDB), иначе
      // пережили бы замену невидимыми для всех запросов.
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

    // bulkPut, а не bulkAdd: план гарантирует свободные ключи, но файл может
    // содержать две строки с одним id, и падение на середине записи — ровно то,
    // от чего защищает инвариант 49.
    if (plan.day_types.length) await db.day_types.bulkPut(plan.day_types);
    if (plan.periods.length) await db.periods.bulkPut(plan.periods);
    if (plan.entries.length) await db.entries.bulkPut(plan.entries);
    if (plan.holidays.length) await db.holidays.bulkPut(plan.holidays);

    return plan.counts;
  });
}
