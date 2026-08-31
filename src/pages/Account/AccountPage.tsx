import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useBackTo } from "@/app/useBackTo";
import { db } from "@/db/db";
import { cloudGateway } from "@/lib/sync/cloud";
import { signInWithGoogle, signInWithPassword, signOut, signUpWithPassword, type AuthErrorCode } from "@/lib/sync/auth";
import { completeFirstSignIn, confirmDifferentUser, handleAccountChange, runSync } from "@/lib/sync/controller";
import { useSyncStore } from "@/store/syncStore";
import type { DataSummary } from "@/db/account";
import { ru } from "@/i18n/ru";

function errorText(code: AuthErrorCode): string {
  switch (code) {
    case "invalid_credentials":
      return ru.account.errorInvalidCredentials;
    case "email_taken":
      return ru.account.errorEmailTaken;
    case "network":
      return ru.account.errorNetwork;
    case "no_cloud":
      return ru.account.errorNoCloud;
    case "oauth_cancelled":
      return ru.account.errorOauthCancelled;
    case "oauth_failed":
      return ru.account.errorOauthFailed;
    case "unknown":
      return ru.account.errorUnknown;
  }
}

function Summary({ label, summary }: { label: string; summary: DataSummary }) {
  return (
    <p className="text-xs text-app-fg/50">
      {label} {summary.periods} {ru.account.countPeriods} · {summary.entries} {ru.account.countEntries} ·{" "}
      {summary.day_types} {ru.account.countDayTypes} · {summary.holidays} {ru.account.countHolidays} ·{" "}
      {summary.months_with_money} {ru.account.countMonthsWithMoney}
    </p>
  );
}

export function AccountPage() {
  const [searchParams] = useSearchParams();
  const goBack = useBackTo(searchParams.get("return") ?? "/more");
  const navigate = useNavigate();

  const phase = useSyncStore((state) => state.phase);
  const account = useSyncStore((state) => state.account);
  const lastSyncAt = useSyncStore((state) => state.lastSyncAt);
  const lastError = useSyncStore((state) => state.lastError);
  const choice = useSyncStore((state) => state.choice);
  const differentUser = useSyncStore((state) => state.differentUser);
  // Возврат от провайдера разбирается на запуске приложения, а не здесь: экран
  // только показывает, чем та попытка кончилась.
  const signInError = useSyncStore((state) => state.signInError);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const [eraseUnderstood, setEraseUnderstood] = useState(false);

  async function submit(kind: "in" | "up") {
    if (busy) return;
    setFieldError(null);
    useSyncStore.getState().set({ signInError: null });
    if (!email.trim()) {
      setFieldError(ru.account.errorEmptyEmail);
      return;
    }
    if (!password) {
      setFieldError(ru.account.errorEmptyPassword);
      return;
    }

    setBusy(true);
    try {
      const result =
        kind === "in" ? await signInWithPassword(email.trim(), password) : await signUpWithPassword(email.trim(), password);
      if (!result.ok) {
        // Инвариант 54 и 58: сообщение рядом с полем, а не модалка-ловушка и не
        // пустой экран. Пароль остаётся набранным — опечатка в почте не должна
        // стоить второго ввода пароля.
        setFieldError(errorText(result.code));
        return;
      }
      setPassword("");
      await handleAccountChange(db, cloudGateway, result.account, __APP_VERSION__);
    } catch (error) {
      // Исключение (а не отказ) — тоже исход, и молча заканчиваться он не имеет
      // права: на скриншоте с телефона «ничего не произошло» неотличимо от
      // сломанной сборки (раздел 12).
      setFieldError(`${ru.account.errorUnknown} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Вход через Google уводит браузер наружу, поэтому здесь всё кончается либо
   * уходом со страницы, либо сообщением рядом с кнопкой. Локальной базы эта
   * кнопка не касается вовсе.
   */
  async function startGoogle() {
    if (busy) return;
    setFieldError(null);
    setBusy(true);
    useSyncStore.getState().set({ signInError: null });
    try {
      const result = await signInWithGoogle(`${window.location.origin}/more/account`);
      if (!result.ok) useSyncStore.getState().set({ signInError: result.code });
    } catch {
      // Исключение вместо отказа — тоже исход, и молчать о нём нельзя: на
      // скриншоте «ничего не произошло» неотличимо от сломанной сборки.
      useSyncStore.getState().set({ signInError: "oauth_failed" });
    } finally {
      setBusy(false);
    }
  }

  async function withBusy(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(`${ru.account.errorUnknown} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-app-bg text-app-fg">
      <header className="flex shrink-0 items-center gap-1 px-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-2">
        <button
          className="rounded-full p-3 text-xl text-app-fg/70 active:bg-app-fg/10"
          onClick={goBack}
          aria-label={ru.account.back}
        >
          ‹
        </button>
        <span className="min-w-0 truncate text-lg font-semibold tracking-tight">{ru.account.title}</span>
      </header>

      {actionError && (
        <p className="shrink-0 px-4 pb-2 text-xs text-app-fg/70" role="status">
          {actionError}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        {phase === "disabled" && (
          <section>
            <h2 className="text-sm font-semibold">{ru.account.disabledTitle}</h2>
            <p className="mt-2 text-xs text-app-fg/50">{ru.account.disabledBody}</p>
          </section>
        )}

        {phase === "different_user" && differentUser && (
          <section className="flex min-h-0 flex-1 flex-col">
            <h2 className="text-sm font-semibold">{ru.account.differentUserTitle}</h2>
            <p className="mt-2 text-xs text-app-fg/50">{ru.account.differentUserBody}</p>
            <div className="mt-3 rounded-xl bg-app-fg/5 px-3 py-3">
              <Summary label={ru.account.differentUserWillErase} summary={differentUser.local} />
            </div>

            {/* Основные действия — в нижней половине (инвариант 59), и стирание
                в два шага: пролистать не читая нельзя. */}
            <div className="mt-auto flex flex-col gap-3 pt-6">
              <button
                className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20"
                onClick={() => navigate(`/settings/export?return=${encodeURIComponent("/more/account")}`)}
              >
                {ru.account.differentUserExportFirst}
              </button>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 size-5"
                  checked={eraseUnderstood}
                  onChange={(event) => setEraseUnderstood(event.target.checked)}
                />
                <span>{ru.account.differentUserStep1}</span>
              </label>
              <button
                className="min-h-11 w-full rounded-lg bg-app-holiday py-3 text-sm font-semibold text-app-bg active:opacity-80 disabled:opacity-40"
                disabled={!eraseUnderstood || busy}
                onClick={() =>
                  void withBusy(async () => {
                    if (cloudGateway) await confirmDifferentUser(db, cloudGateway, __APP_VERSION__);
                  })
                }
              >
                {ru.account.differentUserConfirm}
              </button>
              {/* Из этого экрана обязан быть выход, не равный стиранию
                  (инвариант 54): человек мог войти не тем аккаунтом по ошибке.
                  Отмена — это выход из только что начатой сессии, и ни одной
                  строки она не трогает (инвариант 44). Кнопка стоит ниже
                  красной: под большим пальцем должно лежать безопасное. */}
              <button
                className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20 disabled:opacity-50"
                disabled={busy}
                onClick={() =>
                  void withBusy(async () => {
                    await signOut();
                    setEraseUnderstood(false);
                    await handleAccountChange(db, cloudGateway, null, __APP_VERSION__);
                  })
                }
              >
                {ru.account.differentUserCancel}
              </button>
              <p className="text-xs text-app-fg/30">{ru.account.differentUserCancelHint}</p>
            </div>
          </section>
        )}

        {phase === "choice_required" && choice && (
          <section className="flex min-h-0 flex-1 flex-col">
            <h2 className="text-sm font-semibold">{ru.account.choiceTitle}</h2>
            <p className="mt-2 text-xs text-app-fg/50">{ru.account.choiceBody}</p>
            <div className="mt-3 flex flex-col gap-2 rounded-xl bg-app-fg/5 px-3 py-3">
              <Summary label={ru.account.choiceLocal} summary={choice.local} />
              <Summary label={ru.account.choiceCloud} summary={choice.cloud} />
            </div>

            {/* Инвариант 47 и преамбула раздела 5: два режима, ни один не
                предвыбран. */}
            <div className="mt-auto flex flex-col gap-3 pt-6">
              <button
                className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20 disabled:opacity-50"
                disabled={busy}
                onClick={() =>
                  void withBusy(async () => {
                    if (cloudGateway) await completeFirstSignIn(db, cloudGateway, "merge");
                  })
                }
              >
                {ru.account.choiceMerge}
              </button>
              <p className="-mt-2 text-xs text-app-fg/30">{ru.account.choiceMergeHint}</p>
              <button
                className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20 disabled:opacity-50"
                disabled={busy}
                onClick={() => setReplaceConfirmOpen(true)}
              >
                {ru.account.choiceReplace}
              </button>
              <p className="-mt-2 text-xs text-app-fg/30">{ru.account.choiceReplaceHint}</p>
            </div>
          </section>
        )}

        {(phase === "signed_out" || phase === "idle" || phase === "syncing" || phase === "error") && (
          <section className="flex min-h-0 flex-1 flex-col">
            {account ? (
              <>
                <h2 className="text-sm font-semibold">
                  {ru.account.signedInAs} <span className="font-normal text-app-fg/60">{account.email}</span>
                </h2>
                <div className="mt-3 rounded-xl bg-app-fg/5 px-3 py-3 text-xs text-app-fg/60">
                  <p>
                    {phase === "syncing"
                      ? ru.account.statusSyncing
                      : lastSyncAt
                        ? `${ru.account.statusLast} ${new Date(lastSyncAt).toLocaleString("ru-RU")}`
                        : ru.account.statusNever}
                  </p>
                  {lastError && (
                    <p className="mt-1 text-app-fg/40">
                      {ru.account.statusError} {lastError}
                    </p>
                  )}
                </div>

                <div className="mt-auto flex flex-col gap-3 pt-6">
                  <button
                    className="min-h-11 w-full rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80 disabled:opacity-50"
                    disabled={busy || phase === "syncing"}
                    onClick={() => void withBusy(() => runSync(db, cloudGateway))}
                  >
                    {ru.account.syncNow}
                  </button>
                  <button
                    className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20 disabled:opacity-50"
                    disabled={busy}
                    onClick={() =>
                      void withBusy(async () => {
                        // Отказ провайдера мог случиться, пока сессия была жива,
                        // и на экране он тогда не виден. Не убрать его здесь —
                        // значит встретить человека после выхода сообщением о
                        // входе, которого он только что не делал.
                        useSyncStore.getState().set({ signInError: null });
                        await signOut();
                        await handleAccountChange(db, cloudGateway, null, __APP_VERSION__);
                      })
                    }
                  >
                    {ru.account.signOut}
                  </button>
                  <p className="text-xs text-app-fg/30">{ru.account.signOutHint}</p>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-sm font-semibold">{ru.account.signedOutTitle}</h2>
                <p className="mt-2 text-xs text-app-fg/50">{ru.account.signedOutBody}</p>

                <div className="mt-auto flex flex-col gap-3 pt-6">
                  <label className="flex flex-col gap-1 text-xs text-app-fg/50">
                    {ru.account.email}
                    <input
                      className="min-h-11 rounded-lg bg-app-fg/10 px-3 text-base text-app-fg"
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      autoCapitalize="none"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-app-fg/50">
                    {ru.account.password}
                    <input
                      className="min-h-11 rounded-lg bg-app-fg/10 px-3 text-base text-app-fg"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  {/* Место под ошибку зарезервировано: появляясь, она иначе
                      сдвигала бы кнопки под пальцем. */}
                  <p className={`min-h-8 text-xs ${fieldError ? "text-app-fg/70" : "text-transparent"}`}>
                    {fieldError ?? "—"}
                  </p>
                  <button
                    className="min-h-11 w-full rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void submit("in")}
                  >
                    {ru.account.signIn}
                  </button>
                  <button
                    className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void submit("up")}
                  >
                    {ru.account.signUp}
                  </button>
                  <button
                    className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void startGoogle()}
                  >
                    {ru.account.signInGoogle}
                  </button>
                  {/* Отказ провайдера — словами рядом с кнопкой, а не модалкой
                      и не молчанием (инварианты 54 и 58). Место под него не
                      резервируется: сообщение появляется на запуске приложения
                      после возврата, а не под уже занесённым пальцем. */}
                  {signInError && (
                    <p className="text-xs text-app-fg/70" role="status">
                      {errorText(signInError)}
                    </p>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </div>

      {replaceConfirmOpen && (
        <div
          className="day-sheet-overlay fixed inset-0 z-40 flex items-center justify-center bg-app-scrim/60 p-6"
          onClick={() => setReplaceConfirmOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-app-surface p-4 text-app-fg"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-base font-semibold">{ru.account.choiceReplaceConfirmTitle}</p>
            <p className="mt-2 text-sm text-app-fg/50">{ru.account.choiceReplaceConfirmBody}</p>
            <div className="mt-4 flex gap-3">
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20"
                onClick={() => setReplaceConfirmOpen(false)}
              >
                {ru.account.cancel}
              </button>
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80"
                onClick={() => {
                  setReplaceConfirmOpen(false);
                  void withBusy(async () => {
                    if (cloudGateway) await completeFirstSignIn(db, cloudGateway, "replace");
                  });
                }}
              >
                {ru.account.choiceReplaceConfirmAction}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
