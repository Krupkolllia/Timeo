import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { updateSettings } from "@/db/settings";
import { ru } from "@/i18n/ru";

const userId = getLocalUserId();

export function SettingsPage() {
  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), []);

  return (
    <div className="min-h-dvh bg-app-bg p-4 text-white">
      {/*
       * Раздел 6.5 ТЗ. Экрана настроек (блок 7) ещё нет — эта единственная
       * настройка временно живёт на заглушке, как раньше settings.show_shift_times
       * жил в модели без своего переключателя до появления кнопки в шторке дня.
       */}
      {settings && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm">{ru.settings.totalHoursPaidOnlyToggle}</p>
            <p className="mt-1 text-xs text-white/40">{ru.settings.totalHoursPaidOnlyHint}</p>
          </div>
          <button
            role="switch"
            aria-checked={settings.total_hours_paid_only}
            aria-label={ru.settings.totalHoursPaidOnlyToggle}
            onClick={() =>
              void updateSettings(db, settings.id, { total_hours_paid_only: !settings.total_hours_paid_only })
            }
            className="-my-2 flex h-11 w-11 shrink-0 items-center justify-end"
          >
            <span
              className={`relative block h-6 w-11 rounded-full transition-colors ${
                settings.total_hours_paid_only ? "bg-app-accent" : "bg-white/20"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-[left] ${
                  settings.total_hours_paid_only ? "left-[22px]" : "left-0.5"
                }`}
              />
            </span>
          </button>
        </div>
      )}
      <p className="text-xs text-white/40">
        {ru.settings.version} {__APP_VERSION__}
      </p>
    </div>
  );
}
