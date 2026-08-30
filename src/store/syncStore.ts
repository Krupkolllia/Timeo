import { create } from "zustand";
import type { AuthAccount, AuthErrorCode } from "@/lib/sync/auth";
import type { DataSummary } from "@/db/account";
import type { BackupFile } from "@/lib/export/backup";
import { isCloudConfigured } from "@/lib/sync/auth";

/**
 * Состояние облака человеческими словами — ровно то, что экран аккаунта
 * показывает вместо технических кодов (раздел 12: диагностика идёт по
 * скриншоту, другого канала нет).
 */
export type SyncPhase =
  /** Переменных окружения нет — сборка вообще без облака (инвариант 39). */
  | "disabled"
  | "signed_out"
  /** Вошли, но в облаке уже есть данные и человек ещё не выбрал, что оставить. */
  | "choice_required"
  /** Вошли под другим аккаунтом при непустой базе (инвариант 44). */
  | "different_user"
  | "idle"
  | "syncing"
  | "error";

export interface FirstSignInChoice {
  account: AuthAccount;
  snapshot: BackupFile;
  cloud: DataSummary;
  local: DataSummary;
}

export interface DifferentUserWarning {
  account: AuthAccount;
  /** Что именно будет стёрто — числами, а не «все данные». */
  local: DataSummary;
}

interface SyncState {
  phase: SyncPhase;
  account: AuthAccount | null;
  lastSyncAt: string | null;
  lastError: string | null;
  choice: FirstSignInChoice | null;
  differentUser: DifferentUserWarning | null;
  /**
   * Чем кончилась последняя попытка входа через провайдера. Живёт в store, а не
   * в экране: возврат разбирается на запуске приложения, а прочитать результат
   * должен экран аккаунта — возможно, открытый уже после этого.
   */
  signInError: AuthErrorCode | null;
  busy: boolean;
  set: (patch: Partial<Omit<SyncState, "set">>) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  // Не "disabled" по умолчанию: сессия восстанавливается асинхронно, и вкладка
  // «Ещё» на холодном старте успела бы сказать «облака в сборке нет» там, где
  // оно есть. На скриншоте с телефона это неотличимо от настоящей поломки.
  phase: isCloudConfigured() ? "signed_out" : "disabled",
  account: null,
  lastSyncAt: null,
  lastError: null,
  choice: null,
  differentUser: null,
  signInError: null,
  busy: false,
  set: (patch) => set(patch),
}));
