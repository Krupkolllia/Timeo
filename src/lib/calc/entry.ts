import type { DayType, Entry, Holiday, Period, RateSource, WeekendMultipliers } from "@/types/models";
import { resolveMultiplier, type MultiplierResult } from "@/lib/calc/multiplier";
import { roundMoney } from "@/lib/calc/round";

/**
 * Раздел 6.4 ТЗ. amount_override побеждает всё остальное; иначе расчёт зависит
 * от pay_mode типа дня.
 *
 * Множитель НЕ входит в ставку. Ставка — это ставка: базовая ставка периода
 * либо вписанная руками, и ровно её пользователь видит в поле «ставка за час».
 * Множитель — отдельный коэффициент, который применяется только в момент
 * расчёта суммы за день:
 *
 *     сумма = часы × ставка × множитель
 *
 * Раньше ставка считалась как base_rate × multiplier и записывалась обратно в
 * поле. Из-за этого на периоде без базовой ставки множитель не делал ничего:
 * умножать было не на что, и вписанная руками ставка им не пользовалась.
 *
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

  // Ставка округляется отдельно: это значение хранится и показывается в поле.
  // Сумма округляется один раз на итоговом произведении (инвариант 18), а не
  // по шагам — иначе 8 × 33.33 × 1.5 копит хвост на каждом умножении.
  const rate_per_hour = roundMoney(entry.rate_is_manual ? entry.rate_per_hour : period.base_rate);
  return { amount: roundMoney(entry.hours * rate_per_hour * entry.multiplier), rate_per_hour };
}

/**
 * rate_source (раздел 5.4) описывает происхождение СТАВКИ, и после отделения
 * множителя от ставки вариантов ровно два: её вписал человек либо она равна
 * базовой ставке периода. Праздник, выходной и тип дня теперь объясняют
 * множитель, а не ставку, и живут в MultiplierResult.source — подпись под полем
 * множителя берётся оттуда.
 *
 * Значения "weekend_rule" / "holiday_rule" / "day_type_default" остаются в
 * модели: они лежат в записях, созданных до этой правки, и экран расшифровки
 * обязан их отрисовать. Новых таких записей не появляется.
 */
export function mapRateSource(rateIsManual: boolean): RateSource {
  return rateIsManual ? "manual" : "period_base";
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
  const provisionalRate = rate_is_manual ? dayType.default_rate! : period.base_rate;

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
    rate_source: mapRateSource(rate_is_manual),
    multiplier_source: multiplierResult.source,
  };
}

/** Поля записи после правки множителя или ставки. */
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
 * Пользователь правит МНОЖИТЕЛЬ. Ставка при этом не меняется вообще: множитель
 * не входит в ставку и применяется только при расчёте суммы за день
 * (см. calculateEntryAmount). Поэтому поле «ставка за час» показывает всё то же
 * число, а пересчитывается одна сумма.
 *
 * Из-за прежней связи «ставка = база × множитель» правка множителя затирала
 * вписанную руками ставку, а на периоде без базовой ставки не делала ничего.
 * Обеих проблем больше нет: связывать нечего.
 */
export function applyMultiplierEdit(
  entry: LinkedFieldsEntry,
  multiplier: number,
  dayType: Pick<DayType, "pay_mode" | "fixed_amount">,
  period: Pick<Period, "base_rate">,
): LinkedFieldsResult {
  const { amount, rate_per_hour } = calculateEntryAmount({ ...entry, multiplier }, dayType, period);
  return {
    multiplier,
    rate_per_hour,
    rate_is_manual: entry.rate_is_manual,
    amount,
    rate_source: entry.rate_source,
  };
}

/**
 * Пользователь правит СТАВКУ. Множитель не трогается: это независимый
 * коэффициент, а не производное от ставки значение.
 *
 * rate_is_manual становится true — по разделу 6.3 вписанная человеком ставка
 * перестаёт зависеть от базовой ставки периода, и смена базовой ставки её уже
 * не пересчитает (инвариант 9).
 */
export function applyRateEdit(
  entry: LinkedFieldsEntry,
  rate: number,
  dayType: Pick<DayType, "pay_mode" | "fixed_amount">,
  period: Pick<Period, "base_rate">,
): LinkedFieldsResult {
  const { amount, rate_per_hour } = calculateEntryAmount(
    { ...entry, rate_per_hour: rate, rate_is_manual: true },
    dayType,
    period,
  );

  return {
    multiplier: entry.multiplier,
    rate_per_hour,
    rate_is_manual: true,
    amount,
    rate_source: mapRateSource(true),
  };
}
