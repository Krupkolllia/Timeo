import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useSearchParams } from "react-router-dom";
import { db } from "@/db/db";
import { useActiveUserId } from "@/store/userStore";
import {
  applyDayTypeChange,
  countDayTypeChangeTargets,
  createDayType,
  deleteDayType,
  listDayTypes,
  reorderDayTypes,
  restoreDayType,
  setDayTypeArchived,
  updateDayType,
  type DayTypeDraft,
} from "@/db/dayTypes";
import { hasFinancialChange } from "@/lib/calc/dayTypeChange";
import { getPeriodLabel, periodForDate } from "@/lib/calc/period";
import { DayTypeForm } from "@/pages/DayTypes/DayTypeForm";
import { emptyDayTypeDraft } from "@/pages/DayTypes/dayTypeDefaults";
import { ru } from "@/i18n/ru";
import type { DayType } from "@/types/models";

function toDraft(dayType: DayType): DayTypeDraft {
  return {
    name: dayType.name,
    color: dayType.color,
    label: dayType.label,
    note: dayType.note,
    pay_mode: dayType.pay_mode,
    rate_mode: dayType.rate_mode,
    fixed_amount: dayType.fixed_amount,
    counts_as_work: dayType.counts_as_work,
    counts_toward_norm: dayType.counts_toward_norm,
    default_hours: dayType.default_hours,
    default_start: dayType.default_start,
    default_end: dayType.default_end,
    default_break_minutes: dayType.default_break_minutes,
    default_break_paid_minutes: dayType.default_break_paid_minutes,
    default_multiplier: dayType.default_multiplier,
    default_rate: dayType.default_rate,
    ignore_auto_multipliers: dayType.ignore_auto_multipliers,
  };
}

export function DayTypesPage() {
  const userId = useActiveUserId();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Куда возвращаться по «назад» и после сохранения. Экран открывается плюсом
  // из шторки дня (раздел 8.2), и вернуть пользователя нужно ровно в тот день,
  // ради которого он пошёл создавать тип.
  const returnTo = searchParams.get("return") ?? "/";
  const isCreating = searchParams.get("new") === "1";
  const editingId = searchParams.get("edit");

  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), [userId]);
  const dayTypes = useLiveQuery(() => listDayTypes(db, userId), [userId]);

  // Раздел 6.7 и 8.5 говорят про «текущий период»: и предложение обновить
  // записи, и ставка в списке относятся к периоду СЕГОДНЯШНЕГО дня, а не к
  // тому месяцу, который пользователь листал в календаре. Прошлые периоды
  // раздел 6.7 не включает никогда, поэтому иначе экран называл бы одно число,
  // а менял другое.
  const periodStartDay = settings?.period_start_day;
  const current = useMemo(
    () => (periodStartDay === undefined ? null : periodForDate(new Date(), periodStartDay)),
    [periodStartDay],
  );
  // Результат несёт год и месяц, для которых он получен, и это не украшение.
  // Для формы «период ещё читается» и «периода нет» — разные вещи: второе
  // рисует подсказку инварианта 22 вместо предпросмотра ставки. Отличить их по
  // одному лишь undefined нельзя дважды:
  //
  //  - сам запрос отдаёт undefined и пока читает, и когда строки нет;
  //  - useLiveQuery СОХРАНЯЕТ прежний результат, пока перезапускается после
  //    смены зависимости. На первом рендере current ещё null, результат — null,
  //    и когда settings приезжают и current становится настоящим, форма кадр
  //    видит этот устаревший null и показывает «базовая ставка не задана» на
  //    периоде, где ставка задана.
  //
  // Поэтому «готово» — это не «не undefined», а «ответ относится к тому
  // периоду, который мы сейчас показываем».
  const periodResult = useLiveQuery(
    async () => {
      if (!current) return null;
      const row =
        (await db.periods.where("[user_id+year+month]").equals([userId, current.year, current.month]).first()) ?? null;
      return { year: current.year, month: current.month, row };
    },
    [current, userId],
  );
  const period =
    current && periodResult && periodResult.year === current.year && periodResult.month === current.month
      ? periodResult.row
      : undefined;

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteBlockedId, setDeleteBlockedId] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<DayType | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [updatedCount, setUpdatedCount] = useState<number | null>(null);
  const updatedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Раздел 6.7: предложение «обновить N записей?» — выбор, а не подтверждение.
  const [offer, setOffer] = useState<{ dayTypeId: string; count: number } | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
      if (updatedTimeoutRef.current) clearTimeout(updatedTimeoutRef.current);
    };
  }, []);

  const active = useMemo(() => (dayTypes ?? []).filter((dt) => !dt.is_archived), [dayTypes]);
  const archived = useMemo(() => (dayTypes ?? []).filter((dt) => dt.is_archived), [dayTypes]);
  const editing = editingId ? (dayTypes ?? []).find((dt) => dt.id === editingId) : undefined;

  function closeForm() {
    navigate(returnTo);
  }

  function noticeUpdated(count: number) {
    if (updatedTimeoutRef.current) clearTimeout(updatedTimeoutRef.current);
    setUpdatedCount(count);
    updatedTimeoutRef.current = setTimeout(() => setUpdatedCount(null), 4000);
  }

  async function handleSave(draft: DayTypeDraft) {
    if (!current || !settings) return;

    if (!editing) {
      // Новый тип не может иметь существующих записей — предлагать нечего.
      await createDayType(db, userId, draft);
      closeForm();
      return;
    }

    const after: DayType = { ...editing, ...draft };
    await updateDayType(db, editing.id, draft);

    // Инвариант 10: правка типа дня не изменила ни одной записи. Дальше —
    // только предложение, и только для финансовых полей (раздел 6.7):
    // косметика применяется везде сразу и ничего не спрашивает.
    if (!hasFinancialChange(editing, after)) {
      closeForm();
      return;
    }

    const count = await countDayTypeChangeTargets(db, userId, {
      dayTypeId: editing.id,
      year: current.year,
      month: current.month,
      periodStartDay: settings.period_start_day,
      weekendMultipliers: settings.weekend_multipliers,
    });
    if (count === 0) {
      closeForm();
      return;
    }
    setOffer({ dayTypeId: editing.id, count });
  }

  async function handleAcceptOffer() {
    if (!offer || !current || !settings) return;
    const applied = await applyDayTypeChange(db, userId, {
      dayTypeId: offer.dayTypeId,
      year: current.year,
      month: current.month,
      periodStartDay: settings.period_start_day,
      weekendMultipliers: settings.weekend_multipliers,
    });
    setOffer(null);
    noticeUpdated(applied);
    closeForm();
  }

  async function handleDelete(dayType: DayType) {
    const result = await deleteDayType(db, dayType.id);
    if (!result.deleted) {
      setDeleteBlockedId(dayType.id);
      return;
    }
    setDeleteBlockedId(null);
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setPendingUndo(dayType);
    undoTimeoutRef.current = setTimeout(() => setPendingUndo(null), 5000);
  }

  async function handleUndoDelete() {
    if (!pendingUndo) return;
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    await restoreDayType(db, pendingUndo.id);
    setPendingUndo(null);
  }

  function handleMove(index: number, delta: number) {
    const next = [...active];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    // Архивные идут после активных: иначе их номера смешались бы с активными
    // и порядок «прыгал» бы при возврате типа из архива. Мягко удалённые
    // перенумеровывает сам слой данных — экран их не видит.
    void reorderDayTypes(db, userId, [...next, ...archived].map((dt) => dt.id));
  }

  if (!settings || !current || dayTypes === undefined || period === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-app-bg text-app-fg/50">{ru.calendar.loading}</div>
    );
  }

  const periodId = getPeriodLabel(current.year, current.month, settings.period_start_day, settings.period_naming);
  const periodLabel = `${ru.calendar.monthNames[periodId.month - 1]} ${periodId.year}`;
  const showForm = isCreating || editing !== undefined;

  // h-dvh, а не min-h-dvh: без ограниченной высоты у flex-родителя
  // overflow-y-auto на списке не срабатывает и скроллится документ целиком —
  // шапка с кнопкой «назад» уезжает за верхний край.
  return (
    <div className="flex h-dvh flex-col bg-app-bg text-app-fg">
      <header className="flex shrink-0 items-center gap-1 px-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-2">
        <button
          className="rounded-full p-3 text-xl text-app-fg/70 active:bg-app-fg/10"
          onClick={() => (showForm ? closeForm() : navigate(returnTo))}
          aria-label={ru.dayTypes.back}
        >
          ‹
        </button>
        <span className="min-w-0 truncate text-lg font-semibold tracking-tight">
          {showForm ? (editing ? ru.dayTypes.formTitleEdit : ru.dayTypes.formTitleNew) : ru.dayTypes.title}
        </span>
        {showForm && (
          <button
            className="ml-auto min-h-11 shrink-0 px-3 text-sm text-app-accent-text"
            onClick={() => navigate(`/settings/day-types?return=${encodeURIComponent(returnTo)}`)}
          >
            {ru.dayTypes.allTypes}
          </button>
        )}
      </header>

      {showForm ? (
        <DayTypeForm
          // key: переход «создание → правка другого типа» без него оставил бы
          // в форме состояние предыдущего черновика.
          key={editing?.id ?? "new"}
          initial={editing ? toDraft(editing) : emptyDayTypeDraft()}
          baseRate={period === null ? null : period.base_rate}
          periodLabel={periodLabel}
          currency={settings.currency}
          onSave={(draft) => void handleSave(draft)}
          onCancel={closeForm}
          onOpenPeriod={() => navigate(`/period?year=${current.year}&month=${current.month}`)}
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6">
            <p className="text-xs text-app-fg/40">{periodLabel}</p>

            {active.length === 0 && <p className="text-sm text-app-fg/40">{ru.dayTypes.empty}</p>}

            <ul className="flex flex-col gap-2">
              {active.map((dayType, index) => (
                <li key={dayType.id} className="rounded-xl bg-app-fg/5 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-app-accent-fg"
                      style={{ backgroundColor: dayType.color }}
                    >
                      {dayType.label}
                    </span>
                    <button
                      className="min-w-0 flex-1 py-2 text-left"
                      onClick={() =>
                        navigate(
                          `/settings/day-types?edit=${dayType.id}&return=${encodeURIComponent(returnTo)}`,
                        )
                      }
                    >
                      {/* truncate + min-w-0: имя до 40 символов не должно
                          выталкивать кнопки за край (инвариант 26). */}
                      <span className="block truncate text-sm">{dayType.name}</span>
                      <span className="block truncate text-xs text-app-fg/40">
                        {describeRate(dayType, period?.base_rate ?? null, settings.currency)}
                      </span>
                    </button>
                    {/* w-11, а не w-8: две соседние стрелки шириной 32px — это
                        промах через одну, а промах здесь молча меняет порядок
                        не тем типом дня (инвариант 59). */}
                    <div className="flex shrink-0 items-center">
                      <button
                        className="h-11 w-11 text-app-fg/40 active:text-app-fg"
                        aria-label={`${ru.dayTypes.moveUp}: ${dayType.name}`}
                        onClick={() => handleMove(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="h-11 w-11 text-app-fg/40 active:text-app-fg"
                        aria-label={`${ru.dayTypes.moveDown}: ${dayType.name}`}
                        onClick={() => handleMove(index, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 flex gap-3">
                    <button
                      className="min-h-11 text-xs text-app-fg/40 active:text-app-fg/70"
                      onClick={() => void setDayTypeArchived(db, dayType.id, true)}
                    >
                      {ru.dayTypes.archive}
                    </button>
                    <button
                      className="min-h-11 text-xs text-app-fg/40 active:text-app-fg/70"
                      onClick={() => void handleDelete(dayType)}
                    >
                      {ru.dayTypes.delete}
                    </button>
                  </div>
                  {/* Инвариант 11: отказ несёт объяснение и рабочую альтернативу,
                      а не молчит. */}
                  {deleteBlockedId === dayType.id && (
                    <p className="mt-1 text-xs text-app-fg/40">{ru.dayTypes.deleteBlocked}</p>
                  )}
                </li>
              ))}
            </ul>

            <div>
              <button
                className="min-h-11 w-full rounded-lg bg-app-fg/5 py-3 text-left text-sm active:bg-app-fg/10"
                aria-expanded={archiveOpen}
                onClick={() => setArchiveOpen((open) => !open)}
              >
                {archiveOpen ? "▾" : "▸"} {ru.dayTypes.archiveSection} ({archived.length})
              </button>
              {archiveOpen && (
                <ul className="mt-2 flex flex-col gap-2">
                  {archived.length === 0 && <p className="text-xs text-app-fg/40">{ru.dayTypes.archiveSectionEmpty}</p>}
                  {archived.map((dayType) => (
                    <li key={dayType.id} className="flex items-center gap-3 rounded-xl bg-app-fg/5 px-3 py-2">
                      <span
                        aria-hidden
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-app-accent-fg opacity-60"
                        style={{ backgroundColor: dayType.color }}
                      >
                        {dayType.label}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-app-fg/60">{dayType.name}</span>
                      {/* Инвариант 12: вернуть из архива можно в любой момент. */}
                      <button
                        className="min-h-11 shrink-0 px-2 text-xs text-app-accent-text"
                        onClick={() => void setDayTypeArchived(db, dayType.id, false)}
                      >
                        {ru.dayTypes.unarchive}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className={`text-xs text-app-fg/40 ${updatedCount === null ? "invisible" : ""}`}>
              {ru.dayTypes.updatedNotice}: {updatedCount ?? 0}
            </p>
          </div>

          {/* Основное действие — в нижней части экрана (инвариант 59). */}
          <div className="shrink-0 border-t border-app-fg/10 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
            <button
              className="min-h-11 w-full rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80"
              onClick={() => navigate(`/settings/day-types?new=1&return=${encodeURIComponent(returnTo)}`)}
            >
              {ru.dayTypes.create}
            </button>
          </div>
        </>
      )}

      {pendingUndo && (
        <div className="fixed inset-x-4 top-[calc(env(safe-area-inset-top)+0.5rem)] z-30 flex items-center justify-between gap-3 rounded-xl bg-app-surface-2 px-4 py-2 shadow-lg">
          <span className="text-sm">{ru.dayTypes.deleted}</span>
          <button className="-mr-2 min-h-11 shrink-0 px-3 text-sm font-semibold text-app-accent-text" onClick={() => void handleUndoDelete()}>
            {ru.dayTypes.undo}
          </button>
        </div>
      )}

      {/* Раздел 6.7: предложение, а не подтверждение. По умолчанию не меняется
          ничего — закрытие панели тапом мимо равнозначно «оставить как есть»,
          и эта кнопка стоит первой. */}
      {offer && (
        <div
          className="day-sheet-overlay fixed inset-0 z-40 flex items-end bg-app-scrim/50"
          onClick={() => {
            setOffer(null);
            closeForm();
          }}
        >
          <div
            className="w-full rounded-t-2xl bg-app-surface p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] text-app-fg"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-base font-semibold">{ru.dayTypes.offerTitle}</p>
            <p className="mt-2 text-sm text-app-fg/70">
              {ru.dayTypes.offerBodyPrefix} {offer.count}
            </p>
            <p className="mt-1 text-xs text-app-fg/40">{ru.dayTypes.offerBodyNote}</p>
            <div className="mt-4 flex gap-3">
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80"
                onClick={() => {
                  setOffer(null);
                  closeForm();
                }}
              >
                {ru.dayTypes.offerKeep}
              </button>
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20"
                onClick={() => void handleAcceptOffer()}
              >
                {ru.dayTypes.offerUpdate}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Раздел 8.5: строка показывает ставку В КОНТЕКСТЕ ТЕКУЩЕГО ПЕРИОДА вместе с
 * множителем, а у типов со своей ставкой — замок. Он и отличает «60 zł/h,
 * потому что ×2 от тридцати» от «60 zł/h, потому что так решили».
 */
function describeRate(dayType: DayType, baseRate: number | null, currency: string): string {
  if (dayType.pay_mode === "unpaid") return ru.dayTypes.payModeUnpaid;
  if (dayType.pay_mode === "fixed_amount") {
    return `${ru.dayTypes.payModeFixed}: ${(dayType.fixed_amount ?? 0).toFixed(2)} ${currency}`;
  }
  if (dayType.rate_mode === "pinned") {
    // null и явно вписанный 0 — разные вещи: первое значит «ставку не задали»,
    // второе «день не оплачивается по часам». Формат «0.00» сливал их в одну
    // строку ровно там, куда пользователь пришёл бы разбираться, что с типом
    // не так (инвариант 55).
    if (dayType.default_rate === null) return `🔒 ${ru.dayTypes.noPinnedRateShort}`;
    return `🔒 ${dayType.default_rate.toFixed(2)} ${currency}/${ru.calendar.hoursShort}`;
  }
  const multiplier = `×${dayType.default_multiplier}`;
  if (baseRate === null) return multiplier;
  return `${multiplier} · ${(baseRate * dayType.default_multiplier).toFixed(2)} ${currency}/${ru.calendar.hoursShort}`;
}
