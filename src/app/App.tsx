import { RouterProvider } from "react-router-dom";
import { router } from "@/app/routes";
import { ErrorBoundary } from "@/components/ErrorPanel";
import { UpdateBanner } from "@/components/UpdateBanner";

export function App() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
      <UpdateBanner />
    </ErrorBoundary>
  );
}
