import type { BaseRecord, Period } from "@/types/models";
import type {
  CloudGateway,
  PullPage,
  RemoteRow,
  SyncTable,
} from "@/lib/sync/types";

/**
 * Облако в памяти. Ни один тест синхронизации не имеет права ходить в сеть:
 * тест, которому нужен живой проект Supabase, не тест.
 *
 * Ведёт себя как таблицы из Supabase:
 * - server_updated_at проставляется сервером;
 * - updated_at приходит от клиента;
 * - periods имеют логическую уникальность user_id + year + month;
 * - удаление является soft-delete.
 */
export class FakeCloud implements CloudGateway {
  private readonly tables = new Map<
      SyncTable,
      Map<string, RemoteRow>
  >();

  private clock: number;

  /** Сообщение ближайшей неудачи выгрузки — как оборванная сеть. */
  failNextPush: string | null = null;

  /** Уронить выгрузку на N-й порции. */
  failPushAfterChunks: number | null = null;

  /** Сообщение ближайшей неудачи докачки. */
  failNextPull: string | null = null;

  /** История успешно отправленных порций. */
  pushedChunks: {
    table: SyncTable;
    ids: string[];
  }[] = [];

  constructor(
      startIso = "2026-08-30T12:00:00.000Z",
  ) {
    this.clock = Date.parse(startIso);
  }

  /** Сдвинуть серверные часы. */
  advance(ms: number): void {
    this.clock += ms;
  }

  /** Явно установить серверные часы. */
  setNow(iso: string): void {
    this.clock = Date.parse(iso);
  }

  /** Текущее серверное время. */
  serverNow(): Promise<string> {
    return Promise.resolve(
        new Date(this.clock).toISOString(),
    );
  }

  /**
   * Положить строку так, будто её выгрузило другое устройство.
   *
   * server_updated_at задаётся сервером и не зависит от row.updated_at.
   */
  seed(
      table: SyncTable,
      rows: BaseRecord[],
      serverAtIso?: string,
  ): void {
    const at =
        serverAtIso ??
        new Date((this.clock += 1)).toISOString();

    const store = this.storeFor(table);

    for (const row of rows) {
      store.set(
          row.id,
          {
            ...row,
            server_updated_at: at,
          } as RemoteRow,
      );
    }
  }

  rows<T extends BaseRecord = BaseRecord>(
      table: SyncTable,
  ): RemoteRow<T>[] {
    return [
      ...this.storeFor(table).values(),
    ] as RemoteRow<T>[];
  }

  row<T extends BaseRecord = BaseRecord>(
      table: SyncTable,
      id: string,
  ): RemoteRow<T> | undefined {
    return this.storeFor(table).get(id) as
        | RemoteRow<T>
        | undefined;
  }

  pull(
      table: SyncTable,
      userId: string,
      since: string | null,
      limit: number,
  ): Promise<PullPage> {
    if (this.failNextPull) {
      const message = this.failNextPull;
      this.failNextPull = null;

      return Promise.reject(
          new Error(message),
      );
    }

    const rows = this.rows(table)
    .filter(
        (row) =>
            row.user_id === userId &&
            (
                since === null ||
                row.server_updated_at > since
            ),
    )
    .sort((a, b) =>
        a.server_updated_at < b.server_updated_at
            ? -1
            : a.server_updated_at > b.server_updated_at
                ? 1
                : 0,
    )
    .slice(0, limit);

    return Promise.resolve({
      rows,
      cursor: rows.length
          ? rows[rows.length - 1].server_updated_at
          : since,
    });
  }

  push(
      table: SyncTable,
      rows: BaseRecord[],
  ): Promise<void> {
    if (this.failPushAfterChunks !== null) {
      if (this.failPushAfterChunks === 0) {
        this.failPushAfterChunks = null;

        return Promise.reject(
            new Error(
                "связь оборвалась посреди выгрузки",
            ),
        );
      }

      this.failPushAfterChunks -= 1;
    }

    if (this.failNextPush) {
      const message = this.failNextPush;
      this.failNextPush = null;

      return Promise.reject(
          new Error(message),
      );
    }

    const store = this.storeFor(table);

    /**
     * Имитируем partial unique index:
     *
     *   unique(user_id, year, month)
     *   where deleted_at is null
     *
     * для periods.
     */
    if (table === "periods") {
      for (const row of rows) {
        const period = row as Period;

        if (period.deleted_at !== null) {
          continue;
        }

        const conflict = [...store.values()].find(
            (existing) => {
              const existingPeriod =
                  existing as RemoteRow<Period>;

              return (
                  existingPeriod.deleted_at === null &&
                  existingPeriod.user_id ===
                  period.user_id &&
                  existingPeriod.year === period.year &&
                  existingPeriod.month === period.month &&
                  existingPeriod.id !== period.id
              );
            },
        );

        if (conflict) {
          return Promise.reject(
              new Error(
                  'duplicate key value violates unique constraint "periods_user_month_uniq"',
              ),
          );
        }
      }
    }

    for (const row of rows) {
      this.clock += 1;

      store.set(
          row.id,
          {
            ...row,
            server_updated_at:
                new Date(this.clock).toISOString(),
          } as RemoteRow,
      );
    }

    this.pushedChunks.push({
      table,
      ids: rows.map((row) => row.id),
    });

    return Promise.resolve();
  }

  /**
   * Найти live period по логическому ключу:
   *
   *   user_id + year + month
   *
   * Это имитирует запрос production gateway к Supabase.
   */
  findPeriod(
      userId: string,
      year: number,
      month: number,
  ): Promise<RemoteRow | null> {
    const store = this.storeFor("periods");

    for (const row of store.values()) {
      const period = row as RemoteRow<Period>;

      if (
          period.user_id === userId &&
          period.year === year &&
          period.month === month &&
          period.deleted_at === null
      ) {
        return Promise.resolve(period);
      }
    }

    return Promise.resolve(null);
  }

  /**
   * Soft-delete remote period.
   *
   * Это освобождает logical unique key:
   *
   *   user_id + year + month
   *
   * потому что unique index учитывает только deleted_at IS NULL.
   */
  softDeletePeriod(
      id: string,
      userId: string,
      updatedAt: string,
  ): Promise<void> {
    const store = this.storeFor("periods");

    const existing = store.get(id);

    if (!existing) {
      return Promise.resolve();
    }

    if (existing.user_id !== userId) {
      return Promise.reject(
          new Error("user_id is immutable"),
      );
    }

    this.clock += 1;

    store.set(
        id,
        {
          ...existing,
          deleted_at: updatedAt,
          updated_at: updatedAt,
          server_updated_at:
              new Date(this.clock).toISOString(),
        } as RemoteRow,
    );

    return Promise.resolve();
  }

  private storeFor(
      table: SyncTable,
  ): Map<string, RemoteRow> {
    let store = this.tables.get(table);

    if (!store) {
      store = new Map();
      this.tables.set(table, store);
    }

    return store;
  }
}