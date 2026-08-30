import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;

/**
 * Те же значения, но отдельно: шлюзу (lib/sync/gateway.ts) нужен голый REST-адрес
 * для запроса серверного времени. Ключ — только anon; service_role в клиенте не
 * появляется никогда и в коммит не попадает ни один ключ (CLAUDE.md).
 */
export const supabaseUrl = url ?? "";
export const supabaseAnonKey = anonKey ?? "";
