import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useSearchParams } from "react-router-dom";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { bootstrapUser } from "@/db/bootstrap";
import { findLivePeriodQuery, getOrCreatePeriod } from "@/db/periods";
import { restoreEntry } from "@/db/entries";
import type { Entry, Holiday } from "@/types/models";
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
import { buildHolidayByDate } from "@/lib/calc/holidays";
import { roundHours, roundMoney } from "@/lib/calc/round";
import { formatDayTitle } from "@/lib/format/date";
import { ru } from "@/i18n/ru";
import { MonthYearPicker } from "@/pages/Calendar/MonthYearPicker";
import { DayScreen } from "@/pages/DayScreen/DayScreen";

const userId = getLocalUserId();

// Стабильная ссылка: пустая карта, созданная на месте, меняла бы зависимость
// каждый рендер.
const EMPTY_HOLIDAYS: ReadonlyMap<string, Holiday> = new Map();

export function CalendarPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [viewed, setViewed] = useState<PeriodId | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // ?day= открывает шторку сразу: экран типов дня (раздел 8.2 — плюс в ряду
  // типов) уводит с календаря целиком, и без этого возврат высаживал бы
  // пользователя на пустой календарь вместо дня, ради которого он уходил.
  // Формат проверяем: адрес приходит извне, а строка неизвестного вида ушла бы
  // прямиком в запрос по дате.
  const [openDayDate, setOpenDayDate] = useState<string | null>(() => {
    const day = searchParams.get("day");
    return day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  });
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
  //
  // Отсчёт идёт от открытого дня, если он пришёл в адресе, и только иначе от
  // сегодняшнего. Возврат из экрана типов дня на /?day= монтирует календарь
  // заново: без этой связи openDayDate вставал на 15 июля, а viewed — на
  // сегодняшний август, и шторка получала июльскую дату с августовским
  // периодом. Дальше любая правка писала июльскую запись по августовской
  // базовой ставке — молчаливое нарушение изоляции периодов (инвариант 1) на
  // том самом пути, ради которого вход через «+» и добавлен.
  useEffect(() => {
    if (settings && viewed === null) {
      // Дату разбираем вручную: new Date("2026-07-15") — это UTC-полночь
      // (инвариант 27).
      const [y, m, d] = openDayDate?.split("-").map(Number) ?? [];
      const anchor = y && m && d ? new Date(y, m - 1, d) : new Date();
      setViewed(periodForDate(anchor, settings.period_start_day));
    }
  }, [settings, viewed, openDayDate]);

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
      viewed ? findLivePeriodQuery(db, userId, viewed.year, viewed.month).first() : undefined,
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

  // Раздел 8.1: «выходные и праздники визуально отличаются». Сетка шире
  // периода — она дополняется днями соседних месяцев до целых недель, — и
  // запрашивать праздники надо ровно по ней, иначе крайние ячейки красились бы
  // непоследовательно.
  const gridRange = useMemo(() => {
    if (!range) return null;
    const weeks = buildWeeks(range.start, range.end);
    return { start: toISODate(weeks[0][0]), end: toISODate(weeks[weeks.length - 1][6]) };
  }, [range]);

  // Ответ несёт границы, для которых он получен: useLiveQuery СОХРАНЯЕТ прежний
  // результат, пока перезапускается после смены зависимости, и на кадр после
  // перелистывания месяца календарь красил бы праздники прошлого периода.
  const holidayResult = useLiveQuery(async () => {
    if (!gridRange) return null;
    const rows = await db.holidays
      .where("date")
      .between(gridRange.start, gridRange.end, true, true)
      .filter((holiday) => holiday.user_id === userId && holiday.deleted_at === null)
      .toArray();
    return { start: gridRange.start, end: gridRange.end, byDate: buildHolidayByDate(rows) };
  }, [gridRange]);

  const holidayByDate = useMemo(
    () =>
      gridRange && holidayResult && holidayResult.start === gridRange.start && holidayResult.end === gridRange.end
        ? holidayResult.byDate
        : EMPTY_HOLIDAYS,
    [gridRange, holidayResult],
  );

  // Предыдущий период — только для сравнения в панели итогов (раздел 7.1).
  // getOrCreatePeriod здесь намеренно не вызывается: он создаёт строку при
  // первом обращении (раздел 5.2), и календарь начал бы плодить пустые
  // периоды назад по времени просто от пролистывания.
  const previous = useMemo(() => (viewed ? getAdjacentPeriod(viewed.year, viewed.month, -1) : null), [viewed]);

  const previousPeriod = useLiveQuery(
    () =>
      previous ? findLivePeriodQuery(db, userId, previous.year, previous.month).first() : undefined,
    [previous],
  );

  const previousRange = useMemo(
    () => (previous && settings ? getPeriodDateRange(previous.year, previous.month, settings.period_start_day) : null),
    [previous, settings],
  );

  const previousEntries = useLiveQuery(async () => {
    if (!previousRange) return [];
    return db.entries
      .where("date")
      .between(toISODate(previousRange.start), toISODate(previousRange.end), true, true)
      .filter((entry) => entry.user_id === userId && entry.deleted_at === null)
      .toArray();
  }, [previousRange]);

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
    // Раньше здесь стояла проверка «на дату уже появилась активная запись — не
    // восстанавливаем», чтобы не получить две строки за день. С поддержкой
    // нескольких записей (раздел 5.4) восстановление всегда безопасно.
    await restoreEntry(db, pendingUndo.id);
    setPendingUndo(null);
  }

  const dayTypeById = useMemo(() => new Map((dayTypes ?? []).map((dt) => [dt.id, dt])), [dayTypes]);
  // Раздел 5.4 допускает несколько записей на один день, поэтому дата
  // отображается в список: Map<string, Entry> терял все записи, кроме последней,
  // и ячейка расходилась с нижней панелью, которая суммирует их все.
  const entriesByDate = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const entry of entries ?? []) {
      const list = map.get(entry.date);
      if (list) list.push(entry);
      else map.set(entry.date, [entry]);
    }
    return map;
  }, [entries]);

  const totals = useMemo(() => {
    if (!period) return null;
    return calculatePeriodTotals(period, entries ?? [], dayTypeById);
  }, [period, entries, dayTypeById]);

  // Сравнение показываем только если предыдущий период реально существует:
  // «+0» на первом же месяце использования дезинформирует.
  const delta = useMemo(() => {
    if (!previousPeriod || !totals) return null;
    const previousTotals = calculatePeriodTotals(previousPeriod, previousEntries ?? [], dayTypeById);
    return roundMoney(totals.amount - previousTotals.amount);
  }, [previousPeriod, previousEntries, dayTypeById, totals]);

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
        {/* py-3 поднимает цель нажатия до 44px: это вход в выбор месяца и года,
            а сам текст ростом всего 28px (инвариант 59). */}
        <button className="px-2 py-3 text-lg font-semibold tracking-tight" onClick={() => setPickerOpen(true)}>
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
              const dayEntries = entriesByDate.get(iso) ?? [];
              const dayHours = roundHours(dayEntries.reduce((sum, e) => sum + e.hours, 0));
              const isWeekend = date.getDay() === 0 || date.getDay() === 6;
              const holiday = holidayByDate.get(iso);

              return (
                <button
                  key={iso}
                  disabled={!inPeriod}
                  // Доступное имя ячейки — читаемая дата: в сетке два «31»
                  // (конец прошлого месяца и конец этого), и одно голое число
                  // не отличает их ни для скринридера, ни для теста. Праздник
                  // добавляется сюда же: на экране он виден цветом, а цвет —
                  // единственное, чего не существует ни для скринридера, ни
                  // для теста.
                  aria-label={holiday ? `${formatDayTitle(iso)}, ${holiday.name}` : formatDayTitle(iso)}
                  onClick={() => setOpenDayDate(iso)}
                  // Раздел 8.1: праздник отличается и от будня, и от выходного.
                  // Выходной — жёлтый текст, поэтому праздник берёт розовый плюс
                  // обводку: воскресный праздник иначе неотличим от обычного
                  // воскресенья, а именно в нём другой множитель.
                  className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-lg text-sm ${
                    inPeriod ? "bg-white/5 active:bg-white/10" : "opacity-20"
                  } ${holiday && inPeriod ? "ring-1 ring-app-holiday/50" : ""} ${
                    holiday && inPeriod
                      ? "text-app-holiday"
                      : isWeekend && inPeriod
                        ? "text-app-accent"
                        : "text-white"
                  }`}
                >
                  <span>{date.getDate()}</span>
                  {/* Не больше трёх точек: ячейка 50px шириной, три точки по 6px
                      с зазорами укладываются в 22px. */}
                  {dayEntries.length > 0 && (
                    <span className="flex gap-0.5">
                      {dayEntries.slice(0, 3).map((e) => (
                        <span
                          key={e.id}
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: dayTypeById.get(e.day_type_id)?.color }}
                        />
                      ))}
                    </span>
                  )}
                  {dayHours > 0 && (
                    // max-w-full + truncate: ячейка шириной 50px, и число часов
                    // в несколько цифр иначе вылезает на соседние дни
                    // (инвариант 26 — большие значения не ломают вёрстку).
                    <span className="max-w-full truncate text-[10px] text-white/50">
                      {dayHours}
                      {ru.calendar.hoursShort}
                    </span>
                  )}
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

      {/* Раздел 8.1: «тап разворачивает полную расшифровку». Панель целиком —
          кнопка, а не отдельная стрелка: это самая большая цель на экране, и
          попасть по ней большим пальцем можно не глядя (инвариант 59). */}
      <button
        type="button"
        onClick={() => navigate(`/period?year=${viewed.year}&month=${viewed.month}`)}
        aria-label={ru.period.openSummary}
        className="fixed inset-x-0 bottom-0 z-20 border-t border-white/10 bg-app-bg/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 text-left backdrop-blur active:bg-white/5"
      >
        {/* Раздел 7.1: «строкой выше мелко: сравнение с прошлым периодом
            (например «+340 zł») и остаток до нормы часов». Знак берётся из
            значения, отдельного ключа в словаре ТЗ не предполагает. */}
        <div className="flex items-baseline gap-3 text-xs text-white/50">
          {delta !== null && (
            <span>
              {delta >= 0 ? "+" : "−"}
              {Math.abs(delta).toFixed(2)} {settings.currency}
            </span>
          )}
          <span>
            {ru.calendar.remainingToNorm}: {totals ? totals.remaining_to_norm : "—"} {ru.calendar.hoursShort}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-2xl font-semibold">
            {(totals?.amount ?? 0).toFixed(2)} {settings.currency}
          </span>
          <span className="text-lg text-white/70">
            {totals?.total_hours ?? 0} {ru.calendar.hoursShort}
          </span>
        </div>
      </button>

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
        <div
          // z-30 — выше панели итогов (z-20). Слои на календаре: панель итогов
          // 20, шторка дня и выбор месяца 30, плашка отмены 40. При z-10
          // панель итогов накрывала нижние 44px шторки, то есть кнопку
          // «Закрыть» целиком: нажатие уходило в панель и вместо закрытия
          // открывало расшифровку периода.
          className="day-sheet-overlay fixed inset-0 z-30 flex items-end bg-black/50"
          onClick={() => setOpenDayDate(null)}
        >
          {/* Лимит высоты (85dvh) и анимация появления живут в .day-sheet — на
              всей панели, а не на внутреннем скроллере DayScreen: ручка, дата
              и p-4 обёртки шли сверх лимита и панель занимала 94% экрана. */}
          <div className="day-sheet flex w-full flex-col rounded-t-2xl bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
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
              onOpenPeriod={() => navigate(`/period?year=${viewed.year}&month=${viewed.month}`)}
              onCreateDayType={() =>
                navigate(`/settings/day-types?new=1&return=${encodeURIComponent(`/?day=${openDayDate}`)}`)
              }
              // Раздел 8.6. return= возвращает ровно в тот день, ради которого
              // пользователь ушёл, — тот же приём, что и у плюса типов дня.
              onOpenHolidays={({ addDate }) =>
                navigate(
                  `/settings/holidays?${addDate ? `add=${addDate}&` : ""}return=${encodeURIComponent(`/?day=${openDayDate}`)}`,
                )
              }
            />
          </div>
        </div>
      )}

      {/* Плашка отмены живёт сверху, а не над панелью итогов: низ занят самым
          важным элементом интерфейса (раздел 7.1), и любое размещение над ним
          либо перекрывает три показателя ровно на те 5 секунд, когда
          пользователь смотрит на изменившийся итог, либо двигает их вверх и
          даёт скачок вёрстки. */}
      {pendingUndo && (
        <div className="fixed inset-x-4 top-[calc(env(safe-area-inset-top)+0.5rem)] z-40 flex items-center justify-between gap-3 rounded-xl bg-slate-800 px-4 py-2 shadow-lg">
          <span className="text-sm">{ru.day.deletedNotice}</span>
          {/* min-h-11 поднимает область нажатия до 44px (была 20px), -mr-2
              компенсирует добавленный padding, чтобы плашка не растолстела. */}
          <button
            className="-mr-2 min-h-11 shrink-0 px-3 text-sm font-semibold text-app-accent"
            onClick={handleUndoDelete}
          >
            {ru.day.undo}
          </button>
        </div>
      )}
    </div>
  );
}
