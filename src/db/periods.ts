import { calculatePeriodTotals, getAdjacentPeriod, getPeriodDateRange, periodForDate } from "@/lib/calc/period";
import { planRateChange } from "@/lib/calc/rateChange";
import { toISODate } from "@/lib/calc/calendarGrid";
import { roundMoney } from "@/lib/calc/round";
import type { TimeoDB } from "@/db/schema";
import type { Entry, Period, RateChangeMode, Settings } from "@/types/models";

/**
 * Период месяца, кроме мягко удалённых (инвариант 38: удалённые строки
 * исключены из каждого запроса). Удалить период можно ровно одним способом —
 * убрав исторический месяц на экране прошлых периодов (раздел 8.7), — и без
 * этого фильтра удалённый месяц продолжал бы показываться и находиться.
 *
 * Экраны читают периоды тем же запросом (findLivePeriodQuery), чтобы правило
 * жило в одном месте.
 */
export function findLivePeriodQuery(db: TimeoDB, userId: string, year: number, month: number) {
  return db.periods
    .where("[user_id+year+month]")
    .equals([userId, year, month])
    .filter((period) => period.deleted_at === null);
}

function findPeriod(db: TimeoDB, userId: string, year: number, month: number) {
  return findLivePeriodQuery(db, userId, year, month).first();
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
 *
 * Ручные периоды (раздел 8.7) источником копирования не являются. У такого
 * периода нет записей и никто никогда не вводил его базовую ставку — человек
 * вписал итог за месяц, а не час. Скопировать её значило бы завести следующий
 * месяц по ставке, которой не существовало: записав май 2026 как исторический,
 * пользователь получал июнь с base_rate = 0 при default_base_rate = 30, и
 * каждый июньский день молча считался по нулю.
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
    if (candidate.deleted_at !== null || candidate.is_manual) continue;
    const ordinal = periodOrdinal(candidate.year, candidate.month);
    if (ordinal >= target || ordinal <= bestOrdinal) continue;
    best = candidate;
    bestOrdinal = ordinal;
  }
  return best;
}

/**
 * Раздел 6.6 — режим «применить со следующего периода». Обычное правило
 * раздела 5.2 (копировать ставку у предыдущего периода) отдало бы новому
 * периоду старую ставку, и решение «с сентября я получаю 60» потерялось бы
 * молча: default_base_rate по разделу 5.2 читается, только когда предыдущего
 * периода нет вовсе.
 *
 * Поэтому default_base_rate перебивает копирование ровно в одном случае: сам
 * создаваемый период не раньше отмеченного, а тот период, у которого мы
 * собираемся копировать, — раньше. Второе условие и есть точка остановки:
 * как только сентябрь создан, октябрь копирует уже у него, и дальнейшая
 * правка сентябрьской ставки на его собственном экране не перезаписывается
 * настройкой задним числом.
 *
 * Периоды раньше отмеченного (пользователь ушёл в прошлое) правило не
 * затрагивает — иначе «со следующего периода» переписывало бы историю.
 */
function resolveNewPeriodBaseRate(
  year: number,
  month: number,
  previous: Period | undefined,
  settings: Pick<Settings, "default_base_rate" | "default_base_rate_from_period">,
): number {
  const from = settings.default_base_rate_from_period;
  if (from) {
    const fromOrdinal = periodOrdinal(from.year, from.month);
    const targetReached = periodOrdinal(year, month) >= fromOrdinal;
    const previousPredatesDecision = !previous || periodOrdinal(previous.year, previous.month) < fromOrdinal;
    if (targetReached && previousPredatesDecision) return settings.default_base_rate;
  }
  return previous ? previous.base_rate : settings.default_base_rate;
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
  settings: Pick<Settings, "default_base_rate" | "default_norm_hours" | "default_base_rate_from_period">,
): Promise<Period> {
  // Read and create in a single rw transaction: without this, two parallel calls
  // (e.g. a repeated effect invocation in React StrictMode) would both fail to find
  // the period and each would create its own row, duplicating the period for one year+month.
  return db.transaction("rw", db.periods, async () => {
    const existing = await findPeriod(db, userId, year, month);
    if (existing) return existing;

    const previous = await findPreviousExistingPeriod(db, userId, year, month);

    const now = new Date().toISOString();
    const base_rate = resolveNewPeriodBaseRate(year, month, previous, settings);
    const period: Period = {
      id: crypto.randomUUID(),
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      year,
      month,
      base_rate,
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
      // «Со следующего периода»: ни одна запись текущего периода не трогается,
      // новое значение уходит в settings.default_base_rate вместе с отметкой,
      // с какого периода оно действует. Без отметки режим был бы пустышкой —
      // см. resolveNewPeriodBaseRate.
      //
      // Уже существующий следующий период при этом не переписывается: его
      // записи пересчитаны не будут, и period.base_rate разошёлся бы с суммами
      // в собственных строках месяца. Такой период правится на своём экране,
      // и диалог об этом прямо предупреждает.
      if (params.mode === "apply_next_period") {
        settingsPatch.default_base_rate = newBaseRate;
        settingsPatch.default_base_rate_from_period = getAdjacentPeriod(params.year, params.month, 1);
      }
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
 * Закрыт ли период, которому принадлежит дата (инвариант 2). Вызывается из
 * слоя записей перед каждой правкой, поэтому построен на точечных чтениях по
 * индексам, без выборок.
 *
 * Отсутствие строки настроек или строки периода трактуется как «открыт»: если
 * периода в базе нет, его никто не закрывал, и запрещать нечего.
 */
export async function isDateInClosedPeriod(db: TimeoDB, userId: string, dateISO: string): Promise<boolean> {
  const settings = await db.settings.where("user_id").equals(userId).first();
  if (!settings) return false;

  // Дату разбираем вручную: new Date("2026-08-10") — это UTC-полночь, и на
  // положительном смещении она превращается в 10 августа местного времени
  // только случайно (инвариант 27).
  const [year, month, day] = dateISO.split("-").map(Number);
  const id = periodForDate(new Date(year, month - 1, day), settings.period_start_day);
  const period = await findPeriod(db, userId, id.year, id.month);
  return period?.is_closed === true;
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
