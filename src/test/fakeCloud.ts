import type { BaseRecord } from "@/types/models";
import type { CloudGateway, PullPage, RemoteRow, SyncTable } from "@/lib/sync/types";

/**
 * Облако в памяти. Ни один тест синхронизации не имеет права ходить в сеть:
 * тест, которому нужен живой проект Supabase, не тест.
 *
 * Ведёт себя как таблица с триггером из supabase/sql/001_schema.sql: сервер
 * сам проставляет server_updated_at по СВОИМ часам, а клиентский updated_at
 * принимает как есть.
 */
export class FakeCloud implements CloudGateway {
  private readonly tables = new Map<SyncTable, Map<string, RemoteRow>>();
  private clock: number;
  /** Сообщение ближайшей неудачи выгрузки — как оборванная сеть посреди отправки. */
  failNextPush: string | null = null;
  failNextPull: string | null = null;
  pushedChunks: { table: SyncTable; ids: string[] }[] = [];

  constructor(startIso = "2026-08-30T12:00:00.000Z") {
    this.clock = Date.parse(startIso);
  }

  /** Сдвинуть серверные часы: у сервера они свои, и телефон на них не влияет. */
  advance(ms: number): void {
    this.clock += ms;
  }

  setNow(iso: string): void {
    this.clock = Date.parse(iso);
  }

  serverNow(): Promise<string> {
    return Promise.resolve(new Date(this.clock).toISOString());
  }

  /** Положить строку так, будто её выгрузило другое устройство. */
  seed(table: SyncTable, rows: BaseRecord[], serverAtIso?: string): void {
    const at = serverAtIso ?? new Date((this.clock += 1)).toISOString();
    const store = this.storeFor(table);
    for (const row of rows) store.set(row.id, { ...row, server_updated_at: at } as RemoteRow);
  }

  rows<T extends BaseRecord = BaseRecord>(table: SyncTable): RemoteRow<T>[] {
    return [...this.storeFor(table).values()] as RemoteRow<T>[];
  }

  row<T extends BaseRecord = BaseRecord>(table: SyncTable, id: string): RemoteRow<T> | undefined {
    return this.storeFor(table).get(id) as RemoteRow<T> | undefined;
  }

  pull(table: SyncTable, userId: string, since: string | null, limit: number): Promise<PullPage> {
    if (this.failNextPull) {
      const message = this.failNextPull;
      this.failNextPull = null;
      return Promise.reject(new Error(message));
    }
    const rows = this.rows(table)
      .filter((row) => row.user_id === userId && (since === null || row.server_updated_at > since))
      .sort((a, b) => (a.server_updated_at < b.server_updated_at ? -1 : 1))
      .slice(0, limit);
    return Promise.resolve({ rows, cursor: rows.length ? rows[rows.length - 1].server_updated_at : since });
  }

  push(table: SyncTable, rows: BaseRecord[]): Promise<void> {
    if (this.failNextPush) {
      const message = this.failNextPush;
      this.failNextPush = null;
      return Promise.reject(new Error(message));
    }
    const store = this.storeFor(table);
    for (const row of rows) {
      this.clock += 1;
      store.set(row.id, { ...row, server_updated_at: new Date(this.clock).toISOString() } as RemoteRow);
    }
    this.pushedChunks.push({ table, ids: rows.map((row) => row.id) });
    return Promise.resolve();
  }

  private storeFor(table: SyncTable): Map<string, RemoteRow> {
    let store = this.tables.get(table);
    if (!store) {
      store = new Map();
      this.tables.set(table, store);
    }
    return store;
  }
}
