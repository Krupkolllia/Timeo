import type { TimeoDB } from "@/db/schema";
import type { SyncTable } from "@/lib/sync/types";

/**
 * Служебное состояние синхронизации. Одна строка на пользователя, к
 * пользовательским данным отношения не имеет: в экспорт не попадает
 * (инвариант 46) и в облако не выгружается.
 */
export interface SyncMeta {
  user_id: string;
  /** Докуда докачано: server_updated_at последней принятой строки, по таблицам. */
  pull_cursor: Partial<Record<SyncTable, string>>;
  /** Докуда выгружено: максимальный updated_at, ПОДТВЕРЖДЁННЫЙ сервером (инвариант 43). */
  pushed_through: Partial<Record<SyncTable, string>>;
  /**
   * Date.now() на момент прошлой удачной выгрузки. Если часы устройства ушли
   * назад, новые правки получат updated_at МЕНЬШЕ водяного знака и никогда не
   * попали бы в выгрузку. Замеченный перевод часов назад сбрасывает знаки, и
   * следующая синхронизация выгружает всё заново.
   */
  clock_guard: number;
  last_sync_at: string | null;
  last_error: string | null;
}

export function emptySyncMeta(userId: string): SyncMeta {
  return {
    user_id: userId,
    pull_cursor: {},
    pushed_through: {},
    clock_guard: 0,
    last_sync_at: null,
    last_error: null,
  };
}

export async function readSyncMeta(db: TimeoDB, userId: string): Promise<SyncMeta> {
  return (await db.sync_meta.get(userId)) ?? emptySyncMeta(userId);
}

export async function writeSyncMeta(db: TimeoDB, meta: SyncMeta): Promise<void> {
  await db.sync_meta.put(meta);
}

/** Полная перевыгрузка и перекачка: после первого входа и после переезда данных. */
export async function resetSyncMeta(db: TimeoDB, userId: string): Promise<void> {
  await db.sync_meta.put(emptySyncMeta(userId));
}
