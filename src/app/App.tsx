import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { RouterProvider } from "react-router-dom";
import { router } from "@/app/routes";
import { useTheme } from "@/app/useTheme";
import { useCloudSession } from "@/app/useCloudSession";
import { ErrorBoundary } from "@/components/ErrorPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { bootstrapUser } from "@/db/bootstrap";
import { db } from "@/db/db";
import { useActiveUserId } from "@/store/userStore";

export function App() {
  const userId = useActiveUserId();

  const settings = useLiveQuery(
      () =>
          db.settings
          .where("user_id")
          .equals(userId)
          .first(),
      [userId],
  );

  useTheme(settings?.theme);

  // Облако живёт в фоне: ни один экран его не ждёт.
  useCloudSession();

  /**
   * Инициализация локальной базы нужна независимо от текущего маршрута:
   * /period, /settings и /more тоже должны стартовать с готовой локальной
   * базой.
   *
   * ВАЖНО:
   * bootstrapUser() сам защищает seed транзакциями, поэтому оставляем
   * существующий lifecycle приложения без изменений.
   */
  useEffect(() => {
    void bootstrapUser(db, userId);
  }, [userId]);

  return (
      <ErrorBoundary>
        <RouterProvider router={router} />
        <UpdateBanner />
      </ErrorBoundary>
  );
}