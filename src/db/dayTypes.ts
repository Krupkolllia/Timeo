import type { TimeoDB } from "@/db/schema";
import type { DayType } from "@/types/models";

type PresetDayType = Pick<
  DayType,
  | "name"
  | "color"
  | "icon"
  | "pay_mode"
  | "fixed_amount"
  | "counts_as_work"
  | "counts_toward_norm"
  | "default_hours"
  | "default_multiplier"
  | "default_rate"
  | "ignore_auto_multipliers"
  | "sort_order"
>;

// Section 5.3 of the spec. ignore_auto_multipliers=true for vacation/sick leave/day off —
// otherwise a day-off that falls on vacation would suddenly get paid at the day-off multiplier.
export const PRESET_DAY_TYPES: PresetDayType[] = [
  {
    name: "Рабочий день",
    color: "#38bdf8",
    icon: "briefcase",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 0,
  },
  {
    name: "Ночная смена",
    color: "#818cf8",
    icon: "moon",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1.5,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 1,
  },
  {
    name: "Отпуск",
    color: "#4ade80",
    icon: "palm-tree",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: false,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: true,
    sort_order: 2,
  },
  {
    name: "Больничный",
    color: "#fb923c",
    icon: "stethoscope",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: false,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: true,
    sort_order: 3,
  },
  {
    name: "Отгул",
    color: "#a3a3a3",
    icon: "coffee",
    pay_mode: "unpaid",
    fixed_amount: null,
    counts_as_work: false,
    counts_toward_norm: false,
    default_hours: 0,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: true,
    sort_order: 4,
  },
  {
    name: "Выходной",
    color: "#f87171",
    icon: "bed",
    pay_mode: "unpaid",
    fixed_amount: null,
    counts_as_work: false,
    counts_toward_norm: false,
    default_hours: 0,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 5,
  },
];

export async function ensureDayTypesSeeded(db: TimeoDB, userId: string): Promise<void> {
  // The rw transaction makes check-then-insert atomic: without it, two parallel
  // calls (e.g. a double effect invocation in React StrictMode) would both see
  // an empty table and each would seed its own set of presets — duplicates.
  return db.transaction("rw", db.day_types, async () => {
    const existing = await db.day_types.where("user_id").equals(userId).count();
    if (existing > 0) return;

    const now = new Date().toISOString();
    await db.day_types.bulkAdd(
      PRESET_DAY_TYPES.map((preset) => ({
        ...preset,
        id: crypto.randomUUID(),
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        is_archived: false,
      })),
    );
  });
}
