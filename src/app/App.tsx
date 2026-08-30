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
  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), [userId]);
  useTheme(settings?.theme);
  // Облако живёт в фоне: ни один экран его не ждёт (инварианты 39 и 40).
  useCloudSession();

  // Раньше жило только в CalendarPage, но с блоком 7 /period, /settings и
  // /more стали полноценными вкладками, а не экранами, куда можно попасть
  // только с уже загруженного календаря — холодный запуск PWA на любой из
  // них должен создать настройки и типы дня по умолчанию точно так же.
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
