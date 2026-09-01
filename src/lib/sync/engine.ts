import type { TimeoDB } from "@/db/schema";
import { readSyncMeta, writeSyncMeta, type SyncMeta } from "@/db/syncMeta";
import {
  clampFutureUpdatedAt,
  planDayTypesPull,
  planEntriesPull,
  planPeriodsPull,
  planPull,
  stripServerColumn,
} from "@/lib/sync/merge";
import {
  SYNC_TABLES,
  type CloudGateway,
  type RemoteRow,
  type SyncCounts,
  type SyncTable,
} from "@/lib/sync/types";
import type {
  BaseRecord,
  DayType,
  Entry,
  Period,
  Settings,
} from "@/types/models";

export const PULL_PAGE_SIZE = 500;
export const PUSH_CHUNK_SIZE = 200;

/**
 * Запас, на который водяной знак выгрузки отодвигается назад при отборе строк.
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

async function localRows(
    db: TimeoDB,
    table: SyncTable,
    userId: string,
): Promise<AnyRow[]> {
  const rows = await tableOf(db, table)
  .where("user_id")
  .equals(userId)
  .toArray();

  return rows as AnyRow[];
}

function byId<T extends BaseRecord>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Строка настроек — одна на пользователя, и в Postgres это записано
 * ограничением unique(user_id).
 */
async function normalizeSettingsId(
    db: TimeoDB,
    userId: string,
): Promise<void> {
  await db.transaction("rw", db.settings, async () => {
    const rows = await db.settings
    .where("user_id")
    .equals(userId)
    .toArray();

    const wrong = rows.filter((row) => row.id !== userId);

    if (wrong.length === 0) return;

    const newest = [...rows].sort((a, b) =>
        a.updated_at < b.updated_at ? 1 : -1,
    )[0];

    for (const row of wrong) {
      await db.settings.delete(row.id);
    }

    if (newest.id !== userId) {
      await db.settings.put({
        ...newest,
        id: userId,
      } as Settings);
    }
  });
}

async function applyPulledPage(
    db: TimeoDB,
    table: SyncTable,
    userId: string,
    page: RemoteRow[],
    serverNow: string,
): Promise<{
  applied: number;
  forcePush: string[];
  deferredIds: Set<string>;
}> {
  const target = tableOf(db, table);

  return db.transaction(
      "rw",
      db.settings,
      db.day_types,
      db.periods,
      db.holidays,
      db.entries,
      async () => {
        const local = byId(await localRows(db, table, userId));

        if (table === "entries") {
          const dayTypeIds = new Set(
              (await db.day_types
              .where("user_id")
              .equals(userId)
              .primaryKeys()) as string[],
          );

          const plan = planEntriesPull(
              local as Map<string, Entry>,
              page as RemoteRow<Entry>[],
              serverNow,
              dayTypeIds,
          );

          if (plan.apply.length) {
            await db.entries.bulkPut(plan.apply);
          }

          return {
            applied: plan.apply.length,
            forcePush: plan.keptLocal,
            deferredIds: new Set(
                plan.deferred.map((row) => row.id),
            ),
          };
        }

        if (table === "day_types") {
          const referenced = new Set<string>();

          for (const entry of await db.entries
          .where("user_id")
          .equals(userId)
          .toArray()) {
            if (entry.deleted_at === null) {
              referenced.add(entry.day_type_id);
            }
          }

          const plan = planDayTypesPull(
              local as Map<string, DayType>,
              page as RemoteRow<DayType>[],
              serverNow,
              referenced,
          );

          if (plan.apply.length) {
            await db.day_types.bulkPut(plan.apply);
          }

          if (plan.resurrect.length) {
            await db.day_types.bulkPut(plan.resurrect);
          }

          return {
            applied: plan.apply.length + plan.resurrect.length,
            forcePush: [
              ...plan.keptLocal,
              ...plan.resurrect.map((row) => row.id),
            ],
            deferredIds: new Set<string>(),
          };
        }

        if (table === "periods") {
          const plan = planPeriodsPull(
              local as Map<string, Period>,
              page as RemoteRow<Period>[],
              serverNow,
          );

          /**
           * Если remote period победил period с другим UUID, сначала удаляем
           * конфликтующий local row. Иначе bulkPut(remote) создаст второй live
           * period, а следующий push упадёт на periods_user_month_uniq.
           */
          if (plan.removeLocalIds.length) {
            await Promise.all(
                plan.removeLocalIds.map((id) =>
                    db.periods.delete(id),
                ),
            );
          }

          if (plan.apply.length) {
            await db.periods.bulkPut(plan.apply);
          }

          return {
            applied: plan.apply.length,
            forcePush: plan.keptLocal,
            deferredIds: new Set<string>(),
          };
        }

        const plan = planPull(
            local,
            page as RemoteRow<AnyRow>[],
            serverNow,
        );

        if (plan.apply.length) {
          await (
              target as unknown as {
                bulkPut: (rows: AnyRow[]) => Promise<unknown>;
              }
          ).bulkPut(plan.apply);
        }

        return {
          applied: plan.apply.length,
          forcePush: plan.keptLocal,
          deferredIds: new Set<string>(),
        };
      },
  );
}

/**
 * Курсор двигается только по строкам, которые действительно легли в базу.
 */
function advanceCursor(
    page: RemoteRow[],
    deferredIds: Set<string>,
    current: string | null,
): string | null {
  let cursor = current;

  for (const row of page) {
    if (deferredIds.has(row.id)) {
      return cursor;
    }

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
    const page = await gateway.pull(
        table,
        userId,
        cursor,
        PULL_PAGE_SIZE,
    );

    if (page.rows.length === 0) {
      break;
    }

    const result = await applyPulledPage(
        db,
        table,
        userId,
        page.rows,
        serverNow,
    );

    counts.pulled += result.applied;
    counts.deferred += result.deferredIds.size;

    for (const id of result.forcePush) {
      forcePush.add(`${table}:${id}`);
    }

    for (const row of page.rows) {
      if (
          !result.deferredIds.has(row.id) &&
          !result.forcePush.includes(row.id)
      ) {
        justPulled.add(`${table}:${row.id}`);
      }
    }

    if (result.deferredIds.size > 0) {
      meta.pull_cursor.day_types = undefined;
    }

    const next = advanceCursor(
        page.rows,
        result.deferredIds,
        cursor,
    );

    if (next === cursor) {
      break;
    }

    cursor = next;
    meta.pull_cursor[table] = cursor ?? undefined;

    if (page.rows.length < PULL_PAGE_SIZE) {
      break;
    }
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

  const since = watermark
      ? Date.parse(watermark) - PUSH_WATERMARK_MARGIN_MS
      : null;

  const rows = await localRows(db, table, userId);

  const candidates = rows.filter((row) => {
    const key = `${table}:${row.id}`;

    if (forcePush.has(key)) {
      return true;
    }

    if (justPulled.has(key)) {
      return false;
    }

    if (since === null) {
      return true;
    }

    const at = Date.parse(row.updated_at);

    return (
        Number.isNaN(at) ||
        at >= since
    );
  });

  if (candidates.length === 0) {
    return;
  }

  const ordered = [...candidates].sort((a, b) =>
      a.updated_at < b.updated_at
          ? -1
          : a.updated_at > b.updated_at
              ? 1
              : 0,
  );

  const clamped = ordered.map((row) =>
      clampFutureUpdatedAt(row, serverNow),
  );

  const repaired = clamped.filter(
      (row, index) => row !== ordered[index],
  );

  if (repaired.length) {
    await (
        tableOf(db, table) as unknown as {
          bulkPut: (rows: AnyRow[]) => Promise<unknown>;
        }
    ).bulkPut(repaired);
  }

  for (
      let i = 0;
      i < clamped.length;
      i += PUSH_CHUNK_SIZE
  ) {
    const chunk = clamped.slice(
        i,
        i + PUSH_CHUNK_SIZE,
    );

    await gateway.push(table, chunk);

    counts.pushed += chunk.length;

    const highest = chunk.reduce(
        (max, row) =>
            Number.isFinite(Date.parse(row.updated_at)) &&
            row.updated_at > max
                ? row.updated_at
                : max,
        meta.pushed_through[table] ?? "",
    );

    meta.pushed_through[table] = highest;
  }
}

/**
 * Один проход синхронизации:
 * сначала pull, затем push.
 */
export async function syncOnce(
    db: TimeoDB,
    userId: string,
    gateway: CloudGateway,
): Promise<SyncCounts> {
  const serverNow = await gateway.serverNow();
  const meta = await readSyncMeta(db, userId);

  const counts: SyncCounts = {
    pushed: 0,
    pulled: 0,
    deferred: 0,
  };

  const forcePush = new Set<string>();
  const justPulled = new Set<string>();

  const now = Date.now();

  if (
      meta.clock_guard >
      now + PUSH_WATERMARK_MARGIN_MS
  ) {
    meta.pushed_through = {};
  }

  await normalizeSettingsId(db, userId);

  try {
    for (const table of SYNC_TABLES) {
      await pullTable(
          db,
          gateway,
          table,
          userId,
          meta,
          serverNow,
          counts,
          forcePush,
          justPulled,
      );
    }

    for (const table of SYNC_TABLES) {
      await pushTable(
          db,
          gateway,
          table,
          userId,
          meta,
          serverNow,
          counts,
          forcePush,
          justPulled,
      );
    }

    meta.clock_guard = now;
    meta.last_sync_at = new Date().toISOString();
    meta.last_error = null;

    await writeSyncMeta(db, meta);

    return counts;
  } catch (error) {
    meta.last_error =
        error instanceof Error
            ? error.message
            : String(error);

    await writeSyncMeta(db, meta);

    throw error;
  }
}

export { stripServerColumn };
