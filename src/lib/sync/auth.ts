import { supabase } from "@/lib/sync/supabaseClient";

export interface AuthAccount {
  userId: string;
  email: string | null;
}

export type AuthErrorCode =
  | "no_cloud"
  | "invalid_credentials"
  | "email_taken"
  | "network"
  | "unknown"
  /** Человек нажал «Войти через Google», передумал и вернулся. Это не ошибка. */
  | "oauth_cancelled"
  /** Провайдер вернул отказ или код не обменялся: возврат пришёл не в тот контекст. */
  | "oauth_failed";

export type AuthResult = { ok: true; account: AuthAccount } | { ok: false; code: AuthErrorCode; message: string };

function accountOf(user: { id: string; email?: string | null } | null | undefined): AuthAccount | null {
  return user ? { userId: user.id, email: user.email ?? null } : null;
}

/**
 * Сообщения Supabase приходят по-английски и меняются от версии к версии.
 * Экран показывает свой текст рядом с полем (инвариант 54), поэтому здесь —
 * только опознание причины, без перевода.
 */
function codeOf(message: string, status?: number): AuthErrorCode {
  const text = message.toLowerCase();
  if (text.includes("already registered") || text.includes("already been registered")) return "email_taken";
  if (text.includes("invalid login") || text.includes("invalid credentials") || status === 400) {
    return "invalid_credentials";
  }
  if (text.includes("fetch") || text.includes("network") || text.includes("failed to fetch")) return "network";
  return "unknown";
}

export function isCloudConfigured(): boolean {
  return supabase !== null;
}

export async function currentAccount(): Promise<AuthAccount | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return accountOf(data.session?.user);
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { ok: false, code: "no_cloud", message: "cloud is not configured" };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, code: codeOf(error.message, error.status), message: error.message };
  const account = accountOf(data.user);
  return account ? { ok: true, account } : { ok: false, code: "unknown", message: "no user in response" };
}

export async function signUpWithPassword(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { ok: false, code: "no_cloud", message: "cloud is not configured" };
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { ok: false, code: codeOf(error.message, error.status), message: error.message };
  const account = accountOf(data.user);
  // Подтверждение почты в проекте выключено (mailer_autoconfirm), поэтому
  // сессия появляется сразу. Если его когда-нибудь включат, пользователя без
  // сессии видно здесь и экран скажет об этом, а не сделает вид, что вошёл.
  return account && data.session
    ? { ok: true, account }
    : { ok: false, code: "unknown", message: "sign-up did not produce a session" };
}

/**
 * Инвариант 44: выход не трогает локальную базу. Здесь вообще нет ни одного
 * обращения к Dexie — и это не случайность, а всё содержание требования.
 */
export async function signOut(): Promise<void> {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** Начало входа через провайдера. Успех здесь означает «браузер уходит», а не «вошли». */
export type OAuthStart = { ok: true } | { ok: false; code: AuthErrorCode; message: string };

/**
 * Что приехало в адресе после провайдера.
 * `none` — в адресе не было ничего нашего, и адрес не тронут.
 */
export type OAuthReturn =
  | { kind: "none" }
  | { kind: "signed_in"; account: AuthAccount }
  | { kind: "failed"; code: AuthErrorCode; message: string };

/**
 * Всё, что возврат от провайдера способен положить в адрес. Ни одно из этих
 * значений не имеет права остаться в адресной строке: и код, и токен — секрет.
 */
const RETURN_PARAMS = [
  "code",
  "state",
  "error",
  "error_code",
  "error_description",
  "access_token",
  "refresh_token",
  "expires_in",
  "expires_at",
  "token_type",
  "provider_token",
  "provider_refresh_token",
];

function paramsOf(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

function hasReturnParams(params: URLSearchParams): boolean {
  return RETURN_PARAMS.some((key) => params.has(key));
}

/**
 * Адрес после разбора обязан быть чистым, и запись с секретом не имеет права
 * остаться в истории: replaceState заменяет текущую запись, поэтому «назад»
 * ведёт к провайдеру, а не в состояние с кодом в адресе.
 */
function cleanAddress(): void {
  const url = new URL(window.location.href);
  for (const key of RETURN_PARAMS) url.searchParams.delete(key);
  if (hasReturnParams(paramsOf(url.hash))) url.hash = "";
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Уводит браузер к провайдеру. Целой вкладкой, а не всплывающим окном: на iOS
 * окно, открытое не по прямому касанию ссылки, закрывается вместе с переходом.
 */
export async function signInWithGoogle(redirectTo: string): Promise<OAuthStart> {
  if (!supabase) return { ok: false, code: "no_cloud", message: "cloud is not configured" };
  const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  if (error) {
    const code = codeOf(error.message, error.status);
    return { ok: false, code: code === "network" ? "network" : "oauth_failed", message: error.message };
  }
  return { ok: true };
}

/**
 * Разбор возврата от провайдера. Вызывается на запуске приложения по любому
 * адресу: если список Redirect URLs в Supabase окажется неполным, человек
 * вернётся на Site URL, то есть на календарь, и там адрес обязан очиститься
 * точно так же.
 *
 * Ни один экран этого не ждёт (инварианты 39 и 40): приложение уже открыто и
 * работает, а результат доезжает до экрана аккаунта словами.
 */
export async function completeOAuthReturn(): Promise<OAuthReturn> {
  const search = new URLSearchParams(window.location.search);
  const hash = paramsOf(window.location.hash);
  if (!hasReturnParams(search) && !hasReturnParams(hash)) return { kind: "none" };

  const code = search.get("code") ?? hash.get("code");
  const error = search.get("error") ?? hash.get("error");
  const description = search.get("error_description") ?? hash.get("error_description") ?? error ?? "";
  // До обмена, а не после: адрес не должен пережить ни успех, ни отказ, ни
  // исключение по дороге.
  cleanAddress();

  if (!supabase) return { kind: "failed", code: "no_cloud", message: "cloud is not configured" };
  // Отказ на экране провайдера («Отмена», закрытая вкладка) приезжает сюда
  // именно так, и это не ошибка приложения.
  if (error) {
    return { kind: "failed", code: error === "access_denied" ? "oauth_cancelled" : "oauth_failed", message: description };
  }
  // Токен в адресе вместо кода означает поток implicit, которого у нас нет.
  // Такую сессию не принимаем: из адреса она уже стёрта, а тихо войти по
  // значению, которое могли вписать руками, — не то, чего мы хотим.
  if (!code) return { kind: "failed", code: "oauth_failed", message: "unexpected grant in the address" };

  const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    const mapped = codeOf(exchangeError.message, exchangeError.status);
    return { kind: "failed", code: mapped === "network" ? "network" : "oauth_failed", message: exchangeError.message };
  }
  const account = accountOf(data.session?.user);
  return account ? { kind: "signed_in", account } : { kind: "failed", code: "oauth_failed", message: "no user in response" };
}

export function onAuthChange(callback: (account: AuthAccount | null) => void): () => void {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(accountOf(session?.user));
  });
  return () => data.subscription.unsubscribe();
}
