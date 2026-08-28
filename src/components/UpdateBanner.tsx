import { usePwaStore } from "@/store/pwaStore";
import { ru } from "@/i18n/ru";

export function UpdateBanner() {
  const needsRefresh = usePwaStore((state) => state.needsRefresh);
  const applyUpdate = usePwaStore((state) => state.applyUpdate);

  if (!needsRefresh) return null;

  return (
    <button
      onClick={applyUpdate}
      className="fixed inset-x-0 bottom-0 z-50 bg-slate-800/95 px-4 py-2 text-center text-xs text-white backdrop-blur"
    >
      {ru.app.updateAvailable}
    </button>
  );
}
