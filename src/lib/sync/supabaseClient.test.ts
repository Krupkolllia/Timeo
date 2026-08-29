import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("supabaseClient", () => {
  it("не создаётся, пока переменных окружения нет — приложение работает без облака (инвариант 39)", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    vi.resetModules();

    const { supabase } = await import("@/lib/sync/supabaseClient");
    expect(supabase).toBeNull();
  });

  it("создаётся, когда обе переменные заданы", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "anon-key");
    vi.resetModules();

    const { supabase } = await import("@/lib/sync/supabaseClient");
    expect(supabase).not.toBeNull();
  });
});
