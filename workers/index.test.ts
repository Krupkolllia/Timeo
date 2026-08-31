// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import worker, { KEEPALIVE_CRON, handleScheduled } from "./index";
import type { Env } from "./env";
import type { ExecutionContext, Fetcher } from "./runtime";

function envWith(assets: Fetcher, overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: assets,
    SUPABASE_URL: "https://abcdefgh.supabase.co",
    SUPABASE_ANON_KEY: "anon-key-value",
    ...overrides,
  };
}

const deadAssets: Fetcher = {
  fetch: () => Promise.reject(new Error("cron не имеет права трогать статику")),
};

describe("расписания", () => {
  it("выражение keep-alive совпадает с тем, что стоит в wrangler.jsonc", () => {
    const raw = readFileSync(path.resolve(__dirname, "../wrangler.jsonc"), "utf-8");
    // Комментарии в конфиге — построчные; значения кавычек с // не содержат.
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as { triggers: { crons: string[] } };

    // Cloudflare различает задачи по самому выражению: разъехавшаяся на минуту
    // константа означает cron, который срабатывает и не делает ничего.
    expect(config.triggers.crons).toContain(KEEPALIVE_CRON);
  });

  it("выражение keep-alive — раз в сутки, а не раз в час", () => {
    const [minute, hour, ...rest] = KEEPALIVE_CRON.split(" ");

    expect(minute).not.toBe("*");
    expect(hour).not.toBe("*");
    expect(rest).toEqual(["*", "*", "*"]);
  });
});

describe("cron-обработчик", () => {
  it("расписание keep-alive пингует Supabase", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));

    const result = await handleScheduled(KEEPALIVE_CRON, envWith(deadAssets), fetchImpl);

    expect(result).toEqual({ task: "keepalive", result: { status: "pinged", httpStatus: 200 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("незнакомое расписание не ходит в сеть и называет себя незнакомым", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null)));

    const result = await handleScheduled("41 6 * * 2", envWith(deadAssets), fetchImpl);

    expect(result).toEqual({ task: "unknown", cron: "41 6 * * 2" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("scheduled продлевает жизнь прогона через waitUntil и дожидается его", async () => {
    const waitUntil = vi.fn();
    const ctx: ExecutionContext = { waitUntil };
    const globalFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await worker.scheduled({ cron: KEEPALIVE_CRON, scheduledTime: 0 }, envWith(deadAssets), ctx);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0][0]).resolves.toEqual({
      task: "keepalive",
      result: { status: "pinged", httpStatus: 200 },
    });
    globalFetch.mockRestore();
  });
});

describe("раздача статики", () => {
  it("найденный файл отдаётся как есть", async () => {
    const assets: Fetcher = { fetch: () => Promise.resolve(new Response("app js", { status: 200 })) };

    const response = await worker.fetch(new Request("https://timeo.example/assets/index-abc.js"), envWith(assets));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("app js");
  });

  it("промах разворачивается в index.html — тем же ответом, что слой ассетов давал до появления воркера", async () => {
    const asked: string[] = [];
    const assets: Fetcher = {
      fetch: (request) => {
        asked.push(new URL(request.url).pathname);
        return Promise.resolve(
          new URL(request.url).pathname === "/index.html"
            ? new Response("<!doctype html>", { status: 200 })
            : new Response(null, { status: 404 }),
        );
      },
    };

    const response = await worker.fetch(new Request("https://timeo.example/settings"), envWith(assets));

    expect(asked).toEqual(["/settings", "/index.html"]);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<!doctype html>");
  });

  it("ответ 500 от слоя ассетов не подменяется на index.html", async () => {
    const assets: Fetcher = { fetch: () => Promise.resolve(new Response(null, { status: 500 })) };

    const response = await worker.fetch(new Request("https://timeo.example/anything"), envWith(assets));

    expect(response.status).toBe(500);
  });
});

describe("раздача статики — запросы с телом", () => {
  it("промах на POST не разворачивается в index.html", async () => {
    const asked: string[] = [];
    const assets: Fetcher = {
      fetch: (request) => {
        asked.push(new URL(request.url).pathname);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    };

    const request = new Request("https://timeo.example/api/whatever", { method: "POST", body: "x" });
    const response = await worker.fetch(request, envWith(assets));

    // Один заход, без второй попытки: пересобрать запрос с уже прочитанным
    // телом рантайм не даст, а слой ассетов такие запросы и не разворачивал.
    expect(asked).toEqual(["/api/whatever"]);
    expect(response.status).toBe(404);
  });

  it("HEAD-промах разворачивается так же, как GET", async () => {
    const asked: string[] = [];
    const assets: Fetcher = {
      fetch: (request) => {
        asked.push(`${request.method} ${new URL(request.url).pathname}`);
        return Promise.resolve(
          new URL(request.url).pathname === "/index.html"
            ? new Response(null, { status: 200 })
            : new Response(null, { status: 404 }),
        );
      },
    };

    const response = await worker.fetch(new Request("https://timeo.example/period", { method: "HEAD" }), envWith(assets));

    expect(asked).toEqual(["HEAD /period", "HEAD /index.html"]);
    expect(response.status).toBe(200);
  });
});
