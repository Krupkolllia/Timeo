import type { DayTypeDraft } from "@/db/dayTypes";

// Раздел 5.3: «один из 12–16 значений палитры, читаемых в обеих темах».
export const DAY_TYPE_COLORS = [
  "#38bdf8",
  "#818cf8",
  "#c084fc",
  "#f472b6",
  "#fb7185",
  "#f87171",
  "#fb923c",
  "#fbbf24",
  "#a3e635",
  "#4ade80",
  "#34d399",
  "#2dd4bf",
  "#22d3ee",
  "#a3a3a3",
];

export function emptyDayTypeDraft(): DayTypeDraft {
  // Раздел 8.5: «разумные значения по умолчанию — множитель 1, без времени,
  // почасовая оплата, считается рабочим днём и идёт в норму».
  return {
    name: "",
    color: DAY_TYPE_COLORS[0],
    label: "",
    note: "",
    pay_mode: "hourly",
    rate_mode: "multiplier",
    fixed_amount: null,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
  };
}
