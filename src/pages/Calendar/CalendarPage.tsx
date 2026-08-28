import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { bootstrapUser } from "@/db/bootstrap";
import { getOrCreatePeriod } from "@/db/periods";
import {
  calculatePeriodTotals,
  getAdjacentPeriod,
  getPeriodDateRange,
  getPeriodLabel,
  periodForDate,
  type PeriodId,
} from "@/lib/calc/period";
import { buildWeeks, toISODate } from "@/lib/calc/calendarGrid";
import { ru } from "@/i18n/ru";
import { MonthYearPicker } from "@/pages/Calendar/MonthYearPicker";
import { DayScreen } from "@/pages/DayScreen/DayScreen";

const userId = getLocalUserId();

export function CalendarPage() {
  const [viewed, setViewed] = useState<PeriodId | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openDayDate, setOpenDayDate] = useState<string | null>(null);

  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), []);

  useEffect(() => {
    void bootstrapUser(db, userId);
  }, []);

  // Период вычисляется из period_start_day настроек, поэтому ждём их загрузки.
  useEffect(() => {
    if (settings && viewed === null) {
      setViewed(periodForDate(new Date(), settings.period_start_day));
    }
  }, [settings, viewed]);

  const range = useMemo(
    () => (viewed && settings ? getPeriodDateRange(viewed.year, viewed.month, settings.period_start_day) : null),
    [viewed, settings],
  );

  useEffect(() => {
    if (!viewed || !settings) return;
    void getOrCreatePeriod(db, userId, viewed.year, viewed.month, settings);
    // Зависим от конкретных полей, а не от объекта settings целиком — иначе
    // любая несвязанная правка настроек (например, темы) меняет ссылку и
    // лишний раз перезапускает поиск/создание периода.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewed, settings?.default_base_rate, settings?.default_norm_hours]);

  const period = useLiveQuery(
    () =>
      viewed
        ? db.periods.where("[user_id+year+month]").equals([userId, viewed.year, viewed.month]).first()
        : undefined,
    [viewed],
  );

  // Архивные типы дней остаются в этой карте: они всё ещё могут быть проставлены
  // на прошлых днях, и итог периода должен продолжать считать их часы верно.
  // Фильтровать is_archived нужно только там, где пользователь выбирает тип дня.
  const dayTypes = useLiveQuery(() => db.day_types.where("user_id").equals(userId).sortBy("sort_order"), []);

  const entries = useLiveQuery(async () => {
    if (!range) return [];
    return db.entries
      .where("date")
      .between(toISODate(range.start), toISODate(range.end), true, true)
      .filter((entry) => entry.user_id === userId)
      .toArray();
  }, [range]);

  const dayTypeById = useMemo(() => new Map((dayTypes ?? []).map((dt) => [dt.id, dt])), [dayTypes]);
  const entryByDate = useMemo(() => new Map((entries ?? []).map((entry) => [entry.date, entry])), [entries]);

  const totals = useMemo(() => {
    if (!period) return null;
    return calculatePeriodTotals(period, entries ?? [], dayTypeById);
  }, [period, entries, dayTypeById]);

  if (!settings || !viewed || !range) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-app-bg text-white/50">
        {ru.calendar.loading}
      </div>
    );
  }

  const label = getPeriodLabel(viewed.year, viewed.month, settings.period_start_day, settings.period_naming);
  const weeks = buildWeeks(range.start, range.end);

  return (
    <div className="flex min-h-dvh flex-col bg-app-bg text-white">
      <header className="flex items-center justify-between px-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-2">
        <button
          className="rounded-full p-3 text-xl text-white/70 active:bg-white/10"
          onClick={() => setViewed(getAdjacentPeriod(viewed.year, viewed.month, -1))}
          aria-label={ru.calendar.prevPeriod}
        >
          ‹
        </button>
        <button className="text-lg font-semibold tracking-tight" onClick={() => setPickerOpen(true)}>
          {ru.calendar.monthNames[label.month - 1]} {label.year}
        </button>
        <button
          className="rounded-full p-3 text-xl text-white/70 active:bg-white/10"
          onClick={() => setViewed(getAdjacentPeriod(viewed.year, viewed.month, 1))}
          aria-label={ru.calendar.nextPeriod}
        >
          ›
        </button>
      </header>

      <div className="grid grid-cols-7 gap-1 px-2 text-center text-xs text-white/40">
        {ru.calendar.weekdayNamesShort.map((name) => (
          <div key={name} className="py-1">
            {name}
          </div>
        ))}
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 pb-32">
        {weeks.map((week) => (
          <div key={toISODate(week[0])} className="grid grid-cols-7 gap-1">
            {week.map((date) => {
              const iso = toISODate(date);
              const inPeriod = date >= range.start && date <= range.end;
              const entry = entryByDate.get(iso);
              const dayType = entry ? dayTypeById.get(entry.day_type_id) : undefined;
              const isWeekend = date.getDay() === 0 || date.getDay() === 6;

              return (
                <button
                  key={iso}
                  disabled={!inPeriod}
                  onClick={() => setOpenDayDate(iso)}
                  className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-lg text-sm ${
                    inPeriod ? "bg-white/5 active:bg-white/10" : "opacity-20"
                  } ${isWeekend && inPeriod ? "text-app-accent" : "text-white"}`}
                >
                  <span>{date.getDate()}</span>
                  {dayType && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dayType.color }} />}
                  {entry && entry.hours > 0 && <span className="text-[10px] text-white/50">{entry.hours}{ru.calendar.hoursShort}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-white/10 bg-app-bg/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 backdrop-blur">
        <div className="text-xs text-white/50">
          {ru.calendar.remainingToNorm}: {totals ? totals.remaining_to_norm : "—"} {ru.calendar.hoursShort}
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-2xl font-semibold">
            {(totals?.amount ?? 0).toFixed(2)} {settings.currency}
          </span>
          <span className="text-lg text-white/70">
            {totals?.total_hours ?? 0} {ru.calendar.hoursShort}
          </span>
        </div>
      </div>

      {pickerOpen && (
        <MonthYearPicker
          year={viewed.year}
          month={viewed.month}
          onSelect={(next) => {
            setViewed(next);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {openDayDate && (
        <div className="fixed inset-0 z-10 flex items-end bg-black/50" onClick={() => setOpenDayDate(null)}>
          <div className="w-full rounded-t-2xl bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
            <p className="text-sm text-white/50">{openDayDate}</p>
            <DayScreen />
          </div>
        </div>
      )}
    </div>
  );
}
