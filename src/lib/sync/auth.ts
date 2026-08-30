import { supabase } from "@/lib/sync/supabaseClient";

export interface AuthAccount {
  userId: string;
  email: string | null;
}

export type AuthErrorCode = "no_cloud" | "invalid_credentials" | "email_taken" | "network" | "unknown";

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

export function onAuthChange(callback: (account: AuthAccount | null) => void): () => void {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(accountOf(session?.user));
  });
  return () => data.subscription.unsubscribe();
}
