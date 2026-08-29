import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useSearchParams } from "react-router-dom";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { listManualPeriods, restoreManualPeriod, saveManualPeriod, softDeleteManualPeriod } from "@/db/pastPeriods";
import { getPeriodLabel, periodForDate } from "@/lib/calc/period";
import { NumberInput } from "@/components/NumberInput";
import { ru } from "@/i18n/ru";
import type { Period } from "@/types/models";

const userId = getLocalUserId();

/** Сколько лет назад можно уйти в выборе месяца. Десять лет истории — заведомо больше, чем перенесёт руками живой человек. */
const YEARS_BACK = 10;

interface Draft {
  year: number;
  month: number;
  hours: number;
  amount: number;
  /** Правка уже существующего месяца, а не новый: меняет заголовок и предупреждения. */
  editing: boolean;
}

export function PastPeriodsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("return") ?? "/";

  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), []);
  const manualPeriods = useLiveQuery(() => listManualPeriods(db, userId), []);
  // Все живые периоды — только чтобы предупредить, что за выбранный месяц уже
  // есть обычный период с записями.
  const allPeriods = useLiveQuery(
    () =>
      db.periods
        .where("user_id")
        .equals(userId)
        .filter((period) => period.deleted_at === null)
        .toArray(),
    [],
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingUndo, setPendingUndo] = useState<Period | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Синхронный замок: форма закрывается только после записи, и быстрый двойной
  // тап успел бы вызвать сохранение дважды — тот же приём, что на экране
  // праздников.
  const savingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    };
  }, []);

  const today = useMemo(() => new Date(), []);
  const years = useMemo(() => {
    const current = today.getFullYear();
    const list: number[] = [];
    for (let year = current + 1; year >= current - YEARS_BACK; year--) list.push(year);
    return list;
  }, [today]);

  if (!settings || manualPeriods === undefined || allPeriods === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-app-bg text-white/50">{ru.calendar.loading}</div>
    );
  }

  // Объявление функции всплывает выше этой проверки, поэтому сужение типа
  // внутрь неё не проходит — вытаскиваем число отдельно.
  const periodStartDay = settings.period_start_day;

  const label = (period: { year: number; month: number }) => {
    const id = getPeriodLabel(period.year, period.month, settings.period_start_day, settings.period_naming);
    return `${ru.calendar.monthNames[id.month - 1]} ${id.year}`;
  };

  function openForm(period?: Period) {
    if (period) {
      setDraft({
        year: period.year,
        month: period.month,
        hours: period.closed_totals?.total_hours ?? 0,
        amount: period.closed_totals?.amount ?? 0,
        editing: true,
      });
      return;
    }
    // По умолчанию — прошлый месяц: экран существует ради истории, а не ради
    // текущего периода, который считается сам.
    const previous = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const id = periodForDate(previous, periodStartDay);
    setDraft({ year: id.year, month: id.month, hours: 0, amount: 0, editing: false });
  }

  async function handleSave() {
    if (!draft || !settings || savingRef.current) return;
    savingRef.current = true;
    try {
      // Ничего не проверяем и ничем не блокируем (инвариант 54): ноль часов,
      // отрицательная сумма и месяц в будущем сохраняются как есть.
      await saveManualPeriod(
        db,
        userId,
        { year: draft.year, month: draft.month, hours: draft.hours, amount: draft.amount },
        settings,
      );
    } finally {
      savingRef.current = false;
    }
    setDraft(null);
  }

  async function handleDelete(period: Period) {
    await softDeleteManualPeriod(db, period.id);
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setPendingUndo(period);
    undoTimeoutRef.current = setTimeout(() => setPendingUndo(null), 5000);
  }

  async function handleUndoDelete() {
    if (!pendingUndo) return;
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    await restoreManualPeriod(db, pendingUndo.id);
    setPendingUndo(null);
  }

  // Предупреждения формы. Все пассивные: строка появляется, кнопка работает.
  const existingPeriod =
    draft && allPeriods.find((period) => period.year === draft.year && period.month === draft.month);
  const warnExisting = Boolean(existingPeriod) && !draft?.editing;
  // «Месяц ещё не наступил» считаем от периода сегодняшнего дня, а не от
  // календарного месяца: при period_start_day > 1 это разные вещи.
  const currentPeriod = periodForDate(today, periodStartDay);
  const warnFuture =
    draft !== null &&
    draft.year * 12 + (draft.month - 1) > currentPeriod.year * 12 + (currentPeriod.month - 1);
  const warnZeroHours = draft !== null && draft.hours === 0;
  const warnNegativeAmount = draft !== null && draft.amount < 0;
  // Про замок дня начала периода (инвариант 4) говорим только тогда, когда он
  // ещё не защёлкнут: у кого уже есть закрытый месяц, предупреждать не о чем.
  const warnLock =
    draft !== null && !draft.editing && !allPeriods.some((period) => period.is_closed);

  const warning = warnExisting
    ? ru.pastPeriods.hintExisting
    : warnFuture
      ? ru.pastPeriods.hintFutureMonth
      : warnNegativeAmount
        ? ru.pastPeriods.hintNegativeAmount
        : warnZeroHours
          ? ru.pastPeriods.hintZeroHours
          : null;

  return (
    // h-dvh + min-h-0 на скроллере: без ограниченной высоты скроллится документ
    // целиком и шапка с «назад» уезжает за верхний край (в standalone другой
    // кнопки «назад» нет).
    <div className="flex h-dvh flex-col bg-app-bg text-white">
      <header className="flex shrink-0 items-center gap-1 px-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-2">
        <button
          className="rounded-full p-3 text-xl text-white/70 active:bg-white/10"
          onClick={() => (draft ? setDraft(null) : navigate(returnTo))}
          aria-label={ru.pastPeriods.back}
        >
          ‹
        </button>
        <span className="min-w-0 truncate text-lg font-semibold tracking-tight">
          {draft ? ru.pastPeriods.formTitle : ru.pastPeriods.title}
        </span>
      </header>

      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6">
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label className="text-xs text-white/50" htmlFor="past-period-month">
                {ru.pastPeriods.month}
              </label>
              {/* select, а не input type="month": на iOS месячное поле выглядит
                  по-разному от версии к версии, а системный список — всегда
                  один и тот же выбор с крупными строками. */}
              <select
                id="past-period-month"
                className="mt-1 min-h-11 w-full rounded-lg bg-white/5 px-2 py-3"
                value={draft.month}
                onChange={(event) => setDraft({ ...draft, month: Number(event.target.value) })}
              >
                {ru.calendar.monthNames.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="w-28 shrink-0">
              <label className="text-xs text-white/50" htmlFor="past-period-year">
                {ru.pastPeriods.year}
              </label>
              <select
                id="past-period-year"
                className="mt-1 min-h-11 w-full rounded-lg bg-white/5 px-2 py-3"
                value={draft.year}
                onChange={(event) => setDraft({ ...draft, year: Number(event.target.value) })}
              >
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-white/50" htmlFor="past-period-hours">
              {ru.pastPeriods.hours}
            </label>
            <NumberInput
              id="past-period-hours"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3 text-lg"
              value={draft.hours}
              onChange={(hours) => setDraft({ ...draft, hours })}
            />
          </div>

          <div>
            <label className="text-xs text-white/50" htmlFor="past-period-amount">
              {ru.pastPeriods.amount}
            </label>
            <div className="mt-1 flex items-center gap-2 rounded-lg bg-white/5 px-2">
              {/* min-w-0 — иначе длинное число выталкивает валюту за край
                  экрана (инвариант 26). */}
              <NumberInput
                id="past-period-amount"
                className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none"
                value={draft.amount}
                onChange={(amount) => setDraft({ ...draft, amount })}
              />
              <span className="shrink-0 text-sm text-white/50">{settings.currency}</span>
            </div>
          </div>

          {/* Высота обеих строк зарезервирована: предупреждение появляется по
              значению поля и иначе двигало бы кнопку сохранения под пальцем. */}
          <p className={`text-xs text-white/40 ${warning ? "" : "invisible"}`}>{warning ?? "—"}</p>
          <p className={`text-xs text-white/40 ${warnLock ? "" : "invisible"}`}>{ru.pastPeriods.lockWarning}</p>
          <p className="text-xs text-white/30">{ru.pastPeriods.note}</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-6">
          {manualPeriods.length === 0 ? (
            <p className="text-sm text-white/40">{ru.pastPeriods.empty}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {manualPeriods.map((period) => (
                <li key={period.id} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2">
                  {/* Строка целиком — кнопка правки: исправить опечатку в
                      историческом итоге должно быть так же легко, как её
                      сделать. */}
                  <button
                    className="min-h-11 min-w-0 flex-1 text-left"
                    aria-label={`${ru.pastPeriods.edit}: ${label(period)}`}
                    onClick={() => openForm(period)}
                  >
                    <span className="block truncate text-sm">{label(period)}</span>
                    <span className="block truncate text-xs text-white/40">
                      {period.closed_totals?.total_hours ?? 0} {ru.calendar.hoursShort} ·{" "}
                      {(period.closed_totals?.amount ?? 0).toFixed(2)} {settings.currency}
                    </span>
                  </button>
                  <button
                    className="-mr-2 min-h-11 shrink-0 px-3 text-xs text-white/40 active:text-white/70"
                    aria-label={`${ru.pastPeriods.delete}: ${label(period)}`}
                    onClick={() => void handleDelete(period)}
                  >
                    {ru.pastPeriods.delete}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Основное действие — в нижней части экрана (инвариант 59). */}
      <div className="shrink-0 border-t border-white/10 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <button
          className="min-h-11 w-full rounded-lg bg-app-accent py-3 text-sm font-semibold text-slate-900 active:opacity-80"
          onClick={() => (draft ? void handleSave() : openForm())}
        >
          {draft ? ru.pastPeriods.save : ru.pastPeriods.add}
        </button>
      </div>

      {/* Плашка отмены сверху, как на календаре, в типах дня и праздниках: низ
          занят основным действием. */}
      {pendingUndo && (
        <div className="fixed inset-x-4 top-[calc(env(safe-area-inset-top)+0.5rem)] z-30 flex items-center justify-between gap-3 rounded-xl bg-slate-800 px-4 py-2 shadow-lg">
          <span className="min-w-0 truncate text-sm">{ru.pastPeriods.deleted}</span>
          <button
            className="-mr-2 min-h-11 shrink-0 px-3 text-sm font-semibold text-app-accent"
            onClick={() => void handleUndoDelete()}
          >
            {ru.pastPeriods.undo}
          </button>
        </div>
      )}
    </div>
  );
}
