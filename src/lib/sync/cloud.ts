import { createSupabaseGateway } from "@/lib/sync/gateway";
import { supabase, supabaseAnonKey, supabaseUrl } from "@/lib/sync/supabaseClient";
import type { CloudGateway } from "@/lib/sync/types";

/**
 * Единственный шлюз приложения. null — сборка без переменных окружения: всё
 * работает ровно как раньше, просто ничего никуда не уезжает (инвариант 39).
 */
export const cloudGateway: CloudGateway | null = supabase
  ? createSupabaseGateway(supabase, supabaseUrl, supabaseAnonKey)
  : null;
