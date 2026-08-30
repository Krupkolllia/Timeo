import { createBrowserRouter } from "react-router-dom";
import { RouteErrorPanel } from "@/components/ErrorPanel";
import { CalendarPage } from "@/pages/Calendar/CalendarPage";
import { PeriodSummaryPage } from "@/pages/PeriodSummary/PeriodSummaryPage";
import { SettingsPage } from "@/pages/Settings/SettingsPage";
import { DayTypesPage } from "@/pages/DayTypes/DayTypesPage";
import { HolidaysPage } from "@/pages/Holidays/HolidaysPage";
import { PastPeriodsPage } from "@/pages/PastPeriods/PastPeriodsPage";
import { ExportRestorePage } from "@/pages/ExportRestore/ExportRestorePage";
import { MorePage } from "@/pages/More/MorePage";

// Инвариант 58: у каждого маршрута свой errorElement. Без него react-router
// показывает собственную страницу «Unexpected Application Error!» — белый фон,
// английский текст, обращение к разработчику и никакой кнопки перезагрузки.
// Именно это увидел бы пользователь на телефоне вместо приложения.
const routes = [
  { path: "/", element: <CalendarPage /> },
  { path: "/period", element: <PeriodSummaryPage /> },
  { path: "/settings", element: <SettingsPage /> },
  { path: "/settings/day-types", element: <DayTypesPage /> },
  { path: "/settings/holidays", element: <HolidaysPage /> },
  { path: "/settings/past-periods", element: <PastPeriodsPage /> },
  { path: "/settings/export", element: <ExportRestorePage /> },
  { path: "/more", element: <MorePage /> },
  // Несуществующий адрес — тоже ошибка маршрутизации, и она обязана выглядеть
  // как ошибка приложения, а не как страница фреймворка.
  { path: "*", element: <RouteErrorPanel /> },
];

export const router = createBrowserRouter(
  routes.map((route) => ({ ...route, errorElement: <RouteErrorPanel /> })),
);
