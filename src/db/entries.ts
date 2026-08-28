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

export async function createEntry(
  db: TimeoDB,
  entry: Omit<Entry, "id" | "created_at" | "updated_at" | "deleted_at">,
): Promise<Entry> {
  const now = new Date().toISOString();
  const row: Entry = {
    ...entry,
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await db.entries.add(row);
  return row;
}

export async function updateEntry(db: TimeoDB, id: string, patch: Partial<Entry>): Promise<void> {
  await db.entries.update(id, { ...patch, updated_at: new Date().toISOString() });
}

// Раздел 8 ТЗ / CLAUDE.md: ничего не удаляется мгновенно, только мягкое удаление
// с окном отмены. restoreEntry обслуживает плашку "отменить" на UI-стороне.
export async function softDeleteEntry(db: TimeoDB, id: string): Promise<void> {
  await db.entries.update(id, { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() });
}

export async function restoreEntry(db: TimeoDB, id: string): Promise<void> {
  await db.entries.update(id, { deleted_at: null, updated_at: new Date().toISOString() });
}
