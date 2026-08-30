import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseGateway } from "@/lib/sync/gateway";
import { makeEntry } from "@/test/factories";

interface Recorded {
  table: string;
  filters: Record<string, unknown>;
  upserted: unknown;
}

function fakeClient(rows: unknown[] = [], error: string | null = null) {
  const recorded: Recorded = { table: "", filters: {}, upserted: null };

  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      recorded.filters[`eq:${column}`] = value;
      return builder;
    },
    gt: (column: string, value: unknown) => {
      recorded.filters[`gt:${column}`] = value;
      return builder;
    },
    order: (column: string) => {
      recorded.filters.order = column;
      return builder;
    },
    limit: (value: number) => {
      recorded.filters.limit = value;
      return Promise.resolve({ data: rows, error: error ? { message: error } : null });
    },
    upsert: (payload: unknown) => {
      recorded.upserted = payload;
      return Promise.resolve({ error: error ? { message: error } : null });
    },
  };

  const client = {
    from: (table: string) => {
      recorded.table = table;
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, recorded };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSupabaseGateway", () => {
  it("докачка фильтрует по пользователю и по серверной отметке, курсор берётся из последней строки", async () => {
    const rows = [
      { ...makeEntry({ id: "e-1" }), server_updated_at: "2026-08-30T09:00:00.000Z" },
      { ...makeEntry({ id: "e-2" }), server_updated_at: "2026-08-30T09:00:05.000Z" },
    ];
    const { client, recorded } = fakeClient(rows);
    const gateway = createSupabaseGateway(client, "https://example.supabase.co", "anon");

    const page = await gateway.pull("entries", "user-test", "2026-08-30T08:00:00.000Z", 500);

    expect(recorded.table).toBe("entries");
    expect(recorded.filters["eq:user_id"]).toBe("user-test");
    expect(recorded.filters["gt:server_updated_at"]).toBe("2026-08-30T08:00:00.000Z");
    expect(recorded.filters.order).toBe("server_updated_at");
    expect(page.cursor).toBe("2026-08-30T09:00:05.000Z");
  });

  it("первая докачка идёт без фильтра по отметке, а пустой ответ курсор не двигает", async () => {
    const { client, recorded } = fakeClient([]);
    const gateway = createSupabaseGateway(client, "https://example.supabase.co", "anon");

    const page = await gateway.pull("periods", "user-test", null, 500);

    expect(recorded.filters["gt:server_updated_at"]).toBeUndefined();
    expect(page.cursor).toBeNull();
  });

  it("выгрузка не отправляет серверную колонку: порядком приёма распоряжается сервер", async () => {
    const { client, recorded } = fakeClient();
    const gateway = createSupabaseGateway(client, "https://example.supabase.co", "anon");

    await gateway.push("entries", [
      { ...makeEntry({ id: "e-1" }), server_updated_at: "2026-08-30T09:00:00.000Z" } as never,
    ]);

    const payload = recorded.upserted as Record<string, unknown>[];
    expect(payload[0]).not.toHaveProperty("server_updated_at");
    expect(payload[0].id).toBe("e-1");
  });

  it("ошибка PostgREST становится исключением, а не тихо пустым ответом", async () => {
    const { client } = fakeClient([], "permission denied for table entries");
    const gateway = createSupabaseGateway(client, "https://example.supabase.co", "anon");

    await expect(gateway.pull("entries", "user-test", null, 10)).rejects.toThrow("permission denied");
    await expect(gateway.push("entries", [makeEntry()])).rejects.toThrow("permission denied");
  });

  it("время берётся у сервера, а не у телефона", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ headers: new Headers({ date: "Sun, 30 Aug 2026 09:00:00 GMT" }) }),
    );
    const { client } = fakeClient();
    const gateway = createSupabaseGateway(client, "https://example.supabase.co", "anon");

    expect(await gateway.serverNow()).toBe("2026-08-30T09:00:00.000Z");
  });

  it("без заголовка Date синхронизация не отказывает, а берёт часы устройства", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ headers: new Headers() }));
    const { client } = fakeClient();
    const gateway = createSupabaseGateway(client, "https://example.supabase.co", "anon");

    const now = await gateway.serverNow();
    expect(Number.isNaN(Date.parse(now))).toBe(false);
  });
});
