import type { Env } from "./env";
import type { FetchLike } from "./runtime";

/**
 * Keep-alive из раздела 4 ТЗ и из раздела 12 («Supabase pauses after a week of
 * inactivity»). Бесплатный проект Supabase засыпает после недели без обращений:
 * данные при этом целы, но проект нужно поднимать руками из панели, а до тех
 * пор синхронизация не работает (приложение — работает, инвариант 39).
 *
 * Отсюда весь смысл: раз в сутки сделать по проекту одно обращение, чтобы
 * неделя простоя никогда не набралась. Пользовательских данных ping не
 * касается — ни одной строки не читает и не пишет.
 */

/** Что именно уйдёт в сеть за прогон. Отдельный тип, чтобы это можно было проверить, не отправляя. */
export interface KeepAlivePing {
  url: string;
  method: "HEAD";
  headers: Record<string, string>;
}

export type KeepAliveResult =
  /** Переменных окружения нет — сборка без облака. Это не ошибка. */
  | { status: "skipped"; reason: "not_configured" }
  | { status: "pinged"; httpStatus: number }
  | { status: "failed"; message: string };

/**
 * Чистая функция: окружение → единственный запрос прогона (или null).
 *
 * Корень PostgREST, а не таблица: любой запрос к таблице упёрся бы в RLS
 * (раздел 4: у роли anon нет ни одной привилегии), а главное — читать чужие
 * строки ради «проект жив» незачем. HEAD, а не GET: тело ответа не нужно.
 * Ровно этим же обращением синхронизация берёт время сервера
 * (src/lib/sync/gateway.ts), так что путь заведомо рабочий.
 */
export function buildKeepAlivePing(env: Env): KeepAlivePing | null {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;

  return {
    // Хвостовой слэш в переменной — обычное дело; без нормализации получилось
    // бы https://x.supabase.co//rest/v1/.
    url: `${url.replace(/\/+$/, "")}/rest/v1/`,
    method: "HEAD",
    headers: { apikey: key },
  };
}

/**
 * Один прогон cron. Ровно один запрос — или ни одного, если ключей нет.
 *
 * Сеть падает и без нашего участия, а упавший cron Cloudflare покажет как
 * ошибку прогона и ничего полезного этим не добьётся: следующий запуск через
 * сутки всё равно состоится. Поэтому отказ возвращается значением, а не
 * исключением.
 */
export async function runKeepAlive(env: Env, fetchImpl: FetchLike): Promise<KeepAliveResult> {
  const ping = buildKeepAlivePing(env);
  if (!ping) return { status: "skipped", reason: "not_configured" };

  try {
    const response = await fetchImpl(ping.url, { method: ping.method, headers: ping.headers });
    return { status: "pinged", httpStatus: response.status };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
