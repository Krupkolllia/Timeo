/**
 * Минимум типов рантайма Cloudflare, которыми пользуется воркер.
 *
 * Не @cloudflare/workers-types: пакет объявляет глобально свой Request,
 * Response и половину DOM, и в одном репозитории с фронтендом это означает
 * два несовместимых определения одних и тех же имён. Здесь нужны ровно три
 * вещи, которых нет в стандартной библиотеке TypeScript, — и они описаны
 * тут, без зависимости, которую пришлось бы обновлять.
 */

/** Аргумент cron-обработчика. `cron` — то самое выражение из wrangler.jsonc. */
export interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Привязка статики (`assets.binding` в wrangler.jsonc). */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * Сигнатура fetch, от которой зависят обработчики. Существует ради тестов:
 * ни один тест воркера не имеет права ходить в сеть, поэтому запрос всегда
 * приходит параметром, а не берётся из глобального объекта.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
