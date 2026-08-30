import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { RouterProvider } from "react-router-dom";
import { router } from "@/app/routes";
import { useTheme } from "@/app/useTheme";
import { ErrorBoundary } from "@/components/ErrorPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { bootstrapUser } from "@/db/bootstrap";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";

const userId = getLocalUserId();

export function App() {
  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), []);
  useTheme(settings?.theme);

  // Раньше жило только в CalendarPage, но с блоком 7 /period, /settings и
  // /more стали полноценными вкладками, а не экранами, куда можно попасть
  // только с уже загруженного календаря — холодный запуск PWA на любой из
  // них должен создать настройки и типы дня по умолчанию точно так же.
  useEffect(() => {
    void bootstrapUser(db, userId);
  }, []);

  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
      <UpdateBanner />
    </ErrorBoundary>
  );
}
