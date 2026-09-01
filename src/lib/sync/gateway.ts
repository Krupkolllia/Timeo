import type { SupabaseClient } from "@supabase/supabase-js";
import type { BaseRecord } from "@/types/models";
import type {
  CloudGateway,
  PullPage,
  RemoteRow,
  SyncTable,
} from "@/lib/sync/types";

/**
 * Транспорт до Supabase. Логики слияния здесь нет.
 */
export function createSupabaseGateway(
    client: SupabaseClient,
    restUrl: string,
    anonKey: string,
): CloudGateway {
  return {
    async serverNow(): Promise<string> {
      // Часы берём у сервера, а не у телефона.
      const response = await fetch(
          `${restUrl.replace(/\/+$/, "")}/rest/v1/`,
          {
            method: "HEAD",
            headers: { apikey: anonKey },
          },
      );

      const header = response.headers.get("date");
      const parsed = header ? Date.parse(header) : Number.NaN;

      // Заголовок Date может отсутствовать у прокси.
      return Number.isNaN(parsed)
          ? new Date().toISOString()
          : new Date(parsed).toISOString();
    },

    async pull(
        table: SyncTable,
        userId: string,
        since: string | null,
        limit: number,
    ): Promise<PullPage> {
      let filter = client
      .from(table)
      .select("*")
      .eq("user_id", userId);

      if (since) {
        filter = filter.gt("server_updated_at", since);
      }

      const { data, error } = await filter
      .order("server_updated_at", { ascending: true })
      .limit(limit);

      if (error) {
        throw new Error(error.message);
      }

      const rows = (data ?? []) as RemoteRow[];

      return {
        rows,
        cursor: rows.length
            ? rows[rows.length - 1].server_updated_at
            : since,
      };
    },

    async push(
        table: SyncTable,
        rows: BaseRecord[],
    ): Promise<void> {
      // server_updated_at пишет серверный trigger.
      const payload = rows.map((row) => {
        const copy = { ...row } as unknown as Record<string, unknown>;
        delete copy.server_updated_at;
        return copy;
      });

      const { error } = await client
      .from(table)
      .upsert(payload, { onConflict: "id" });

      if (error) {
        throw new Error(error.message);
      }
    },

    async findPeriod(
        userId: string,
        year: number,
        month: number,
    ): Promise<RemoteRow | null> {
      /**
       * periods имеет логическую уникальность:
       *
       *   user_id + year + month
       *
       * Поэтому перед push нужно знать, не занят ли этот logical key
       * другим UUID.
       */
      const { data, error } = await client
      .from("periods")
      .select("*")
      .eq("user_id", userId)
      .eq("year", year)
      .eq("month", month)
      .is("deleted_at", null)
      .maybeSingle();

      if (error) {
        throw new Error(error.message);
      }

      return data ? (data as RemoteRow) : null;
    },

    async softDeletePeriod(
        id: string,
        userId: string,
        updatedAt: string,
    ): Promise<void> {
      /**
       * Hard DELETE для sync не используется.
       *
       * После soft-delete partial unique index перестаёт учитывать эту строку,
       * поэтому другой UUID того же месяца можно вставить.
       */
      const { error } = await client
      .from("periods")
      .update({
        deleted_at: updatedAt,
        updated_at: updatedAt,
      })
      .eq("id", id)
      .eq("user_id", userId);

      if (error) {
        throw new Error(error.message);
      }
    },
  };
}