import type { SupabaseClient } from "@supabase/supabase-js";
import type { BaseRecord } from "@/types/models";
import type { CloudGateway, PullPage, RemoteRow, SyncTable } from "@/lib/sync/types";

/**
 * Транспорт до Supabase. Логики слияния здесь нет ни строки: она вся в
 * lib/sync/merge.ts и проверяется без сети.
 */
export function createSupabaseGateway(client: SupabaseClient, restUrl: string, anonKey: string): CloudGateway {
  return {
    async serverNow(): Promise<string> {
      // Часы берём у сервера, а не у телефона: инвариант 42 держится именно на
      // этом, а Date.now() на устройстве с неверным временем — не источник
      // истины (инвариант 33). Заголовок Date есть у любого ответа PostgREST.
      const response = await fetch(`${restUrl}/rest/v1/`, {
        method: "HEAD",
        headers: { apikey: anonKey },
      });
      const header = response.headers.get("date");
      const parsed = header ? Date.parse(header) : Number.NaN;
      // Заголовка нет (прокси его срезал) — берём часы устройства. Хуже, чем
      // серверные, но лучше, чем отказ синхронизироваться вовсе (инвариант 39).
      return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
    },

    async pull(table: SyncTable, userId: string, since: string | null, limit: number): Promise<PullPage> {
      // Фильтры — до order/limit: PostgREST-строитель после них отдаёт другой
      // объект, у которого методов сравнения уже нет.
      let filter = client.from(table).select("*").eq("user_id", userId);
      if (since) filter = filter.gt("server_updated_at", since);

      const { data, error } = await filter.order("server_updated_at", { ascending: true }).limit(limit);
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as RemoteRow[];
      return { rows, cursor: rows.length ? rows[rows.length - 1].server_updated_at : since };
    },

    async push(table: SyncTable, rows: BaseRecord[]): Promise<void> {
      // server_updated_at пишет триггер, и отправлять его нельзя: клиент не
      // имеет права управлять порядком приёма (инвариант 42).
      const payload = rows.map((row) => {
        const copy = { ...row } as unknown as Record<string, unknown>;
        delete copy.server_updated_at;
        return copy;
      });
      const { error } = await client.from(table).upsert(payload, { onConflict: "id" });
      if (error) throw new Error(error.message);
    },
  };
}
