import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          // PKCE, а не умолчание библиотеки (implicit). Возврат от провайдера на
          // iOS может прийти не в иконку с домашнего экрана, а в Safari: implicit
          // отдал бы туда рабочую сессию с токенами прямо в адресе — в истории и
          // во вкладке чужого контекста. С PKCE в адресе бывает только одноразовый
          // код, а обменять его может лишь тот контекст, который вход начал.
          flowType: "pkce",
          // Возврат разбирается своим кодом (lib/sync/auth.ts): адрес чистится
          // до обмена, а отказ провайдера обязан доехать до экрана словами.
          // Автоматический разбор делает и то и другое молча.
          detectSessionInUrl: false,
        },
      })
    : null;

/**
 * Те же значения, но отдельно: шлюзу (lib/sync/gateway.ts) нужен голый REST-адрес
 * для запроса серверного времени. Ключ — только anon; service_role в клиенте не
 * появляется никогда и в коммит не попадает ни один ключ (CLAUDE.md).
 */
export const supabaseUrl = url ?? "";
export const supabaseAnonKey = anonKey ?? "";
