import { create } from "zustand";
import { getActiveUserId } from "@/db/localUser";

interface UserState {
  /**
   * Активный user_id — тот, по которому читает КАЖДЫЙ экран.
   *
   * До блока 8 идентификатор читался из localStorage константой на уровне
   * модуля в восьми файлах. После входа в аккаунт он меняется, а такие
   * константы не перечитываются до перезагрузки страницы: экран остался бы на
   * старом идентификаторе и показывал бы пусто — с телефона это неотличимо от
   * «данные пропали». Поэтому источник ровно один, и он подписной.
   */
  userId: string;
  setUserId: (userId: string) => void;
}

export const useUserStore = create<UserState>((set) => ({
  userId: getActiveUserId(),
  setUserId: (userId) => set({ userId }),
}));

/** Хук для экранов: подписка на активный идентификатор, а не снимок при загрузке модуля. */
export function useActiveUserId(): string {
  return useUserStore((state) => state.userId);
}

/** Перечитать идентификатор из хранилища — после входа, выхода или миграции. */
export function refreshActiveUserId(): string {
  const userId = getActiveUserId();
  useUserStore.getState().setUserId(userId);
  return userId;
}
