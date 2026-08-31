import type { Env } from "./env";
import type { ExecutionContext, FetchLike, ScheduledController } from "./runtime";
import { runKeepAlive, type KeepAliveResult } from "./keepalive";

/**
 * Единственный воркер проекта. Раздел 4 ТЗ решает это прямо: тот же воркер,
 * что хостит статику, несёт и cron'ы — на Pages для этого понадобился бы
 * второй проект, и поэтому хостинг здесь Workers, а не Pages.
 */

/**
 * Расписания. Cloudflare отдаёт обработчику само выражение, поэтому оно же и
 * различает задачи — держать их в одной константе с wrangler.jsonc нельзя,
 * конфиг не импортируется, но опечатку ловит тест.
 *
 * 03:17 UTC, а не полночь: в начале часа (и особенно суток) у Cloudflare
 * очередь из чужих cron'ов, и запуск может уехать на минуты. Точность здесь не
 * нужна вовсе — важно лишь, чтобы между двумя прогонами не набралась неделя.
 */
export const KEEPALIVE_CRON = "17 3 * * *";

export type ScheduledResult =
  | { task: "keepalive"; result: KeepAliveResult }
  /** Расписание есть в Cloudflare, но обработчика под него нет — молчать об этом нельзя. */
  | { task: "unknown"; cron: string };

/**
 * Куда уходит сработавший cron. Отдельно от `default.scheduled`, чтобы
 * проверяться без Cloudflare: на вход — выражение и окружение, на выход —
 * что сделано.
 */
export async function handleScheduled(cron: string, env: Env, fetchImpl: FetchLike): Promise<ScheduledResult> {
  if (cron === KEEPALIVE_CRON) {
    return { task: "keepalive", result: await runKeepAlive(env, fetchImpl) };
  }
  return { task: "unknown", cron };
}

/**
 * Статика. До появления этого файла в wrangler.jsonc не было `main` вовсе, и
 * всё раздавал слой ассетов; теперь запрос, не совпавший с файлом, доходит
 * сюда — и обязан вести себя ровно как раньше, иначе выкатка ломает открытое
 * приложение (CLAUDE.md: прод не ломать).
 *
 * Переходы по адресам (Sec-Fetch-Mode: navigate) до воркера вообще не
 * доезжают: их слой ассетов сам разворачивает в index.html по
 * not_found_handling, так что глубокие ссылки (/settings, /more/account)
 * работают помимо этого кода. Остальное — запросы за файлами; на промах
 * повторяем прежний ответ слоя ассетов вручную.
 */
async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;

  // Только чтение. Пересобрать запрос с телом из уже прочитанного запроса
  // рантайм не даст, а разворачивать POST в index.html и незачем: слой ассетов
  // разворачивал в неё переходы по адресам, то есть GET.
  if (request.method !== "GET" && request.method !== "HEAD") return response;

  return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), { method: request.method }));
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return serveAsset(request, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // waitUntil, а не голый await: обработчик обязан дожить до конца запроса,
    // даже если Cloudflare перестанет ждать возвращённый промис.
    const work = handleScheduled(controller.cron, env, fetch);
    ctx.waitUntil(work);
    await work;
  },
};
