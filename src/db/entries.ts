import { isDateInClosedPeriod } from "@/db/periods";
import type { TimeoDB } from "@/db/schema";
import type { Entry } from "@/types/models";

/**
 * Записи не имеют компонентного индекса user_id+date (раздел 5.4 — несколько
 * записей на один день допустимы, уникального индекса на date нет), поэтому,
 * как и в CalendarPage, фильтруем по user_id/deleted_at после запроса по
 * единственному индексному полю "date".
 */
export function listActiveEntriesForDate(db: TimeoDB, userId: string, date: string): Promise<Entry[]> {
  return db.entries
    .where("date")
    .equals(date)
    .filter((entry) => entry.user_id === userId && entry.deleted_at === null)
    .toArray();
}

/**
 * Инвариант 2: закрытый период неизменяем — «добавление, правка или удаление
 * записи внутри него отклоняется». Экран дня в закрытом периоде и так
 * открывается только на чтение, но проверка живёт и здесь: шторка могла быть
 * отрисована до закрытия (в том числе закрытия с другого устройства), и один
 * уже отправленный вызов дописался бы в зафиксированный месяц.
 *
 * Проверка и запись идут одной rw-транзакцией — иначе между ними успевает
 * пройти само закрытие периода, и запрет проверяет уже неактуальное состояние.
 */
async function writeUnlessClosed(
  db: TimeoDB,
  userId: string,
  date: string,
  write: () => Promise<unknown>,
): Promise<boolean> {
  return db.transaction("rw", db.entries, db.periods, db.settings, async () => {
    if (await isDateInClosedPeriod(db, userId, date)) return false;
    await write();
    return true;
  });
}

export async function createEntry(
  db: TimeoDB,
  entry: Omit<Entry, "id" | "created_at" | "updated_at" | "deleted_at">,
): Promise<Entry | null> {
  const now = new Date().toISOString();
  const row: Entry = {
    ...entry,
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  const written = await writeUnlessClosed(db, entry.user_id, entry.date, () => db.entries.add(row));
  return written ? row : null;
}

export async function updateEntry(db: TimeoDB, id: string, patch: Partial<Entry>): Promise<void> {
  await db.transaction("rw", db.entries, db.periods, db.settings, async () => {
    const existing = await db.entries.get(id);
    if (!existing) return;
    // Дата берётся из строки, а не из патча: перенос записи в другой день
    // экраном дня не поддерживается, а вот правка суммы в закрытом месяце —
    // именно то, что нужно отклонить.
    if (await isDateInClosedPeriod(db, existing.user_id, existing.date)) return;
    await db.entries.update(id, { ...patch, updated_at: new Date().toISOString() });
  });
}

// Раздел 9 ТЗ / CLAUDE.md: ничего не удаляется мгновенно, только мягкое удаление
// с окном отмены. restoreEntry обслуживает плашку "отменить" на UI-стороне.
export async function softDeleteEntry(db: TimeoDB, id: string): Promise<void> {
  await updateEntry(db, id, { deleted_at: new Date().toISOString() });
}

export async function restoreEntry(db: TimeoDB, id: string): Promise<void> {
  await updateEntry(db, id, { deleted_at: null });
}
