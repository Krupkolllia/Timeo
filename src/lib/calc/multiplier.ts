import type { DayType, Holiday, WeekendMultipliers } from "@/types/models";

export interface MultiplierResult {
  value: number;
  source: "day_type_ignore" | "holiday" | "sunday" | "saturday" | "day_type_default" | "default";
}

export function resolveMultiplier(
  _date: Date,
  _dayType: DayType,
  _holiday: Holiday | undefined,
  _weekendMultipliers: WeekendMultipliers,
): MultiplierResult {
  throw new Error("not implemented");
}
