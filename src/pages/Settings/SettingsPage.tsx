import { ru } from "@/i18n/ru";

export function SettingsPage() {
  return (
    <div className="min-h-dvh bg-app-bg p-4 text-white">
      <p className="text-xs text-white/40">
        {ru.settings.version} {__APP_VERSION__}
      </p>
    </div>
  );
}
