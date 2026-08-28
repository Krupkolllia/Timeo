import type { DayType, Entry, Period, PeriodNaming } from "@/types/models";
import { roundHours, roundMoney } from "@/lib/calc/round";

export interface PeriodTotals {
  amount: number;
  total_hours: number;
  norm_hours_covered: number;
  remaining_to_norm: number;
}

export interface PeriodId {
  year: number;
  month: number;
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function clampDayToMonth(year: number, monthIndex0: number, day: number): number {
  return Math.min(day, daysInMonth(year, monthIndex0));
}

export function calculatePeriodTotals(
  period: Pick<Period, "extra_amount" | "norm_hours">,
  entries: Entry[],
  dayTypeById: Map<string, Pick<DayType, "counts_as_work" | "counts_toward_norm">>,
): PeriodTotals {
  let amount = period.extra_amount;
  let total_hours = 0;
  let norm_hours_covered = 0;

  for (const entry of entries) {
    const dayType = dayTypeById.get(entry.day_type_id);
    amount += entry.amount;
    if (dayType?.counts_as_work) total_hours += entry.hours;
    if (dayType?.counts_toward_norm) norm_hours_covered += entry.hours;
  }

  // Округляем на выходе, а не в цикле: сумма уже округлённых значений всё
  // равно дрейфует, а копить надо сырые числа.
  return {
    amount: roundMoney(amount),
    total_hours: roundHours(total_hours),
    norm_hours_covered: roundHours(norm_hours_covered),
    remaining_to_norm: roundHours(period.norm_hours - norm_hours_covered),
  };
}

/**
 * Periods don't store a reference to a date — the period identifier (year/month) is always
 * recomputed. The identifier is always tied to the month in which the period
 * starts (period_naming affects only the displayed label, see getPeriodLabel).
 */
export function periodForDate(date: Date, periodStartDay: number): PeriodId {
  const calendarYear = date.getFullYear();
  const calendarMonthIndex0 = date.getMonth();
  const startDay = clampDayToMonth(calendarYear, calendarMonthIndex0, periodStartDay);

  let year = calendarYear;
  let month = calendarMonthIndex0 + 1;

  if (date.getDate() < startDay) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }

  return { year, month };
}

export function getPeriodDateRange(year: number, month: number, periodStartDay: number): { start: Date; end: Date } {
  const monthIndex0 = month - 1;
  const startDay = clampDayToMonth(year, monthIndex0, periodStartDay);
  const start = new Date(year, monthIndex0, startDay);

  const nextStartDay = clampDayToMonth(year, monthIndex0 + 1, periodStartDay);
  const end = new Date(year, monthIndex0 + 1, nextStartDay - 1);

  return { start, end };
}

export function getAdjacentPeriod(year: number, month: number, delta: number): PeriodId {
  const total = year * 12 + (month - 1) + delta;
  const resultYear = Math.floor(total / 12);
  const resultMonth = total - resultYear * 12 + 1;
  return { year: resultYear, month: resultMonth };
}

/**
 * period_naming determines only the period's label in the UI, not its identifier:
 * otherwise flipping the setting retroactively would move records between rows of periods.
 */
export function getPeriodLabel(year: number, month: number, periodStartDay: number, periodNaming: PeriodNaming): PeriodId {
  if (periodNaming === "start_month") return { year, month };

  const { end } = getPeriodDateRange(year, month, periodStartDay);
  return { year: end.getFullYear(), month: end.getMonth() + 1 };
}

/**
 * Inverse of getPeriodLabel — turns a label chosen by the user
 * (e.g. the month in the picker, where they see the label, not the identifier)
 * back into a period identifier. Needed so that UI showing the label
 * doesn't confuse it with the year/month from periods when period_naming = "end_month".
 */
export function getPeriodIdentityFromLabel(
  labelYear: number,
  labelMonth: number,
  periodStartDay: number,
  periodNaming: PeriodNaming,
): PeriodId {
  if (periodNaming === "start_month" || periodStartDay === 1) return { year: labelYear, month: labelMonth };

  return getAdjacentPeriod(labelYear, labelMonth, -1);
}
