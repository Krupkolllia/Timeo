// @vitest-environment node
//
// Node, а не jsdom фронтенда: воркер живёт не в браузере, и проверять его
// логику в окружении с document — значит проверять не то, что поедет на
// Cloudflare. Сети здесь нет ни в одном тесте: fetch всегда приходит
// параметром и всегда поддельный.
import { describe, expect, it, vi } from "vitest";
import { buildKeepAlivePing, runKeepAlive } from "./keepalive";
import type { Env } from "./env";
import type { Fetcher } from "./runtime";

const ASSETS: Fetcher = {
  fetch: () => Promise.reject(new Error("keep-alive не имеет права трогать статику")),
};

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS,
    SUPABASE_URL: "https://abcdefgh.supabase.co",
    SUPABASE_ANON_KEY: "anon-key-value",
    ...overrides,
  };
}

describe("keep-alive — что именно уходит в сеть", () => {
  it("за прогон делает ровно один запрос", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

    await runKeepAlive(envWith(), fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("это HEAD по корню PostgREST с anon-ключом и без тела", () => {
    const ping = buildKeepAlivePing(envWith());

    expect(ping).toEqual({
      url: "https://abcdefgh.supabase.co/rest/v1/",
      method: "HEAD",
      headers: { apikey: "anon-key-value" },
    });
  });

  it("не обращается ни к одной таблице с пользовательскими данными", () => {
    const ping = buildKeepAlivePing(envWith());

    // Ровно корень: ни имени таблицы, ни select, ни фильтра. Иначе «лёгкий
    // запрос» однажды превратится в чтение чужих строк.
    expect(new URL(ping!.url).pathname).toBe("/rest/v1/");
    expect(new URL(ping!.url).search).toBe("");
    for (const table of ["settings", "entries", "periods", "day_types", "holidays", "push_subscriptions"]) {
      expect(ping!.url).not.toContain(table);
    }
  });

  it("хвостовой слэш в адресе проекта не удваивается", () => {
    const ping = buildKeepAlivePing(envWith({ SUPABASE_URL: "https://abcdefgh.supabase.co/" }));

    expect(ping?.url).toBe("https://abcdefgh.supabase.co/rest/v1/");
  });

  it("возвращает код ответа, каким бы он ни был: жив проект или нет — решает не воркер", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })));

    await expect(runKeepAlive(envWith(), fetchImpl)).resolves.toEqual({ status: "pinged", httpStatus: 401 });
  });
});

describe("keep-alive — когда делать нечего", () => {
  it("без адреса проекта не ходит никуда и не считает это ошибкой", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null)));

    const result = await runKeepAlive(envWith({ SUPABASE_URL: undefined }), fetchImpl);

    expect(result).toEqual({ status: "skipped", reason: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("без ключа — так же", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null)));

    const result = await runKeepAlive(envWith({ SUPABASE_ANON_KEY: "   " }), fetchImpl);

    expect(result).toEqual({ status: "skipped", reason: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("упавшая сеть возвращается значением, а не исключением", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("connect ETIMEDOUT")));

    await expect(runKeepAlive(envWith(), fetchImpl)).resolves.toEqual({
      status: "failed",
      message: "connect ETIMEDOUT",
    });
  });

  it("падение не-ошибкой тоже переживает", async () => {
    const fetchImpl = vi.fn(() => Promise.reject("строка вместо Error"));

    await expect(runKeepAlive(envWith(), fetchImpl)).resolves.toEqual({
      status: "failed",
      message: "строка вместо Error",
    });
  });
});
