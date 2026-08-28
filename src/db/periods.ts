import { calculatePeriodTotals, getPeriodDateRange } from "@/lib/calc/period";
import { planRateChange } from "@/lib/calc/rateChange";
import { toISODate } from "@/lib/calc/calendarGrid";
import { roundMoney } from "@/lib/calc/round";
import type { TimeoDB } from "@/db/schema";
import type { Entry, Period, RateChangeMode, Settings } from "@/types/models";

function findPeriod(db: TimeoDB, userId: string, year: number, month: number) {
  return db.periods.where("[user_id+year+month]").equals([userId, year, month]).first();
}

function periodOrdinal(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/**
 * Инвариант 7: перелистывание календаря вперёд не создаёт промежуточные
 * периоды, поэтому «предыдущий» — это последний СУЩЕСТВУЮЩИЙ более ранний
 * период, а не буквально месяц минус один. Иначе прыжок с августа на октябрь
 * не находил сентябрь, откатывался на settings.default_base_rate (по умолчанию
 * 0) и молча создавал октябрь с нулевой ставкой.
 */
async function findPreviousExistingPeriod(
  db: TimeoDB,
  userId: string,
  year: number,
  month: number,
): Promise<Period | undefined> {
  const target = periodOrdinal(year, month);
  // Периодов у пользователя по одному на месяц — полная выборка дешевле, чем
  // обратный обход составного индекса с самодельными границами ключа.
  const all = await db.periods.where("user_id").equals(userId).toArray();

  let best: Period | undefined;
  let bestOrdinal = -Infinity;
  for (const candidate of all) {
    if (candidate.deleted_at !== null) continue;
    const ordinal = periodOrdinal(candidate.year, candidate.month);
    if (ordinal >= target || ordinal <= bestOrdinal) continue;
    best = candidate;
    bestOrdinal = ordinal;
  }
  return best;
}

/**
 * Section 5.2 of the spec — the period isolation mechanism. On first access to a period,
 * the base_rate/norm_hours values are COPIED from the previous period (not referenced),
 * so edits in one period physically cannot affect another. If there is no
 * previous period, default_base_rate/default_norm_hours are taken from settings.
 *
 * Инвариант 6: создание периода не изменяет тот, откуда копировали — предыдущий
 * период здесь только читается.
 */
export async function getOrCreatePeriod(
  db: TimeoDB,
  userId: string,
  year: number,
  month: number,
  settings: Pick<Settings, "default_base_rate" | "default_norm_hours">,
): Promise<Period> {
  // Read and create in a single rw transaction: without this, two parallel calls
  // (e.g. a repeated effect invocation in React StrictMode) would both fail to find
  // the period and each would create its own row, duplicating the period for one year+month.
  return db.transaction("rw", db.periods, async () => {
    const existing = await findPeriod(db, userId, year, month);
    if (existing) return existing;

    const previous = await findPreviousExistingPeriod(db, userId, year, month);

    const now = new Date().toISOString();
    const period: Period = {
      id: crypto.randomUUID(),
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      year,
      month,
      base_rate: previous ? previous.base_rate : settings.default_base_rate,
      norm_hours: previous ? previous.norm_hours : settings.default_norm_hours,
      extra_amount: 0,
      extra_note: "",
      is_closed: false,
      closed_totals: null,
      is_manual: false,
    };

    await db.periods.add(period);
    return period;
  });
}

/**
 * Точечная правка полей периода (норма часов, extra_amount/extra_note).
 * base_rate сюда намеренно не проходит: его смена — это раздел 6.6 с диалогом
 * и пересчётом записей, см. applyBaseRateChange.
 */
export async function updatePeriod(
  db: TimeoDB,
  id: string,
  patch: Partial<Pick<Period, "norm_hours" | "extra_amount" | "extra_note">>,
): Promise<void> {
  // Инвариант 2 держится не только на disabled в разметке: экран мог быть
  // отрисован до закрытия периода (или период закрыли на другом устройстве), и
  // тогда уже набранный текст дописался бы в зафиксированный месяц.
  await db.transaction("rw", db.periods, async () => {
    const period = await db.periods.get(id);
    if (!period || period.is_closed) return;
    await db.periods.update(id, { ...patch, updated_at: new Date().toISOString() });
  });
}

export interface BaseRateChangeParams {
  year: number;
  month: number;
  newBaseRate: number;
  mode: RateChangeMode;
  /** Только для режима apply_from_date. */
  fromDateISO: string | null;
  periodStartDay: number;
}

export interface BaseRateChangeResult {
  updatedEntries: number;
  /** Период закрыт — не изменено ничего (инвариант 2). */
  skippedClosed: boolean;
}

async function listPeriodEntries(
  db: TimeoDB,
  userId: string,
  startISO: string,
  endISO: string,
): Promise<Entry[]> {
  return db.entries
    .where("date")
    .between(startISO, endISO, true, true)
    .filter((entry) => entry.user_id === userId && entry.deleted_at === null)
    .toArray();
}

/**
 * Раздел 6.6 ТЗ. Всё — чтение записей, планирование и запись — внутри одной
 * rw-транзакции: инвариант 14 требует «либо все затронутые записи обновлены,
 * либо ни одна», а между отдельным чтением и отдельной записью успевает
 * вклиниться правка из открытой шторки дня, и в базу лёг бы пересчёт по
 * устаревшему часу.
 */
export async function applyBaseRateChange(
  db: TimeoDB,
  userId: string,
  params: BaseRateChangeParams,
): Promise<BaseRateChangeResult> {
  const { start, end } = getPeriodDateRange(params.year, params.month, params.periodStartDay);
  const startISO = toISODate(start);
  const endISO = toISODate(end);
  const newBaseRate = roundMoney(params.newBaseRate);

  return db.transaction("rw", db.periods, db.entries, db.day_types, db.settings, async () => {
    const period = await findPeriod(db, userId, params.year, params.month);
    if (!period) return { updatedEntries: 0, skippedClosed: false };
    if (period.is_closed) return { updatedEntries: 0, skippedClosed: true };

    const now = new Date().toISOString();

    // Выбранный режим запоминается всегда — диалог по разделу 6.6 показывается
    // каждый раз, запомненный ответ лишь предвыбран.
    const settingsRow = await db.settings.where("user_id").equals(userId).first();
    if (settingsRow) {
      const settingsPatch: Partial<Settings> = {
        preferred_rate_change_mode: params.mode,
        updated_at: now,
      };
      // «Со следующего периода»: текущий период не трогаем вовсе, новое
      // значение уходит в settings.default_base_rate — ровно так, как описан
      // режим в разделе 6.6.
      //
      // ВНИМАНИЕ, открытый вопрос к заказчику. Раздел 6.6 обещает, что значение
      // «подхватится при создании следующего периода», но по разделу 5.2 новый
      // период копируется из предыдущего, а default_base_rate участвует только
      // когда предыдущего периода нет вообще. То есть после первого же месяца
      // этот режим фактически ни на что не влияет. Противоречие в ТЗ, а не в
      // коде: чинится либо флагом «ожидающая ставка» в модели, либо правкой
      // правила копирования — и то и другое меняет согласованное поведение,
      // поэтому здесь реализовано буквально по разделу 6.6.
      if (params.mode === "apply_next_period") settingsPatch.default_base_rate = newBaseRate;
      await db.settings.update(settingsRow.id, settingsPatch);
    }

    if (params.mode === "apply_next_period") return { updatedEntries: 0, skippedClosed: false };

    const entries = await listPeriodEntries(db, userId, startISO, endISO);
    const dayTypes = await db.day_types.where("user_id").equals(userId).toArray();

    const patches = planRateChange({
      mode: params.mode,
      newBaseRate,
      entries,
      dayTypeById: new Map(dayTypes.map((dt) => [dt.id, dt])),
      periodStartISO: startISO,
      periodEndISO: endISO,
      fromDateISO: params.fromDateISO,
    });

    await db.periods.update(period.id, { base_rate: newBaseRate, updated_at: now });
    for (const patch of patches) {
      const { id, ...fields } = patch;
      await db.entries.update(id, { ...fields, updated_at: now });
    }

    return { updatedEntries: patches.length, skippedClosed: false };
  });
}

/**
 * Раздел 6.5: закрытие периода фиксирует итоги в closed_totals, после чего
 * calculatePeriodTotals перестаёт суммировать записи и отдаёт снимок.
 * Снимок считается внутри транзакции, а не приходит с экрана: между рендером
 * панели итогов и нажатием кнопки запись дня успевает измениться, и в
 * closed_totals легла бы сумма, которой на экране уже нет.
 */
export async function closePeriod(
  db: TimeoDB,
  userId: string,
  year: number,
  month: number,
  periodStartDay: number,
): Promise<void> {
  const { start, end } = getPeriodDateRange(year, month, periodStartDay);
  const startISO = toISODate(start);
  const endISO = toISODate(end);

  await db.transaction("rw", db.periods, db.entries, db.day_types, async () => {
    const period = await findPeriod(db, userId, year, month);
    if (!period || period.is_closed) return;

    const entries = await listPeriodEntries(db, userId, startISO, endISO);
    const dayTypes = await db.day_types.where("user_id").equals(userId).toArray();
    const totals = calculatePeriodTotals(period, entries, new Map(dayTypes.map((dt) => [dt.id, dt])));

    await db.periods.update(period.id, {
      is_closed: true,
      closed_totals: {
        amount: totals.amount,
        total_hours: totals.total_hours,
        norm_hours_covered: totals.norm_hours_covered,
      },
      updated_at: new Date().toISOString(),
    });
  });
}

/**
 * Инвариант 3: closed_totals переживает переоткрытие — снимок остаётся рядом с
 * живым итогом, чтобы было с чем сравнить «до» и «после» правки.
 */
export async function reopenPeriod(db: TimeoDB, userId: string, year: number, month: number): Promise<void> {
  await db.transaction("rw", db.periods, async () => {
    const period = await findPeriod(db, userId, year, month);
    if (!period || !period.is_closed) return;
    await db.periods.update(period.id, { is_closed: false, updated_at: new Date().toISOString() });
  });
}

/**
 * Инвариант 4: period_start_day нельзя менять, пока существует хоть один
 * закрытый период — сдвиг границы переставил бы дни между уже
 * зафиксированными месяцами. Экран настроек появится в блоке 7; функция
 * живёт здесь, чтобы правило хранилось рядом с данными, а не в UI.
 */
export async function hasClosedPeriods(db: TimeoDB, userId: string): Promise<boolean> {
  const count = await db.periods
    .where("user_id")
    .equals(userId)
    .filter((period) => period.is_closed && period.deleted_at === null)
    .count();
  return count > 0;
}
