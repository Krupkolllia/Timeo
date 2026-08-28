import type { DayType, Entry, Holiday, Period, RateSource, WeekendMultipliers } from "@/types/models";
import { resolveMultiplier, type MultiplierResult } from "@/lib/calc/multiplier";
import { roundMoney, roundMultiplier } from "@/lib/calc/round";

/**
 * Раздел 6.1 ТЗ. amount_override побеждает всё остальное; иначе расчёт зависит
 * от pay_mode типа дня. Для hourly с rate_is_manual=false ставка выводится из
 * base_rate периода × multiplier и записывается обратно в rate_per_hour —
 * именно так по разделу 5.4 запись остаётся пересчитываемой при смене ставки.
 * Округление живёт здесь, а не на слое отображения: в Dexie должны лежать
 * чистые значения, иначе поле «Сумма за день» показывает сырой float.
 */
export function calculateEntryAmount(
  entry: Pick<Entry, "amount_override" | "hours" | "multiplier" | "rate_per_hour" | "rate_is_manual">,
  dayType: Pick<DayType, "pay_mode" | "fixed_amount">,
  period: Pick<Period, "base_rate">,
): { amount: number; rate_per_hour: number } {
  if (entry.amount_override !== null && entry.amount_override !== undefined) {
    return { amount: roundMoney(entry.amount_override), rate_per_hour: entry.rate_per_hour };
  }

  if (dayType.pay_mode === "unpaid") {
    return { amount: 0, rate_per_hour: entry.rate_per_hour };
  }

  if (dayType.pay_mode === "fixed_amount") {
    return { amount: roundMoney(dayType.fixed_amount ?? 0), rate_per_hour: entry.rate_per_hour };
  }

  // Порядок важен: сначала округляем ставку, потом умножаем на часы — иначе
  // 8 × 49.949999… снова даёт хвост.
  const rate_per_hour = entry.rate_is_manual
    ? roundMoney(entry.rate_per_hour)
    : roundMoney(period.base_rate * entry.multiplier);
  return { amount: roundMoney(entry.hours * rate_per_hour), rate_per_hour };
}

/**
 * rate_source (раздел 5.4) описывает происхождение ставки для будущего экрана
 * расшифровки (Блок 5). Он грубее, чем MultiplierResult.source из раздела 6.2
 * (суббота/воскресенье схлопываются в одно "weekend_rule"), поэтому здесь
 * отдельная функция преобразования, а не переиспользование enum'а множителя.
 */
export function mapRateSource(multiplierSource: MultiplierResult["source"], rateIsManual: boolean): RateSource {
  if (rateIsManual) return "manual";
  switch (multiplierSource) {
    case "holiday":
      return "holiday_rule";
    case "sunday":
    case "saturday":
      return "weekend_rule";
    case "day_type_ignore":
    case "day_type_default":
      return "day_type_default";
    case "default":
      return "period_base";
  }
}

export interface EntryDefaults {
  hours: number;
  multiplier: number;
  rate_per_hour: number;
  rate_is_manual: boolean;
  amount: number;
  rate_source: RateSource;
  multiplier_source: MultiplierResult["source"];
}

/**
 * Значения, которыми заполняется запись при тапе по кнопке типа дня (раздел 7.2).
 * Чистая функция — никакого обращения к Dexie, только раздел 6.2 (множитель) и
 * 6.1 (сумма) плюс явное решение: если у типа дня задан default_rate, ставка
 * считается заданной вручную (rate_is_manual=true) и не зависит от base_rate —
 * это то же самое "как есть" правило, что и при ручной правке ставки на экране.
 */
export function buildEntryDefaultsForDayType(
  date: Date,
  dayType: DayType,
  period: Pick<Period, "base_rate">,
  holiday: Holiday | undefined,
  weekendMultipliers: WeekendMultipliers,
): EntryDefaults {
  const multiplierResult = resolveMultiplier(date, dayType, holiday, weekendMultipliers);
  const rate_is_manual = dayType.default_rate !== null;
  const provisionalRate = rate_is_manual ? dayType.default_rate! : period.base_rate * multiplierResult.value;

  const { amount, rate_per_hour } = calculateEntryAmount(
    {
      amount_override: null,
      hours: dayType.default_hours,
      multiplier: multiplierResult.value,
      rate_per_hour: provisionalRate,
      rate_is_manual,
    },
    dayType,
    period,
  );

  return {
    hours: dayType.default_hours,
    multiplier: multiplierResult.value,
    rate_per_hour,
    rate_is_manual,
    amount,
    rate_source: mapRateSource(multiplierResult.source, rate_is_manual),
    multiplier_source: multiplierResult.source,
  };
}

/** Связанные поля записи после правки множителя или ставки (раздел 5.3.1). */
export interface LinkedFieldsResult {
  multiplier: number;
  rate_per_hour: number;
  rate_is_manual: boolean;
  amount: number;
  rate_source: RateSource;
}

type LinkedFieldsEntry = Pick<
  Entry,
  "hours" | "multiplier" | "rate_per_hour" | "rate_is_manual" | "amount_override" | "rate_source"
>;

/**
 * Пользователь правит МНОЖИТЕЛЬ (раздел 5.3.1: поля связаны в обе стороны).
 * Ставка возвращается в авто-режим и выводится из base_rate × multiplier —
 * источник истины всегда базовая ставка периода.
 *
 * Кроме нулевой базовой ставки. Произведение тогда всегда 0, и авто-режим
 * стирал бы ставку, вписанную руками: набрал 50, поправил множитель — в поле
 * ноль. Выводить ставку не из чего, поэтому она остаётся как есть, ровно как
 * applyRateEdit оставляет множитель, когда делить не на что. Это та же
 * ситуация, что и в инварианте 22: при base_rate = 0 связь между полями
 * разорвана, и авторитетно то поле, которое заполнил человек.
 */
export function applyMultiplierEdit(
  entry: LinkedFieldsEntry,
  multiplier: number,
  dayType: Pick<DayType, "pay_mode" | "fixed_amount">,
  period: Pick<Period, "base_rate">,
  auto: MultiplierResult,
): LinkedFieldsResult {
  const canDeriveRate = period.base_rate !== 0;
  const rate_is_manual = canDeriveRate ? false : entry.rate_is_manual;
  const { amount, rate_per_hour } = calculateEntryAmount(
    { ...entry, multiplier, rate_is_manual },
    dayType,
    period,
  );

  // rate_source выводится из правила раздела 6.2: если введённое значение
  // совпадает с тем, что дало бы авто-правило (праздник/выходной/тип дня),
  // считаем его тем же источником; иначе это уже не привязано ни к какому
  // правилу, и ближайшее по смыслу значение — «ставка периода». При нулевой
  // базовой ставке ставку мы не трогали, значит и её происхождение прежнее.
  const rate_source = canDeriveRate
    ? mapRateSource(auto.value === multiplier ? auto.source : "default", false)
    : entry.rate_source;

  return { multiplier, rate_per_hour, rate_is_manual, amount, rate_source };
}

/**
 * Пользователь правит СТАВКУ. Она задаёт множитель = ставка / базовая ставка
 * периода — иначе на экране остаётся пара «×2 и 50 zł», которая при base_rate
 * 33.3 не может быть верной одновременно. При базовой ставке 0 делить не на
 * что, множитель остаётся как есть.
 *
 * rate_is_manual становится true: по разделу 6.3 вписанная человеком ставка
 * перестаёт зависеть от base_rate, и calculateEntryAmount возьмёт именно её.
 * Множитель здесь — производное значение для отображения и истории.
 */
export function applyRateEdit(
  entry: LinkedFieldsEntry,
  rate: number,
  dayType: Pick<DayType, "pay_mode" | "fixed_amount">,
  period: Pick<Period, "base_rate">,
): LinkedFieldsResult {
  const multiplier = period.base_rate !== 0 ? roundMultiplier(rate / period.base_rate) : entry.multiplier;
  const { amount, rate_per_hour } = calculateEntryAmount(
    { ...entry, multiplier, rate_per_hour: rate, rate_is_manual: true },
    dayType,
    period,
  );

  return { multiplier, rate_per_hour, rate_is_manual: true, amount, rate_source: mapRateSource("default", true) };
}
