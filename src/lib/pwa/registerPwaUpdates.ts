import { registerSW } from "virtual:pwa-register";
import { usePwaStore } from "@/store/pwaStore";

export function registerPwaUpdates(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      usePwaStore.setState({ needsRefresh: true });
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;

      // A registered service worker doesn't check for updates on its own — without
      // this, a phone that's just resumed from the background could sit on a stale
      // build indefinitely, which is exactly what happened before this existed.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          void registration.update();
        }
      });
    },
  });

  usePwaStore.setState({ applyUpdate: () => updateSW(true) });
}
