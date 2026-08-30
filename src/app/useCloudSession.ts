import { useEffect } from "react";
import { db } from "@/db/db";
import { completeOAuthReturn, currentAccount, onAuthChange } from "@/lib/sync/auth";
import { cloudGateway } from "@/lib/sync/cloud";
import { handleAccountChange, runSync } from "@/lib/sync/controller";
import { useSyncStore } from "@/store/syncStore";

/** Как часто приложение на переднем плане проверяет, не появилось ли что выгрузить. */
export const FOREGROUND_SYNC_INTERVAL_MS = 60_000;

/**
 * Разбор возврата не имеет права оборвать запуск облака: что бы ни случилось с
 * адресом, сессию всё равно спрашиваем и синхронизацию всё равно заводим.
 */
async function settleOAuthReturn(): Promise<void> {
  try {
    const returned = await completeOAuthReturn();
    if (returned.kind === "none") return;
    useSyncStore.getState().set({ signInError: returned.kind === "failed" ? returned.code : null });
  } catch {
    useSyncStore.getState().set({ signInError: "oauth_failed" });
  }
}

/**
 * Фоновая жизнь облака: возврат от провайдера, восстановленная сессия, вход и
 * выход, возврат в приложение, появление сети.
 *
 * Ни одно из этих событий не задерживает отрисовку: хук ничего не возвращает,
 * экраны читают Dexie и не знают о нём вовсе (инварианты 39 и 40).
 */
export function useCloudSession(): void {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Возврат от провайдера разбирается до вопроса о сессии: обмен кода её и
      // создаёт. Разбор происходит на любом адресе — если Redirect URLs в
      // Supabase окажутся неполными, человек вернётся на календарь, и код
      // обязан исчезнуть из адреса там же.
      await settleOAuthReturn();
      const account = await currentAccount();
      if (!cancelled) await handleAccountChange(db, cloudGateway, account, __APP_VERSION__);
    })();

    const unsubscribe = onAuthChange((account) => {
      void handleAccountChange(db, cloudGateway, account, __APP_VERSION__);
    });

    const sync = () => void runSync(db, cloudGateway);
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", sync);
    // Локальные правки не уведомляют о себе: экраны пишут в Dexie напрямую и
    // ничего не знают про облако. Периодическая проверка на переднем плане —
    // цена этой независимости, и она же страховка от пропущенного события.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") sync();
    }, FOREGROUND_SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", sync);
      window.clearInterval(timer);
    };
  }, []);
}
