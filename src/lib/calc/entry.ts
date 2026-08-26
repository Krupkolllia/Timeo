import type { DayType, Entry, Period } from "@/types/models";

export function calculateEntryAmount(
  _entry: Pick<Entry, "amount_override" | "hours" | "multiplier" | "rate_per_hour" | "rate_is_manual">,
  _dayType: Pick<DayType, "pay_mode" | "fixed_amount">,
  _period: Pick<Period, "base_rate">,
): { amount: number; rate_per_hour: number } {
  throw new Error("not implemented");
}
