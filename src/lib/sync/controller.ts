import type { TimeoDB } from "@/db/schema";
import {
  adoptAccount,
  isEmptySummary,
  summarizeAllLocalData,
  fetchCloudSnapshot,
  summarizeBackup,
  summarizeLocalData,
  wipeLocalData,
  type DataSummary,
} from "@/db/account";
import { getCloudUserId, getLocalUserId, setCloudUserId } from "@/db/localUser";
import { readSyncMeta } from "@/db/syncMeta";
import { bootstrapUser } from "@/db/bootstrap";
import { syncOnce } from "@/lib/sync/engine";
import type { CloudGateway } from "@/lib/sync/types";
import type { AuthAccount } from "@/lib/sync/auth";
import type { ImportMode } from "@/lib/export/importPlan";
import { refreshActiveUserId } from "@/store/userStore";
import { useSyncStore } from "@/store/syncStore";
import type { BackupFile } from "@/lib/export/backup";
import {ru} from "@/i18n/ru.ts";

/**
 * Очередь из одной операции. Восстановленная сессия и событие onAuthStateChange
 * приходят почти одновременно, а таймер переднего плана — поверх них; два
 * первых входа подряд означали бы два переезда данных сразу.
 */
let queue: Promise<void> = Promise.resolve();

function serialize(work: () => Promise<void>): Promise<void> {
  const next = queue.then(work, work);
  // Ошибка не должна оборвать очередь: следующий вызов обязан выполниться.
  queue = next.catch(() => {});
  return next;
}

/**
 * «Значимые» данные — периоды и записи, то есть то, чего человек не получит
 * заново сам собой. Типы дня, настройки и праздники создаются посевом при
 * первом запуске на любом устройстве, и спрашивать «что оставить» из-за них
 * значило бы задавать вопрос на чистой установке, где терять нечего.
 */
function isMeaningful(summary: DataSummary): boolean {
  return summary.periods > 0 || summary.entries > 0;
}

function snapshotSummary(snapshot: BackupFile): DataSummary {
  return summarizeBackup(snapshot);
}

async function finishAdoption(
  db: TimeoDB,
  gateway: CloudGateway,
  account: AuthAccount,
  snapshot: BackupFile | null,
  mode: ImportMode | null,
): Promise<void> {
  await adoptAccount(db, {
    localUserId: getLocalUserId(),
    cloudUserId: account.userId,
    snapshot,
    mode,
  });
  setCloudUserId(account.userId);
  refreshActiveUserId();
  // Замена всего могла унести и строку настроек, и типы дня (если в облаке их
  // не было вовсе) — приложение без них не работает.
  await bootstrapUser(db, account.userId);
  useSyncStore.getState().set({ choice: null, phase: "idle", account });
  await syncNow(db, gateway);
}

/**
 * Что делать с вошедшим (или вышедшим) аккаунтом. Единственное место, где
 * принимается решение «это тот же человек, другой человек или первый вход».
 */
export function handleAccountChange(
  db: TimeoDB,
  gateway: CloudGateway | null,
  account: AuthAccount | null,
  appVersion: string,
): Promise<void> {
  return serialize(() => accountChanged(db, gateway, account, appVersion));
}

async function accountChanged(
  db: TimeoDB,
  gateway: CloudGateway | null,
  account: AuthAccount | null,
  appVersion: string,
): Promise<void> {
  const store = useSyncStore.getState();

  if (!gateway) {
    store.set({ phase: "disabled", account: null });
    return;
  }

  if (!account) {
    // Инвариант 44: выход не трогает ни одной строки. Активный user_id тоже
    // остаётся облачным — иначе после выхода появилась бы вторая копия тех же
    // месяцев под анонимным идентификатором.
    store.set({ phase: "signed_out", account: null, choice: null, differentUser: null });
    return;
  }

  const known = getCloudUserId();

  if (known === account.userId) {
    const meta = await readSyncMeta(db, account.userId);
    store.set({ phase: "idle", account, lastSyncAt: meta.last_sync_at, lastError: meta.last_error });
    await syncNow(db, gateway);
    return;
  }

  if (known && known !== account.userId) {
    // Считаем ВСЮ базу, а не только строки прошлого аккаунта: стирание уносит
    // и то, что осталось под анонимным идентификатором.
    const local = await summarizeAllLocalData(db);
    if (isEmptySummary(local)) {
      // Стирать нечего — предупреждать не о чем: инвариант 44 защищает данные,
      // а не требует вопроса там, где ответ ничего не меняет. Базу всё равно
      // чистим: в ней могли остаться мягко удалённые строки прошлого аккаунта,
      // которые новому не принадлежат и не видны ни одному запросу.
      await wipeLocalData(db);
      await finishAdoptionFromCloud(db, gateway, account, appVersion);
      return;
    }
    store.set({ phase: "different_user", account, differentUser: { account, local } });
    return;
  }

  await finishAdoptionFromCloud(db, gateway, account, appVersion);
}

/** Первый вход на этом устройстве: решаем, спрашивать ли, и если нет — переезжаем. */
async function finishAdoptionFromCloud(
  db: TimeoDB,
  gateway: CloudGateway,
  account: AuthAccount,
  appVersion: string,
): Promise<void> {
  const localUserId = getLocalUserId();
  const local = await summarizeLocalData(db, localUserId);
  const snapshot = await fetchCloudSnapshot(gateway, account.userId, appVersion);
  const cloud = snapshotSummary(snapshot);

  if (isMeaningful(local) && isMeaningful(cloud)) {
    // Преамбула раздела 5 и инвариант 47: молчаливого слияния не бывает.
    useSyncStore.getState().set({ phase: "choice_required", account, choice: { account, snapshot, cloud, local } });
    return;
  }

  if (!isMeaningful(local) && (cloud.periods > 0 || cloud.entries > 0 || cloud.day_types > 0)) {
    // Локально только посев первого запуска — терять нечего, и облачная копия
    // становится этим устройством целиком.
    await finishAdoption(db, gateway, account, snapshot, "replace");
    return;
  }

  await finishAdoption(db, gateway, account, null, null);
}

/** Ответ человека на вопрос первого входа. */
export function completeFirstSignIn(db: TimeoDB, gateway: CloudGateway, mode: ImportMode): Promise<void> {
  return serialize(async () => {
    const { choice } = useSyncStore.getState();
    if (!choice) return;
    await finishAdoption(db, gateway, choice.account, choice.snapshot, mode);
  });
}

/**
 * Инвариант 44: подтверждённый вход другим пользователем. Локальная база
 * стирается целиком, и только здесь — экран до этого показал числами, что
 * именно исчезнет.
 */
export function confirmDifferentUser(db: TimeoDB, gateway: CloudGateway, appVersion: string): Promise<void> {
  return serialize(async () => {
    const { differentUser } = useSyncStore.getState();
    if (!differentUser) return;

    await wipeLocalData(db);
    setCloudUserId(differentUser.account.userId);
    refreshActiveUserId();
    await bootstrapUser(db, differentUser.account.userId);
    useSyncStore.getState().set({ differentUser: null, phase: "idle" });
    await accountChanged(db, gateway, differentUser.account, appVersion);
  });
}

/**
 * Фоновая синхронизация. Экран её не ждёт никогда (инварианты 39 и 40): любая
 * ошибка оседает в состоянии и на экране аккаунта, а не в спиннере поверх
 * календаря.
 */
export function runSync(db: TimeoDB, gateway: CloudGateway | null): Promise<void> {
  return serialize(() => syncNow(db, gateway));
}

async function syncNow(db: TimeoDB, gateway: CloudGateway | null): Promise<void> {
  const store = useSyncStore.getState();
  const { phase, account } = store;
  if (!gateway || !account) return;
  if (phase === "choice_required" || phase === "different_user" || phase === "syncing") return;
  if (getCloudUserId() !== account.userId) return;

  store.set({ phase: "syncing" });
  try {
    await syncOnce(db, account.userId, gateway);
    const meta = await readSyncMeta(db, account.userId);
    useSyncStore.getState().set({ phase: "idle", lastSyncAt: meta.last_sync_at, lastError: null });
  } catch (error) {
    console.error("Timeo sync failed", error);

    useSyncStore.getState().set({
      phase: "error",
      lastError: ru.error.syncFailed,
    });
  }
}
