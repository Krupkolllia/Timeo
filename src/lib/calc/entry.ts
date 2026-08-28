import type { DayType, Entry, Holiday, Period, RateSource, WeekendMultipliers } from "@/types/models";
import { resolveMultiplier, type MultiplierResult } from "@/lib/calc/multiplier";

/**
 * Раздел 6.1 ТЗ. amount_override побеждает всё остальное; иначе расчёт зависит
 * от pay_mode типа дня. Для hourly с rate_is_manual=false ставка выводится из
 * base_rate периода × multiplier и записывается обратно в rate_per_hour —
 * именно так по разделу 5.4 запись остаётся пересчитываемой при смене ставки.
 */
export function calculateEntryAmount(
  entry: Pick<Entry, "amount_override" | "hours" | "multiplier" | "rate_per_hour" | "rate_is_manual">,
  dayType: Pick<DayType, "pay_mode" | "fixed_amount">,
  period: Pick<Period, "base_rate">,
): { amount: number; rate_per_hour: number } {
  if (entry.amount_override !== null && entry.amount_override !== undefined) {
    return { amount: entry.amount_override, rate_per_hour: entry.rate_per_hour };
  }

  if (dayType.pay_mode === "unpaid") {
    return { amount: 0, rate_per_hour: entry.rate_per_hour };
  }

  if (dayType.pay_mode === "fixed_amount") {
    return { amount: dayType.fixed_amount ?? 0, rate_per_hour: entry.rate_per_hour };
  }

  const rate_per_hour = entry.rate_is_manual ? entry.rate_per_hour : period.base_rate * entry.multiplier;
  return { amount: entry.hours * rate_per_hour, rate_per_hour };
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
