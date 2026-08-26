import { createBrowserRouter } from "react-router-dom";
import { CalendarPage } from "@/pages/Calendar/CalendarPage";
import { PeriodSummaryPage } from "@/pages/PeriodSummary/PeriodSummaryPage";
import { SettingsPage } from "@/pages/Settings/SettingsPage";
import { DayTypesPage } from "@/pages/DayTypes/DayTypesPage";
import { HolidaysPage } from "@/pages/Holidays/HolidaysPage";
import { PastPeriodsPage } from "@/pages/PastPeriods/PastPeriodsPage";
import { ExportRestorePage } from "@/pages/ExportRestore/ExportRestorePage";

export const router = createBrowserRouter([
  { path: "/", element: <CalendarPage /> },
  { path: "/period", element: <PeriodSummaryPage /> },
  { path: "/settings", element: <SettingsPage /> },
  { path: "/settings/day-types", element: <DayTypesPage /> },
  { path: "/settings/holidays", element: <HolidaysPage /> },
  { path: "/settings/past-periods", element: <PastPeriodsPage /> },
  { path: "/settings/export", element: <ExportRestorePage /> },
]);
