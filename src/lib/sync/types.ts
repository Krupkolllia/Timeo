import type { BaseRecord } from "@/types/models";

/**
 * Порядок здесь — это порядок применения и выгрузки, а не алфавит.
 *
 * Типы дня идут раньше записей, и это единственная защита инварианта 37 на
 * стороне клиента: запись, приехавшая раньше своего типа, не должна попасть в
 * базу. Внешнего ключа в Postgres намеренно нет (см. supabase/sql/001_schema.sql):
 * он отклонял бы всю выгрузку целиком, а инвариант 43 запрещает терять при этом
 * локальные данные.
 */
export const SYNC_TABLES = ["settings", "day_types", "periods", "holidays", "entries"] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

/**
 * Строка, как её отдаёт Postgres: те же поля, что локально, плюс серверная
 * отметка времени приёма. Клиент её не пишет — она проставляется триггером.
 */
export type RemoteRow<T extends BaseRecord = BaseRecord> = T & { server_updated_at: string };

export interface PullPage {
  rows: RemoteRow[];
  /** Курсор для следующей страницы: server_updated_at последней строки. */
  cursor: string | null;
}

/**
 * Транспорт отделён от логики намеренно: тесты синхронизации не имеют права
 * ходить в сеть, а решение «какая версия строки побеждает» обязано проверяться
 * без Supabase вообще — по тому же правилу, по которому в проекте живёт
 * lib/calc/*.
 */
export interface CloudGateway {
  /** Время сервера. Часы телефона источником истины не являются (инварианты 33 и 42). */
  serverNow(): Promise<string>;
  pull(table: SyncTable, userId: string, since: string | null, limit: number): Promise<PullPage>;
  push(table: SyncTable, rows: BaseRecord[]): Promise<void>;
}

export interface SyncCounts {
  pushed: number;
  pulled: number;
  /** Записи, отложенные до приезда своего типа дня (инвариант 37). */
  deferred: number;
}

export type SyncOutcome =
  | { kind: "done"; counts: SyncCounts; at: string }
  | { kind: "skipped"; reason: "no_cloud" | "signed_out" | "pending_choice" }
  | { kind: "failed"; message: string };
