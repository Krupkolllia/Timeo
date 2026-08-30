import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = {
  getSession: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
};

vi.mock("@/lib/sync/supabaseClient", () => ({
  get supabase() {
    return client;
  },
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon",
}));

let client: { auth: typeof auth } | null = { auth };

beforeEach(() => {
  client = { auth };
  vi.clearAllMocks();
});

describe("auth", () => {
  it("опознаёт неверный пароль отдельно от занятой почты и от пропавшей сети", async () => {
    const { signInWithPassword, signUpWithPassword } = await import("@/lib/sync/auth");

    auth.signInWithPassword.mockResolvedValue({ data: {}, error: { message: "Invalid login credentials", status: 400 } });
    expect(await signInWithPassword("a@b.c", "x")).toMatchObject({ ok: false, code: "invalid_credentials" });

    auth.signUp.mockResolvedValue({ data: {}, error: { message: "User already registered", status: 422 } });
    expect(await signUpWithPassword("a@b.c", "x")).toMatchObject({ ok: false, code: "email_taken" });

    auth.signInWithPassword.mockResolvedValue({ data: {}, error: { message: "Failed to fetch" } });
    expect(await signInWithPassword("a@b.c", "x")).toMatchObject({ ok: false, code: "network" });
  });

  it("регистрация без сессии не выдаётся за удачный вход", async () => {
    const { signUpWithPassword } = await import("@/lib/sync/auth");
    auth.signUp.mockResolvedValue({ data: { user: { id: "u-1", email: "a@b.c" }, session: null }, error: null });

    expect(await signUpWithPassword("a@b.c", "x")).toMatchObject({ ok: false, code: "unknown" });
  });

  it("удачный вход отдаёт идентификатор и почту", async () => {
    const { signInWithPassword } = await import("@/lib/sync/auth");
    auth.signInWithPassword.mockResolvedValue({ data: { user: { id: "u-1", email: "a@b.c" } }, error: null });

    expect(await signInWithPassword("a@b.c", "x")).toEqual({ ok: true, account: { userId: "u-1", email: "a@b.c" } });
  });

  it("инвариант 44: выход не обращается к базе вовсе", async () => {
    const { signOut } = await import("@/lib/sync/auth");
    auth.signOut.mockResolvedValue({ error: null });

    await signOut();

    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("инвариант 39: без облака вход отвечает отказом, а не падает", async () => {
    client = null;
    const { signInWithPassword, signUpWithPassword, currentAccount, isCloudConfigured, onAuthChange } = await import(
      "@/lib/sync/auth"
    );

    expect(isCloudConfigured()).toBe(false);
    expect(await currentAccount()).toBeNull();
    expect(await signInWithPassword("a@b.c", "x")).toMatchObject({ ok: false, code: "no_cloud" });
    expect(await signUpWithPassword("a@b.c", "x")).toMatchObject({ ok: false, code: "no_cloud" });
    expect(typeof onAuthChange(() => {})).toBe("function");
  });
});
