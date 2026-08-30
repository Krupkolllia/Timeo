import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useSearchParams } from "react-router-dom";
import { useBackTo } from "@/app/useBackTo";
import { TabBar } from "@/components/TabBar";
import { db } from "@/db/db";
import { useActiveUserId } from "@/store/userStore";
import {
  applyBaseRateChange,
  closePeriod,
  findLivePeriodQuery,
  getOrCreatePeriod,
  reopenPeriod,
  updatePeriod,
} from "@/db/periods";
import { NumberInput } from "@/components/NumberInput";
import { RateChangeDialog } from "@/pages/PeriodSummary/RateChangeDialog";
import {
  calculatePeriodTotals,
  getAdjacentPeriod,
  getPeriodDateRange,
  getPeriodLabel,
  periodForDate,
  type PeriodId,
} from "@/lib/calc/period";
import { toISODate } from "@/lib/calc/calendarGrid";
import { formatDayShort } from "@/lib/format/date";
import { formatEntryDetail } from "@/lib/format/entry";
import { ru } from "@/i18n/ru";
import type { RateChangeMode } from "@/types/models";

function parsePeriodParam(value: string | null, min: number, max: number): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

export function PeriodSummaryPage() {
  const userId = useActiveUserId();
  const [searchParams] = useSearchParams();
  // Правило «назад» одно на все внутренние экраны, см. useBackTo.
  const goBack = useBackTo("/");

  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), [userId]);
  const dayTypes = useLiveQuery(() => db.day_types.where("user_id").equals(userId).toArray(), [userId]);

  const [rateDialogOpen, setRateDialogOpen] = useState(false);
  const [reopenConfirmOpen, setReopenConfirmOpen] = useState(false);
  const [recalculatedCount, setRecalculatedCount] = useState<number | null>(null);
  const recalculatedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Период приходит из query-параметров: экран открывается тапом по панели
  // итогов календаря, и «текущий» для календаря и для этого экрана — разные
  // вещи, стоит пролистать месяц назад. Без параметров (прямой заход по
  // ссылке или восстановление PWA) берём период сегодняшнего дня.
  //
  // Зависимость — на само число period_start_day, а не на объект settings:
  // применение новой ставки пишет preferred_rate_change_mode, объект settings
  // меняет ссылку, следом менялись бы viewed и range, useLiveQuery по записям
  // пересоздавался бы и на кадр отдавал undefined — расшифровка мигала бы
  // строкой «за этот период записей нет» ровно после пересчёта.
  const periodStartDay = settings?.period_start_day;

  const viewed = useMemo<PeriodId | null>(() => {
    const year = parsePeriodParam(searchParams.get("year"), 1970, 9999);
    const month = parsePeriodParam(searchParams.get("month"), 1, 12);
    if (year !== null && month !== null) return { year, month };
    return periodStartDay === undefined ? null : periodForDate(new Date(), periodStartDay);
  }, [searchParams, periodStartDay]);

  const range = useMemo(
    () =>
      viewed && periodStartDay !== undefined
        ? getPeriodDateRange(viewed.year, viewed.month, periodStartDay)
        : null,
    [viewed, periodStartDay],
  );

  useEffect(() => {
    if (!viewed || !settings) return;
    void getOrCreatePeriod(db, userId, viewed.year, viewed.month, settings);
    // Как и в календаре, зависим от конкретных полей: правка темы не должна
    // перезапускать поиск/создание периода.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewed, settings?.default_base_rate, settings?.default_norm_hours, userId]);

  const period = useLiveQuery(
    () =>
      viewed ? findLivePeriodQuery(db, userId, viewed.year, viewed.month).first() : undefined,
    [viewed, userId],
  );

  const entries = useLiveQuery(async () => {
    if (!range) return [];
    const rows = await db.entries
      .where("date")
      .between(toISODate(range.start), toISODate(range.end), true, true)
      .filter((entry) => entry.user_id === userId && entry.deleted_at === null)
      .toArray();
    // Порядок по индексу date гарантирован не полностью, а внутри одного дня —
    // не гарантирован вовсе: расшифровка не должна переставлять строки между
    // перечитываниями (раздел 5.4 допускает несколько записей на день).
    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.created_at.localeCompare(b.created_at));
  }, [range, userId]);

  // Следующий период — только чтобы диалог смены ставки мог назвать его и
  // сказать, создан ли он уже. getOrCreatePeriod здесь не вызывается: он создаёт
  // строку при первом обращении (раздел 5.2), и открытие диалога начало бы
  // плодить пустые периоды вперёд по времени.
  const next = useMemo(() => (viewed ? getAdjacentPeriod(viewed.year, viewed.month, 1) : null), [viewed]);
  const nextPeriod = useLiveQuery(
    () =>
      next ? findLivePeriodQuery(db, userId, next.year, next.month).first() : undefined,
    [next, userId],
  );

  const dayTypeById = useMemo(() => new Map((dayTypes ?? []).map((dt) => [dt.id, dt])), [dayTypes]);

  const totals = useMemo(
    () => (period && settings ? calculatePeriodTotals(period, entries ?? [], dayTypeById, settings) : null),
    [period, entries, dayTypeById, settings],
  );

  // Черновик базовой ставки: единственное поле, которое не пишется сразу —
  // раздел 6.6 требует диалога с выбором режима.
  //
  // null означает «черновика нет, показываем ставку периода», а не «ноль»:
  // инициализация черновика из эффекта дала бы кадр, в котором период уже
  // загружен, а черновик ещё равен нулю — поле мигало бы нулём и кнопкой
  // «сохранить ставку». Эффект ниже только сбрасывает черновик, когда значение
  // в базе действительно изменилось (наш же пересчёт) или сменился период.
  const [rateDraft, setRateDraft] = useState<number | null>(null);
  const syncedRateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!period || syncedRateRef.current === period.id) return;
    syncedRateRef.current = period.id;
    setRateDraft(null);
  }, [period]);

  // Комментарий к extra_amount — тоже черновик (по той же причине, что и
  // ставка), и сбрасывается только при смене периода: иначе эхо собственной
  // записи из Dexie перетирало бы набранное.
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const syncedNoteRef = useRef<string | null>(null);
  useEffect(() => {
    if (!period || syncedNoteRef.current === period.id) return;
    syncedNoteRef.current = period.id;
    setNoteDraft(null);
  }, [period]);

  useEffect(() => {
    return () => {
      if (recalculatedTimeoutRef.current) clearTimeout(recalculatedTimeoutRef.current);
    };
  }, []);

  async function handleApplyRate(mode: RateChangeMode, fromDateISO: string | null) {
    if (!viewed || !settings) return;
    setRateDialogOpen(false);
    const result = await applyBaseRateChange(db, userId, {
      year: viewed.year,
      month: viewed.month,
      newBaseRate: rateDraft ?? period?.base_rate ?? 0,
      mode,
      fromDateISO,
      periodStartDay: settings.period_start_day,
    });
    // Черновик снимаем сами, сразу после записи, а не по эху из Dexie.
    // Раньше сброс висел на изменении period.base_rate, и между записью и
    // приходом обновлённой строки помещался целый ввод: человек применял 40,
    // тут же вписывал 50, эхо первой правки приходило следом и стирало
    // набранное — диалог применял ту же сорок ещё раз, а введённая ставка
    // пропадала молча. Для «со следующего периода» смысл тот же: текущий
    // период не изменился, и в поле должна вернуться его собственная ставка.
    setRateDraft(null);
    if (mode === "apply_next_period") return;
    if (recalculatedTimeoutRef.current) clearTimeout(recalculatedTimeoutRef.current);
    setRecalculatedCount(result.updatedEntries);
    recalculatedTimeoutRef.current = setTimeout(() => setRecalculatedCount(null), 4000);
  }

  if (!settings || !viewed || !range || !period) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-app-bg text-app-fg/50">{ru.calendar.loading}</div>
    );
  }

  const label = getPeriodLabel(viewed.year, viewed.month, settings.period_start_day, settings.period_naming);
  const nextLabelId = next
    ? getPeriodLabel(next.year, next.month, settings.period_start_day, settings.period_naming)
    : label;
  const nextLabel = `${ru.calendar.monthNames[nextLabelId.month - 1]} ${nextLabelId.year}`;
  const isClosed = period.is_closed;
  const rateValue = rateDraft ?? period.base_rate;
  const rateChanged = rateValue !== period.base_rate;
  // Часть 2.3: без параметров экран открыт вкладкой «Период», а не тапом по
  // панели итогов календаря — в этом случае возвращаться некуда, «назад»
  // прячется, и панель вкладок встаёт на её обычное место снизу.
  const isTab = searchParams.get("year") === null && searchParams.get("month") === null;

  return (
    // h-dvh, а не min-h-dvh: без ограниченной высоты у flex-родителя
    // overflow-y-auto на списке не срабатывает, скроллится документ целиком, и
    // на месяце из 26 записей кнопка «назад» уезжает за верхний край — вернуться
    // можно только пролистав весь список обратно.
    <div className="flex h-dvh flex-col bg-app-bg text-app-fg">
      <header className="flex shrink-0 items-center gap-1 px-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-2">
        {!isTab && (
          <button
            className="rounded-full p-3 text-xl text-app-fg/70 active:bg-app-fg/10"
            onClick={goBack}
            aria-label={ru.period.back}
          >
            ‹
          </button>
        )}
        <span className="text-lg font-semibold tracking-tight">
          {ru.calendar.monthNames[label.month - 1]} {label.year}
        </span>
      </header>

      {/* min-h-0 обязателен: без него flex-элемент не сжимается ниже своего
          контента и overflow-y-auto остаётся бездействующим. */}
      <div
        className={`flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 ${
          isTab ? "pb-[calc(var(--tabbar-h)+1rem)]" : "pb-[calc(env(safe-area-inset-bottom)+1.5rem)]"
        }`}
      >
        {isClosed && (
          <p className="rounded-xl bg-app-fg/5 px-3 py-2 text-sm text-app-fg/60">{ru.period.closedBanner}</p>
        )}

        <div>
          <label className="text-xs text-app-fg/50" htmlFor="period-base-rate">{ru.period.baseRate}</label>
          <div className="mt-1 flex items-center gap-2">
            {/* min-w-0 — иначе длинное число распирает flex-строку и выталкивает
                валюту с кнопкой за край экрана (инвариант 26). */}
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-app-fg/5 px-2">
              <NumberInput
                id="period-base-rate"
                disabled={isClosed}
                className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none disabled:opacity-70"
                value={rateValue}
                onChange={setRateDraft}
              />
              <span className="shrink-0 text-sm text-app-fg/50">{settings.currency}</span>
            </div>
            {rateChanged && !isClosed && (
              <button
                className="min-h-11 shrink-0 rounded-lg bg-app-accent px-3 text-sm font-semibold text-app-accent-fg active:opacity-80"
                onClick={() => setRateDialogOpen(true)}
              >
                {ru.period.baseRateSave}
              </button>
            )}
          </div>
          {/* У ручного периода (раздел 8.7) базовой ставки не существует:
              человек вписал итог за месяц, часы по ней не считаются вовсе, и
              предупреждение «часы будут считаться по нулю» было бы просто
              неправдой на экране, который обязан объяснять числа (инвариант 55). */}
          <p className={`mt-1 text-xs text-app-fg/40 ${rateValue === 0 && !period.is_manual ? "" : "invisible"}`}>
            {ru.period.hintZeroBaseRate}
          </p>
          {/* Высота строки зарезервирована всегда: появляясь на 4 секунды, она
              иначе сдвигает вниз весь экран и возвращает обратно. */}
          <p className={`text-xs text-app-fg/40 ${recalculatedCount === null ? "invisible" : ""}`}>
            {ru.period.recalculatedNotice}: {recalculatedCount ?? 0}
          </p>
        </div>

        <div>
          <label className="text-xs text-app-fg/50" htmlFor="period-norm-hours">{ru.period.normHours}</label>
          <NumberInput
            id="period-norm-hours"
            disabled={isClosed}
            className="mt-1 w-full rounded-lg bg-app-fg/5 px-2 py-3 text-lg disabled:opacity-70"
            value={period.norm_hours}
            onChange={(norm_hours) => void updatePeriod(db, period.id, { norm_hours })}
          />
        </div>

        <div>
          <label className="text-xs text-app-fg/50" htmlFor="period-extra-amount">{ru.period.extraAmount}</label>
          <div className="mt-1 flex items-center gap-2 rounded-lg bg-app-fg/5 px-2">
            <NumberInput
              id="period-extra-amount"
              disabled={isClosed}
              className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none disabled:opacity-70"
              value={period.extra_amount}
              onChange={(extra_amount) => void updatePeriod(db, period.id, { extra_amount })}
            />
            <span className="shrink-0 text-sm text-app-fg/50">{settings.currency}</span>
          </div>
          <p className={`mt-1 text-xs text-app-fg/40 ${period.extra_amount < 0 ? "" : "invisible"}`}>
            {ru.period.hintNegativeExtra}
          </p>
          {/* Значение поля — локальный черновик, а не то, что вернул Dexie:
              контролируемый input, чей value приходит из асинхронного хранилища,
              на быстром наборе теряет символы и прыгает кареткой. Запись в базу
              идёт параллельно, как persist() в экране дня. */}
          <input
            type="text"
            disabled={isClosed}
            className="mt-1 w-full rounded-lg bg-app-fg/5 px-2 py-3 text-sm disabled:opacity-70"
            placeholder={ru.period.extraNotePlaceholder}
            aria-label={ru.period.extraNote}
            value={noteDraft ?? period.extra_note}
            onChange={(event) => {
              setNoteDraft(event.target.value);
              void updatePeriod(db, period.id, { extra_note: event.target.value });
            }}
          />
        </div>

        <div>
          <p className="text-xs text-app-fg/50">{ru.period.breakdown}</p>
          {(entries ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-app-fg/40">{ru.period.noEntries}</p>
          ) : (
            <ul className="mt-2 flex flex-col divide-y divide-app-fg/5">
              {(entries ?? []).map((entry) => {
                const dayType = dayTypeById.get(entry.day_type_id);
                return (
                  <li key={entry.id} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        {formatDayShort(entry.date)} · {dayType?.name ?? "—"}
                      </p>
                      <p className="truncate text-xs text-app-fg/40">{formatEntryDetail(entry, dayType?.pay_mode)}</p>
                    </div>
                    <span className="shrink-0 text-sm tabular-nums">{entry.amount.toFixed(2)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="rounded-xl bg-app-fg/5 px-3 py-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-app-fg/50">{ru.period.total}</span>
            <span className="text-2xl font-semibold tabular-nums">
              {(totals?.amount ?? 0).toFixed(2)} {settings.currency}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between text-sm text-app-fg/50">
            <span>{ru.period.hoursColumn}</span>
            <span className="tabular-nums">
              {totals?.total_hours ?? 0} {ru.calendar.hoursShort}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between text-sm text-app-fg/50">
            <span>{ru.calendar.remainingToNorm}</span>
            <span className="tabular-nums">
              {totals?.remaining_to_norm ?? 0} {ru.calendar.hoursShort}
            </span>
          </div>
          {/* Снимок остаётся видимым после переоткрытия (инвариант 3) — иначе
              сравнить «до» и «после» правки нечем. */}
          {!isClosed && period.closed_totals && (
            <p className="mt-2 text-xs text-app-fg/40">
              {ru.period.snapshot}: {period.closed_totals.amount.toFixed(2)} {settings.currency}
            </p>
          )}
        </div>

        {isClosed ? (
          <button
            className="min-h-11 rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20"
            onClick={() => setReopenConfirmOpen(true)}
          >
            {ru.period.reopen}
          </button>
        ) : (
          <button
            className="min-h-11 rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20"
            onClick={() =>
              void closePeriod(
                db,
                userId,
                viewed.year,
                viewed.month,
                settings.period_start_day,
                settings.total_hours_paid_only,
              )
            }
          >
            {ru.period.closePeriod}
          </button>
        )}

      </div>

      {rateDialogOpen && (
        <RateChangeDialog
          currentRate={period.base_rate}
          newRate={rateValue}
          currency={settings.currency}
          preferredMode={settings.preferred_rate_change_mode}
          periodStartISO={toISODate(range.start)}
          periodEndISO={toISODate(range.end)}
          todayISO={toISODate(new Date())}
          nextPeriodLabel={nextLabel}
          nextPeriodExists={nextPeriod !== undefined}
          onCancel={() => setRateDialogOpen(false)}
          onApply={(mode, fromDateISO) => void handleApplyRate(mode, fromDateISO)}
        />
      )}

      {/* Раздел 7.10: модальных подтверждений в приложении нет — кроме
          переоткрытия закрытого периода (инвариант 3) и замены данных при
          импорте. Это тот самый случай. */}
      {reopenConfirmOpen && (
        <div
          className="day-sheet-overlay fixed inset-0 z-40 flex items-center justify-center bg-app-scrim/60 p-6"
          onClick={() => setReopenConfirmOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-app-surface p-4 text-app-fg"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-base font-semibold">{ru.period.reopenConfirmTitle}</p>
            <p className="mt-2 text-sm text-app-fg/50">{ru.period.reopenConfirmBody}</p>
            <div className="mt-4 flex gap-3">
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20"
                onClick={() => setReopenConfirmOpen(false)}
              >
                {ru.period.cancel}
              </button>
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80"
                onClick={() => {
                  setReopenConfirmOpen(false);
                  void reopenPeriod(db, userId, viewed.year, viewed.month);
                }}
              >
                {ru.period.reopenConfirmAction}
              </button>
            </div>
          </div>
        </div>
      )}

      {isTab && <TabBar />}
    </div>
  );
}
