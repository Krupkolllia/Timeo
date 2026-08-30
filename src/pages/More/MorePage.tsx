import { useNavigate } from "react-router-dom";
import { TabBar } from "@/components/TabBar";
import { ru } from "@/i18n/ru";

/**
 * Раздел 8.4, часть 4: данные и мета — то, что не «правило», а действие или
 * информация о самом приложении. Настройки (правила) живут отдельно на
 * /settings. Вход в экспорт и прошлые периоды дублирует экран периода —
 * решение согласовано, оба пути должны оставаться рабочими.
 */
export function MorePage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-dvh bg-app-bg p-4 text-app-fg" style={{ paddingBottom: "calc(var(--tabbar-h) + 1rem)" }}>
      <h1 className="pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-4 text-lg font-semibold tracking-tight">
        {ru.more.title}
      </h1>

      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs text-app-fg/50">{ru.more.dataSection}</p>
          <div className="mt-2 flex flex-col gap-2">
            <button
              className="min-h-11 rounded-lg bg-app-fg/5 px-3 py-3 text-left text-sm active:bg-app-fg/10"
              onClick={() => navigate(`/settings/past-periods?return=${encodeURIComponent("/more")}`)}
            >
              {ru.more.pastPeriods}
            </button>
            <button
              className="min-h-11 rounded-lg bg-app-fg/5 px-3 py-3 text-left text-sm active:bg-app-fg/10"
              onClick={() => navigate(`/settings/export?return=${encodeURIComponent("/more")}`)}
            >
              {ru.more.exportRestore}
            </button>
          </div>
        </div>

        <div>
          <p className="text-xs text-app-fg/50">{ru.more.aboutSection}</p>
          <div className="mt-2 rounded-lg bg-app-fg/5 px-3 py-3">
            {/* Раздел 12: тестирование идёт удалённо по скриншотам, и по этой
                строке скриншот вообще опознаётся — крупно и выделяемо. */}
            <p className="select-text text-base font-medium">
              {ru.more.version} {__APP_VERSION__}
              {__BUILD_SHA__ && ` · ${__BUILD_SHA__}`}
            </p>
          </div>
        </div>

        {/* Место под аккаунт (блок 8) — место, а не заглушка-кнопка: аккаунта
            до блока 8 нет, и пустой пункт меню читался бы как поломка. */}
        <p className="text-xs text-app-fg/40">{ru.more.accountPlaceholder}</p>
      </div>

      <TabBar />
    </div>
  );
}
