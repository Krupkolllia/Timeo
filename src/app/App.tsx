import { RouterProvider } from "react-router-dom";
import { router } from "@/app/routes";
import { UpdateBanner } from "@/components/UpdateBanner";

export function App() {
  return (
    <>
      <RouterProvider router={router} />
      <UpdateBanner />
    </>
  );
}
