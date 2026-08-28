import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { bootstrapUser } from "@/db/bootstrap";
import { getOrCreatePeriod } from "@/db/periods";
import { listActiveEntriesForDate, restoreEntry } from "@/db/entries";
import type { Entry } from "@/types/models";
import {
  calculatePeriodTotals,
  getAdjacentPeriod,
  getPeriodDateRange,
  getPeriodIdentityFromLabel,
  getPeriodLabel,
  periodForDate,
  type PeriodId,
} from "@/lib/calc/period";
import { buildWeeks, toISODate } from "@/lib/calc/calendarGrid";
import { formatDayTitle } from "@/lib/format/date";
import { ru } from "@/i18n/ru";
import { MonthYearPicker } from "@/pages/Calendar/MonthYearPicker";
import { DayScreen } from "@/pages/DayScreen/DayScreen";

const userId = getLocalUserId();

export function CalendarPage() {
  const [viewed, setViewed] = useState<PeriodId | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openDayDate, setOpenDayDate] = useState<string | null>(null);
  // Плашка "отменить" живёт на уровне календаря, а не внутри bottom sheet:
  // удаление записи закрывает экран дня сразу, и окно отмены (раздел 8 ТЗ)
  // должно пережить это закрытие, а не исчезать вместе с диалогом.
  const [pendingUndo, setPendingUndo] = useState<Entry | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), []);

  useEffect(() => {
    void bootstrapUser(db, userId);
  }, []);

  // The period is computed from settings' period_start_day, so we wait for it to load.
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
    // We depend on specific fields rather than the whole settings object — otherwise
    // any unrelated settings edit (e.g. the theme) changes the reference and
    // needlessly re-triggers the period lookup/creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewed, settings?.default_base_rate, settings?.default_norm_hours]);

  const period = useLiveQuery(
    () =>
      viewed
        ? db.periods.where("[user_id+year+month]").equals([userId, viewed.year, viewed.month]).first()
        : undefined,
    [viewed],
  );

  // Archived day types stay in this map: they may still be assigned
  // on past days, and the period total must keep counting their hours correctly.
  // Filtering out is_archived is only needed where the user picks a day type.
  const dayTypes = useLiveQuery(() => db.day_types.where("user_id").equals(userId).sortBy("sort_order"), []);

  const entries = useLiveQuery(async () => {
    if (!range) return [];
    return db.entries
      .where("date")
      .between(toISODate(range.start), toISODate(range.end), true, true)
      .filter((entry) => entry.user_id === userId && entry.deleted_at === null)
      .toArray();
  }, [range]);

  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    };
  }, []);

  function handleEntryDeleted(entry: Entry) {
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setPendingUndo(entry);
    undoTimeoutRef.current = setTimeout(() => setPendingUndo(null), 5000);
  }

  async function handleUndoDelete() {
    if (!pendingUndo) return;
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    // Пока была открыта плашка "отменить", пользователь мог зайти на тот же
    // день и создать новую запись поверх удалённой. В этом узком случае не
    // восстанавливаем старую — иначе на дату окажется две активные записи, и
    // calculatePeriodTotals задвоит сумму/часы за день. Компромисс: удалённая
    // запись остаётся удалённой, а свежесозданная — единственный источник
    // истины за эту дату.
    const alreadyReplaced = (await listActiveEntriesForDate(db, pendingUndo.user_id, pendingUndo.date)).length > 0;
    if (!alreadyReplaced) {
      await restoreEntry(db, pendingUndo.id);
    }
    setPendingUndo(null);
  }

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

        {/* Временный индикатор сборки: тестирование идёт удалённо (раздел 12 ТЗ), и без него
            неотличимо «баг не исправлен» от «на телефоне закешировалась старая версия».
            Переехать в экран настроек (раздел 7.4), когда тот появится в блоке 6. */}
        <p className="mt-auto pt-4 text-center text-[10px] text-white/25">
          v{__APP_VERSION__}{__BUILD_SHA__ && ` · ${__BUILD_SHA__}`}
        </p>
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
          year={label.year}
          month={label.month}
          onSelect={(next) => {
            setViewed(getPeriodIdentityFromLabel(next.year, next.month, settings.period_start_day, settings.period_naming));
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {openDayDate && period && dayTypes && (
        <div className="fixed inset-0 z-10 flex items-end bg-black/50" onClick={() => setOpenDayDate(null)}>
          <div className="w-full rounded-t-2xl bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
            <p className="mb-2 text-sm text-white/50">{formatDayTitle(openDayDate)}</p>
            <DayScreen
              date={openDayDate}
              userId={userId}
              dayTypes={dayTypes}
              period={period}
              settings={settings}
              onClose={() => setOpenDayDate(null)}
              onEntryDeleted={handleEntryDeleted}
            />
          </div>
        </div>
      )}

      {pendingUndo && (
        <div className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-30 flex items-center justify-between rounded-xl bg-slate-800 px-4 py-3 shadow-lg">
          <span className="text-sm">{ru.day.deletedNotice}</span>
          <button className="text-sm font-semibold text-app-accent" onClick={handleUndoDelete}>
            {ru.day.undo}
          </button>
        </div>
      )}
    </div>
  );
}
