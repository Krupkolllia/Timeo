import type { DayType, Entry, Period } from "@/types/models";

export interface PeriodTotals {
  amount: number;
  total_hours: number;
  norm_hours_covered: number;
  remaining_to_norm: number;
}

export function calculatePeriodTotals(
  _period: Pick<Period, "extra_amount" | "norm_hours">,
  _entries: Entry[],
  _dayTypeById: Map<string, Pick<DayType, "counts_as_work" | "counts_toward_norm">>,
): PeriodTotals {
  throw new Error("not implemented");
}

export function periodForDate(_date: Date, _periodStartDay: number): { year: number; month: number } {
  throw new Error("not implemented");
}
