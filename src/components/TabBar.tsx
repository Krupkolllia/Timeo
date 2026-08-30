import { Calendar, CalendarRange, Settings, MoreHorizontal } from "lucide-react";
import { NavLink } from "react-router-dom";
import { ru } from "@/i18n/ru";

const tabs = [
  { to: "/", label: ru.nav.calendar, Icon: Calendar, end: true },
  { to: "/period", label: ru.nav.period, Icon: CalendarRange, end: true },
  { to: "/settings", label: ru.nav.settings, Icon: Settings, end: true },
  { to: "/more", label: ru.nav.more, Icon: MoreHorizontal, end: true },
] as const;

/**
 * Раздел 8.1: нижняя панель вкладок — Календарь · Период · Настройки · Ещё.
 * Панель рендерят сами четыре верхних экрана (см. TabBar.tsx использование),
 * а не общий layout-маршрут: тесты рендерят страницы напрямую в
 * MemoryRouter, и вложенный маршрут потребовал бы createMemoryRouter,
 * который в jsdom спотыкается об AbortSignal.
 */
export function TabBar() {
  return (
    <nav
      aria-label={ru.nav.calendar + " · " + ru.nav.period + " · " + ru.nav.settings + " · " + ru.nav.more}
      className="fixed inset-x-0 bottom-0 z-20 flex border-t border-app-fg/10 bg-app-bg/95 backdrop-blur"
      style={{ height: "var(--tabbar-h)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {tabs.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${
              isActive ? "text-app-accent-text" : "text-app-fg/50"
            }`
          }
        >
          <Icon size={22} strokeWidth={2} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
