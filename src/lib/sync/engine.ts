import type { TimeoDB } from "@/db/schema";
import { readSyncMeta, writeSyncMeta, type SyncMeta } from "@/db/syncMeta";
import {
  clampFutureUpdatedAt,
  planDayTypesPull,
  planEntriesPull,
  planPull,
  stripServerColumn,
} from "@/lib/sync/merge";
import { SYNC_TABLES, type CloudGateway, type RemoteRow, type SyncCounts, type SyncTable } from "@/lib/sync/types";
import type { BaseRecord, DayType, Entry, Settings } from "@/types/models";

export const PULL_PAGE_SIZE = 500;
export const PUSH_CHUNK_SIZE = 200;

/**
 * Запас, на который водяной знак выгрузки отодвигается назад при отборе строк.
 *
 * Знак — это максимальный updated_at, который сервер подтвердил. Две правки в
 * одну миллисекунду и мелкое дёрганье часов вперёд-назад иначе оставили бы
 * строку невыгруженной навсегда, а «навсегда» здесь означает потерянный день
 * работы. Повторная выгрузка уже выгруженной строки не стоит ничего: это
 * upsert той же самой версии.
 */
export const PUSH_WATERMARK_MARGIN_MS = 60_000;

type AnyRow = BaseRecord;

function tableOf(db: TimeoDB, table: SyncTable) {
  switch (table) {
    case "settings":
      return db.settings;
    case "day_types":
      return db.day_types;
    case "periods":
      return db.periods;
    case "holidays":
      return db.holidays;
    case "entries":
      return db.entries;
  }
}

async function localRows(db: TimeoDB, table: SyncTable, userId: string): Promise<AnyRow[]> {
  const rows = await tableOf(db, table).where("user_id").equals(userId).toArray();
  return rows as AnyRow[];
}

function byId<T extends BaseRecord>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Строка настроек — одна на пользователя, и в Postgres это записано ограничением
 * unique (user_id). Два устройства завели бы её каждый со своим случайным id, и
 * выгрузка второго упиралась бы в это ограничение навсегда.
 *
 * Поэтому у облачной строки настроек идентификатор детерминированный — сам
 * user_id. Здесь он и приводится к этому виду: ключ в Dexie сменить правкой
 * нельзя, поэтому строка удаляется и кладётся заново. Ни одно поле, включая
 * updated_at, при этом не меняется — это не правка настроек, а приведение
 * ключа.
 */
async function normalizeSettingsId(db: TimeoDB, userId: string): Promise<void> {
  await db.transaction("rw", db.settings, async () => {
    const rows = await db.settings.where("user_id").equals(userId).toArray();
    const wrong = rows.filter((row) => row.id !== userId);
    if (wrong.length === 0) return;

    // Победитель среди дубликатов — самая свежая правка: остальные строки это
    // тот же самый единственный объект настроек, приехавший другим путём.
    const newest = [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
    for (const row of wrong) await db.settings.delete(row.id);
    if (newest.id !== userId) await db.settings.put({ ...newest, id: userId } as Settings);
  });
}

async function applyPulledPage(
  db: TimeoDB,
  table: SyncTable,
  userId: string,
  page: RemoteRow[],
  serverNow: string,
): Promise<{ applied: number; forcePush: string[]; deferredIds: Set<string> }> {
  const target = tableOf(db, table);

  return db.transaction("rw", db.settings, db.day_types, db.periods, db.holidays, db.entries, async () => {
    const local = byId(await localRows(db, table, userId));

    if (table === "entries") {
      const dayTypeIds = new Set((await db.day_types.where("user_id").equals(userId).primaryKeys()) as string[]);
      const plan = planEntriesPull(
        local as unknown as Map<string, Entry>,
        page as RemoteRow<Entry>[],
        serverNow,
        dayTypeIds,
      );
      if (plan.apply.length) await db.entries.bulkPut(plan.apply);
      return {
        applied: plan.apply.length,
        forcePush: plan.keptLocal,
        deferredIds: new Set(plan.deferred.map((row) => row.id)),
      };
    }

    if (table === "day_types") {
      const referenced = new Set<string>();
      for (const entry of await db.entries.where("user_id").equals(userId).toArray()) {
        if (entry.deleted_at === null) referenced.add(entry.day_type_id);
      }
      const plan = planDayTypesPull(local as unknown as Map<string, DayType>, page as RemoteRow<DayType>[], serverNow, referenced);
      if (plan.apply.length) await db.day_types.bulkPut(plan.apply);
      if (plan.resurrect.length) await db.day_types.bulkPut(plan.resurrect);
      return {
        applied: plan.apply.length + plan.resurrect.length,
        forcePush: [...plan.keptLocal, ...plan.resurrect.map((row) => row.id)],
        deferredIds: new Set<string>(),
      };
    }

    const plan = planPull(local, page as RemoteRow<AnyRow>[], serverNow);
    if (plan.apply.length) await (target as unknown as { bulkPut: (rows: AnyRow[]) => Promise<unknown> }).bulkPut(plan.apply);
    return { applied: plan.apply.length, forcePush: plan.keptLocal, deferredIds: new Set<string>() };
  });
}

/**
 * Курсор двигается только по строкам, которые действительно легли в базу, и
 * останавливается перед первой отложенной (инвариант 37): иначе запись, чей тип
 * дня ещё не приехал, была бы пропущена навсегда и день остался бы пустым.
 */
function advanceCursor(page: RemoteRow[], deferredIds: Set<string>, current: string | null): string | null {
  let cursor = current;
  for (const row of page) {
    if (deferredIds.has(row.id)) return cursor;
    cursor = row.server_updated_at;
  }
  return cursor;
}

async function pullTable(
  db: TimeoDB,
  gateway: CloudGateway,
  table: SyncTable,
  userId: string,
  meta: SyncMeta,
  serverNow: string,
  counts: SyncCounts,
  forcePush: Set<string>,
  justPulled: Set<string>,
): Promise<void> {
  let cursor = meta.pull_cursor[table] ?? null;

  for (;;) {
    const page = await gateway.pull(table, userId, cursor, PULL_PAGE_SIZE);
    if (page.rows.length === 0) break;

    const result = await applyPulledPage(db, table, userId, page.rows, serverNow);
    counts.pulled += result.applied;
    counts.deferred += result.deferredIds.size;
    for (const id of result.forcePush) forcePush.add(`${table}:${id}`);
    for (const row of page.rows) {
      if (!result.deferredIds.has(row.id) && !result.forcePush.includes(row.id)) justPulled.add(`${table}:${row.id}`);
    }

    const next = advanceCursor(page.rows, result.deferredIds, cursor);
    // Курсор не сдвинулся — страница целиком отложена, и повторный запрос
    // вернул бы её же. Выходим: она приедет на следующем проходе, когда типы
    // дня уже будут на месте.
    if (next === cursor) break;
    cursor = next;
    meta.pull_cursor[table] = cursor ?? undefined;

    if (page.rows.length < PULL_PAGE_SIZE) break;
  }
}

async function pushTable(
  db: TimeoDB,
  gateway: CloudGateway,
  table: SyncTable,
  userId: string,
  meta: SyncMeta,
  serverNow: string,
  counts: SyncCounts,
  forcePush: Set<string>,
  justPulled: Set<string>,
): Promise<void> {
  const watermark = meta.pushed_through[table];
  const since = watermark ? Date.parse(watermark) - PUSH_WATERMARK_MARGIN_MS : null;

  const rows = await localRows(db, table, userId);
  const candidates = rows.filter((row) => {
    const key = `${table}:${row.id}`;
    if (forcePush.has(key)) return true;
    // Строка только что принята из облака — она там уже лежит ровно такой.
    // Без этого условия выгрузка и докачка гоняли бы одни и те же строки по
    // кругу: каждая выгрузка поднимает серверную отметку выше курсора.
    if (justPulled.has(key)) return false;
    return since === null || Date.parse(row.updated_at) >= since;
  });
  if (candidates.length === 0) return;

  // Часы вперёд чинятся ДО выгрузки и локально тоже: иначе строка с датой из
  // будущего выигрывала бы каждый конфликт, пока это будущее не наступит
  // (инвариант 42).
  const clamped = candidates.map((row) => clampFutureUpdatedAt(row, serverNow));
  const repaired = clamped.filter((row, index) => row !== candidates[index]);
  if (repaired.length) {
    await (tableOf(db, table) as unknown as { bulkPut: (rows: AnyRow[]) => Promise<unknown> }).bulkPut(repaired);
  }

  for (let i = 0; i < clamped.length; i += PUSH_CHUNK_SIZE) {
    const chunk = clamped.slice(i, i + PUSH_CHUNK_SIZE);
    await gateway.push(table, chunk);
    counts.pushed += chunk.length;
    // Знак двигается ТОЛЬКО после подтверждения сервером (инвариант 43): упавшая
    // выгрузка обязана повториться целиком, а не считаться сделанной.
    const highest = chunk.reduce((max, row) => (row.updated_at > max ? row.updated_at : max), meta.pushed_through[table] ?? "");
    meta.pushed_through[table] = highest;
  }
}

/**
 * Один проход синхронизации: сначала докачка, потом выгрузка.
 *
 * Порядок именно такой. Конфликт решается ровно один раз и только здесь, на
 * клиенте: облако — это upsert без всякой логики, и выгрузка «вслепую» поверх
 * более свежей чужой правки затёрла бы её. Сначала приняв чужое и решив
 * построчно (инвариант 41), мы выгружаем уже победителей.
 *
 * Локальная база при любом исходе остаётся целой: ни одна строка здесь не
 * удаляется, удаление везде мягкое, а водяные знаки двигаются только по
 * подтверждению сервера (инвариант 43).
 */
export async function syncOnce(db: TimeoDB, userId: string, gateway: CloudGateway): Promise<SyncCounts> {
  const serverNow = await gateway.serverNow();
  const meta = await readSyncMeta(db, userId);
  const counts: SyncCounts = { pushed: 0, pulled: 0, deferred: 0 };
  const forcePush = new Set<string>();
  const justPulled = new Set<string>();

  // Часы устройства ушли назад — водяные знаки выгрузки стали больше, чем
  // updated_at будущих правок, и те никогда бы не выгрузились. Сбрасываем.
  const now = Date.now();
  if (meta.clock_guard > now + PUSH_WATERMARK_MARGIN_MS) meta.pushed_through = {};

  await normalizeSettingsId(db, userId);

  try {
    for (const table of SYNC_TABLES) {
      await pullTable(db, gateway, table, userId, meta, serverNow, counts, forcePush, justPulled);
    }
    for (const table of SYNC_TABLES) {
      await pushTable(db, gateway, table, userId, meta, serverNow, counts, forcePush, justPulled);
    }
    meta.clock_guard = now;
    meta.last_sync_at = new Date().toISOString();
    meta.last_error = null;
    await writeSyncMeta(db, meta);
    return counts;
  } catch (error) {
    // Всё, что успело доехать, зафиксировано в курсорах и знаках: следующая
    // попытка продолжит с того же места, а не начнёт с нуля.
    meta.last_error = error instanceof Error ? error.message : String(error);
    await writeSyncMeta(db, meta);
    throw error;
  }
}

export { stripServerColumn };
