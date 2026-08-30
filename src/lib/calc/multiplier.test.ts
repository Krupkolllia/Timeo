import { describe, expect, it } from "vitest";
import { resolveMultiplier } from "@/lib/calc/multiplier";
import type { DayType, Holiday } from "@/types/models";

const weekendMultipliers = { saturday: 1.5, sunday: 2, holiday: 2.5 };

function makeDayType(overrides: Partial<DayType> = {}): DayType {
  return {
    id: "dt-1",
    user_id: "user-1",
    created_at: "",
    updated_at: "",
    deleted_at: null,
    name: "Рабочий день",
    color: "#000",
    label: "Р",
    note: "",
    rate_mode: "multiplier",
    pay_mode: "hourly",
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
    sort_order: 0,
    is_archived: false,
    ...overrides,
  };
}

function makeHoliday(): Holiday {
  return {
    id: "h-1",
    user_id: "user-1",
    created_at: "",
    updated_at: "",
    deleted_at: null,
    date: "2026-01-01",
    name: "Новый год",
    is_custom: false,
  };
}

describe("resolveMultiplier", () => {
  it("returns 1.0 with source default for a weekday work day with no special rules", () => {
    // 2026-01-05 is a Monday.
    const result = resolveMultiplier(new Date(2026, 0, 5), makeDayType(), undefined, weekendMultipliers);
    expect(result).toEqual({ value: 1, source: "default" });
  });

  it("applies the day type's own multiplier on a weekday when it differs from 1", () => {
    const dayType = makeDayType({ default_multiplier: 1.5 });
    const result = resolveMultiplier(new Date(2026, 0, 5), dayType, undefined, weekendMultipliers);
    expect(result).toEqual({ value: 1.5, source: "day_type_default" });
  });

  it("applies the saturday multiplier", () => {
    // 2026-01-03 is a Saturday.
    const result = resolveMultiplier(new Date(2026, 0, 3), makeDayType(), undefined, weekendMultipliers);
    expect(result).toEqual({ value: 1.5, source: "saturday" });
  });

  it("applies the sunday multiplier", () => {
    // 2026-01-04 is a Sunday.
    const result = resolveMultiplier(new Date(2026, 0, 4), makeDayType(), undefined, weekendMultipliers);
    expect(result).toEqual({ value: 2, source: "sunday" });
  });

  it("applies the holiday multiplier and it wins over the weekend rule", () => {
    // 2026-01-04 is also a Sunday, holiday must still win (rule order).
    const result = resolveMultiplier(new Date(2026, 0, 4), makeDayType(), makeHoliday(), weekendMultipliers);
    expect(result).toEqual({ value: 2.5, source: "holiday" });
  });

  it("ignores holiday/weekend rules entirely when ignore_auto_multipliers is set", () => {
    const dayType = makeDayType({ ignore_auto_multipliers: true, default_multiplier: 1 });
    // Sunday + holiday, both would normally apply, but the day type opts out (vacation on a holiday).
    const result = resolveMultiplier(new Date(2026, 0, 4), dayType, makeHoliday(), weekendMultipliers);
    // ×1 is labelled "default": suppression still happened (value stays 1 rather
    // than the sunday/holiday multiplier), but "тип дня, ×1" carries no information.
    expect(result).toEqual({ value: 1, source: "default" });
  });

  it("still reports day_type_ignore when the opted-out day type has a multiplier of its own", () => {
    const dayType = makeDayType({ ignore_auto_multipliers: true, default_multiplier: 0.8 });
    const result = resolveMultiplier(new Date(2026, 0, 4), dayType, makeHoliday(), weekendMultipliers);
    expect(result).toEqual({ value: 0.8, source: "day_type_ignore" });
  });

  it("never multiplies rules together — sunday + day type multiplier does not compound", () => {
    // Night shift (×1.5 default) falling on a Sunday (×2): result must be exactly the sunday
    // multiplier, not 1.5 * 2 = 3 — this is the invariant from section 6.2.
    const dayType = makeDayType({ default_multiplier: 1.5 });
    const result = resolveMultiplier(new Date(2026, 0, 4), dayType, undefined, weekendMultipliers);
    expect(result.value).toBe(2);
    expect(result.source).toBe("sunday");
  });

  it("закрытый замок отменяет любой множитель (раздел 6.2, первое правило)", () => {
    // Правило стоит первым и побеждает всё остальное: у типа со своей ставкой
    // множителя нет вовсе, иначе воскресный коэффициент лёг бы поверх уже
    // готовой ставки.
    const pinned = makeDayType({ rate_mode: "pinned", default_rate: 55, default_multiplier: 2 });

    // Воскресенье 4 января 2026 — правило выходного дало бы ×2.
    expect(resolveMultiplier(new Date(2026, 0, 4), pinned, undefined, weekendMultipliers)).toEqual({
      value: 1,
      source: "pinned",
    });
    // Праздник — тоже.
    expect(
      resolveMultiplier(new Date(2026, 0, 5), pinned, makeHoliday(), weekendMultipliers),
    ).toEqual({ value: 1, source: "pinned" });
    // И собственный множитель типа дня.
    expect(resolveMultiplier(new Date(2026, 0, 5), pinned, undefined, weekendMultipliers).value).toBe(1);
  });
});
