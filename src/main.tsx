import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { registerPwaUpdates } from "@/lib/pwa/registerPwaUpdates";
import "@/styles/index.css";

registerPwaUpdates();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
