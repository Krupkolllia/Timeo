import { useLiveQuery } from "dexie-react-hooks";
import { RouterProvider } from "react-router-dom";
import { router } from "@/app/routes";
import { useTheme } from "@/app/useTheme";
import { ErrorBoundary } from "@/components/ErrorPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";

const userId = getLocalUserId();

export function App() {
  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), []);
  useTheme(settings?.theme);

  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
      <UpdateBanner />
    </ErrorBoundary>
  );
}
