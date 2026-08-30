import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = {
  getSession: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithOAuth: vi.fn(),
  exchangeCodeForSession: vi.fn(),
};

/** Возврат от провайдера приезжает адресом, поэтому тест им же и начинается. */
function landOn(address: string): void {
  window.history.replaceState({ idx: 0 }, "", address);
}

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
  landOn("/more/account");
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

describe("вход через Google", () => {
  it("уходит к провайдеру с тем адресом возврата, который ему дали", async () => {
    const { signInWithGoogle } = await import("@/lib/sync/auth");
    auth.signInWithOAuth.mockResolvedValue({ data: { provider: "google", url: "https://accounts.google.com/x" }, error: null });

    expect(await signInWithGoogle("https://timeo.example/more/account")).toEqual({ ok: true });
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "https://timeo.example/more/account" },
    });
  });

  it("инвариант 39: без облака кнопка отвечает отказом, а не падает", async () => {
    client = null;
    const { signInWithGoogle, completeOAuthReturn } = await import("@/lib/sync/auth");

    expect(await signInWithGoogle("https://timeo.example/more/account")).toMatchObject({ ok: false, code: "no_cloud" });
    landOn("/more/account?code=abc");
    expect(await completeOAuthReturn()).toMatchObject({ kind: "failed", code: "no_cloud" });
    // Даже без облака код не имеет права остаться в адресе.
    expect(window.location.search).toBe("");
  });

  it("отказ провайдера опознаётся отдельно от поломки", async () => {
    const { signInWithGoogle } = await import("@/lib/sync/auth");
    auth.signInWithOAuth.mockResolvedValue({ data: {}, error: { message: "provider is not enabled", status: 400 } });

    expect(await signInWithGoogle("https://timeo.example/more/account")).toMatchObject({ ok: false, code: "oauth_failed" });
  });
});

describe("возврат от провайдера", () => {
  it("обычный адрес не трогается вовсе", async () => {
    const { completeOAuthReturn } = await import("@/lib/sync/auth");
    landOn("/more/account?return=%2Fmore");

    expect(await completeOAuthReturn()).toEqual({ kind: "none" });
    expect(window.location.search).toBe("?return=%2Fmore");
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("код обменивается на сессию, а адрес остаётся чистым", async () => {
    const { completeOAuthReturn } = await import("@/lib/sync/auth");
    auth.exchangeCodeForSession.mockResolvedValue({
      data: { session: { user: { id: "u-google", email: "father@example.com" } } },
      error: null,
    });
    landOn("/more/account?return=%2Fmore&code=code-4173&state=state-4173");
    const lengthBefore = window.history.length;

    expect(await completeOAuthReturn()).toEqual({
      kind: "signed_in",
      account: { userId: "u-google", email: "father@example.com" },
    });
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("code-4173");
    // Чужие параметры адреса переживают уборку, наши — нет.
    expect(window.location.search).toBe("?return=%2Fmore");
    expect(window.location.href).not.toContain("code-4173");
    // Записи с кодом в истории не остаётся: «назад» ведёт к провайдеру.
    expect(window.history.length).toBe(lengthBefore);
  });

  it("отмена на экране провайдера — это отказ, а не поломка", async () => {
    const { completeOAuthReturn } = await import("@/lib/sync/auth");
    landOn("/more/account?error=access_denied&error_code=403&error_description=The+user+denied+the+request");

    expect(await completeOAuthReturn()).toMatchObject({ kind: "failed", code: "oauth_cancelled" });
    expect(window.location.search).toBe("");
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("ошибка провайдера в решётке разбирается так же и уносит решётку целиком", async () => {
    const { completeOAuthReturn } = await import("@/lib/sync/auth");
    landOn("/more/account#error=server_error&error_description=Unable+to+exchange");

    expect(await completeOAuthReturn()).toMatchObject({ kind: "failed", code: "oauth_failed" });
    expect(window.location.hash).toBe("");
  });

  it("токен в адресе вместо кода не принимается за вход и в адресе не остаётся", async () => {
    const { completeOAuthReturn } = await import("@/lib/sync/auth");
    landOn("/more/account#access_token=fake-token-9931&refresh_token=fake-refresh&token_type=bearer");

    expect(await completeOAuthReturn()).toMatchObject({ kind: "failed", code: "oauth_failed" });
    expect(window.location.href).not.toContain("fake-token-9931");
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("оборванная сеть на обмене кода отличается от отказа провайдера", async () => {
    const { completeOAuthReturn } = await import("@/lib/sync/auth");
    auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: { message: "Failed to fetch" } });
    landOn("/more/account?code=code-2200");

    expect(await completeOAuthReturn()).toMatchObject({ kind: "failed", code: "network" });
    expect(window.location.search).toBe("");
  });

  it("обмен без пользователя в ответе не выдаётся за вход", async () => {
    const { completeOAuthReturn } = await import("@/lib/sync/auth");
    auth.exchangeCodeForSession.mockResolvedValue({ data: { session: null }, error: null });
    landOn("/more/account?code=code-2201");

    expect(await completeOAuthReturn()).toMatchObject({ kind: "failed", code: "oauth_failed" });
  });
});
