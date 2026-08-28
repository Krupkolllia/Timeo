import type { DayType, Holiday, WeekendMultipliers } from "@/types/models";

export interface MultiplierResult {
  value: number;
  source: "day_type_ignore" | "holiday" | "sunday" | "saturday" | "day_type_default" | "default";
}

/**
 * Раздел 6.2 ТЗ. Порядок правил фиксирован, первое сработавшее побеждает —
 * множители никогда не перемножаются (воскресная ночная смена не даёт ×3).
 */
export function resolveMultiplier(
  date: Date,
  dayType: DayType,
  holiday: Holiday | undefined,
  weekendMultipliers: WeekendMultipliers,
): MultiplierResult {
  if (dayType.ignore_auto_multipliers) {
    return { value: dayType.default_multiplier, source: "day_type_ignore" };
  }

  if (holiday) {
    return { value: weekendMultipliers.holiday, source: "holiday" };
  }

  const weekday = date.getDay();
  if (weekday === 0) {
    return { value: weekendMultipliers.sunday, source: "sunday" };
  }
  if (weekday === 6) {
    return { value: weekendMultipliers.saturday, source: "saturday" };
  }

  // default_multiplier всегда задан числом в модели (пресеты используют 1 как
  // нейтральное значение), поэтому шаг 5 формально сработал бы всегда. Различаем
  // источник по значению: ровно 1.0 не несёт информации и подписывается как
  // "default", а не как множитель типа дня — иначе на экране дня для обычного
  // рабочего дня появлялась бы бессмысленная подпись "рабочий день, ×1".
  if (dayType.default_multiplier !== 1) {
    return { value: dayType.default_multiplier, source: "day_type_default" };
  }

  return { value: 1, source: "default" };
}
