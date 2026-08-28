import { describe, expect, it } from "vitest";
import {
  calculatePeriodTotals,
  getAdjacentPeriod,
  getPeriodDateRange,
  getPeriodIdentityFromLabel,
  getPeriodLabel,
  periodForDate,
} from "@/lib/calc/period";
import type { DayType, Entry, Period } from "@/types/models";

describe("periodForDate", () => {
  it("treats calendar month as the period when period_start_day is 1", () => {
    expect(periodForDate(new Date(2026, 0, 1), 1)).toEqual({ year: 2026, month: 1 });
    expect(periodForDate(new Date(2026, 0, 31), 1)).toEqual({ year: 2026, month: 1 });
  });

  it("assigns dates before the start day to the previous month's period", () => {
    // period_start_day=15: Aug 1-14 belongs to the period that started in July.
    expect(periodForDate(new Date(2026, 7, 10), 15)).toEqual({ year: 2026, month: 7 });
    expect(periodForDate(new Date(2026, 7, 15), 15)).toEqual({ year: 2026, month: 8 });
  });

  it("wraps around the year boundary", () => {
    expect(periodForDate(new Date(2026, 0, 5), 15)).toEqual({ year: 2025, month: 12 });
  });

  it("clamps a period_start_day that exceeds the days in a short month", () => {
    // period_start_day=30 in February: Feb only has 28 days in 2026, so the
    // period starts on Feb 28 — Feb 27 still belongs to January's period.
    expect(periodForDate(new Date(2026, 1, 27), 30)).toEqual({ year: 2026, month: 1 });
    expect(periodForDate(new Date(2026, 1, 28), 30)).toEqual({ year: 2026, month: 2 });
  });

  it("is never affected by a change unrelated to the same period (isolation sanity check)", () => {
    const before = periodForDate(new Date(2026, 5, 20), 1);
    const after = periodForDate(new Date(2026, 5, 20), 1);
    expect(after).toEqual(before);
  });
});

describe("getPeriodDateRange", () => {
  it("spans a full calendar month when period_start_day is 1", () => {
    const { start, end } = getPeriodDateRange(2026, 2, 1);
    expect(start).toEqual(new Date(2026, 1, 1));
    expect(end).toEqual(new Date(2026, 1, 28));
  });

  it("spans across a calendar month boundary for a mid-month start day", () => {
    const { start, end } = getPeriodDateRange(2026, 8, 15);
    expect(start).toEqual(new Date(2026, 7, 15));
    expect(end).toEqual(new Date(2026, 8, 14));
  });
});

describe("getAdjacentPeriod", () => {
  it("steps forward and backward across year boundaries", () => {
    expect(getAdjacentPeriod(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(getAdjacentPeriod(2027, 1, -1)).toEqual({ year: 2026, month: 12 });
  });
});

describe("getPeriodLabel", () => {
  it("returns the period identity as-is for start_month naming", () => {
    expect(getPeriodLabel(2026, 8, 15, "start_month")).toEqual({ year: 2026, month: 8 });
  });

  it("labels by the month the period ends in for end_month naming", () => {
    expect(getPeriodLabel(2026, 8, 15, "end_month")).toEqual({ year: 2026, month: 9 });
  });

  it("has no effect when period_start_day is 1 (start and end month coincide)", () => {
    expect(getPeriodLabel(2026, 3, 1, "end_month")).toEqual({ year: 2026, month: 3 });
  });
});

describe("getPeriodIdentityFromLabel", () => {
  it("round-trips with getPeriodLabel for start_month naming", () => {
    const identity = { year: 2026, month: 8 };
    const label = getPeriodLabel(identity.year, identity.month, 15, "start_month");
    expect(getPeriodIdentityFromLabel(label.year, label.month, 15, "start_month")).toEqual(identity);
  });

  it("round-trips with getPeriodLabel for end_month naming across a year boundary", () => {
    const identity = { year: 2026, month: 12 };
    const label = getPeriodLabel(identity.year, identity.month, 15, "end_month");
    expect(label).toEqual({ year: 2027, month: 1 });
    expect(getPeriodIdentityFromLabel(label.year, label.month, 15, "end_month")).toEqual(identity);
  });

  it("is a no-op when period_start_day is 1, matching getPeriodLabel", () => {
    expect(getPeriodIdentityFromLabel(2026, 3, 1, "end_month")).toEqual({ year: 2026, month: 3 });
  });
});

describe("calculatePeriodTotals", () => {
  const workDayType: Pick<DayType, "counts_as_work" | "counts_toward_norm"> = {
    counts_as_work: true,
    counts_toward_norm: true,
  };
  const vacationDayType: Pick<DayType, "counts_as_work" | "counts_toward_norm"> = {
    counts_as_work: false,
    counts_toward_norm: true,
  };

  type TotalsPeriod = Pick<Period, "extra_amount" | "norm_hours" | "is_closed" | "is_manual" | "closed_totals">;

  function makePeriod(overrides: Partial<TotalsPeriod> = {}): TotalsPeriod {
    return {
      extra_amount: 0,
      norm_hours: 160,
      is_closed: false,
      is_manual: false,
      closed_totals: null,
      ...overrides,
    };
  }

  function makeEntry(overrides: Partial<Entry>): Entry {
    return {
      id: "e",
      user_id: "u",
      created_at: "",
      updated_at: "",
      deleted_at: null,
      date: "2026-08-01",
      day_type_id: "work",
      hours: 8,
      multiplier: 1,
      rate_per_hour: 10,
      rate_is_manual: false,
      amount: 80,
      amount_override: null,
      start_time: null,
      end_time: null,
      break_minutes: null,
      note: "",
      rate_source: "period_base",
      ...overrides,
    };
  }

  it("sums entry amounts plus the period's extra_amount", () => {
    const dayTypeById = new Map([["work", workDayType]]);
    const entries = [makeEntry({ day_type_id: "work", amount: 80 }), makeEntry({ day_type_id: "work", amount: 100 })];

    const totals = calculatePeriodTotals(makePeriod({ extra_amount: 50 }), entries, dayTypeById);

    expect(totals.amount).toBe(230);
  });

  it("only counts hours toward total/norm per the day type flags", () => {
    const dayTypeById = new Map([
      ["work", workDayType],
      ["vacation", vacationDayType],
    ]);
    const entries = [
      makeEntry({ day_type_id: "work", hours: 8, amount: 80 }),
      makeEntry({ day_type_id: "vacation", hours: 8, amount: 80 }),
    ];

    const totals = calculatePeriodTotals(makePeriod(), entries, dayTypeById);

    expect(totals.total_hours).toBe(8);
    expect(totals.norm_hours_covered).toBe(16);
    expect(totals.remaining_to_norm).toBe(144);
  });

  it("rounds the accumulated total instead of leaking a float tail", () => {
    // 0.1 + 0.1 + 0.1 = 0.30000000000000004 без округления на выходе.
    const dayTypeById = new Map([["work", workDayType]]);
    const entries = [
      makeEntry({ day_type_id: "work", amount: 0.1, hours: 0.1 }),
      makeEntry({ day_type_id: "work", amount: 0.1, hours: 0.1 }),
      makeEntry({ day_type_id: "work", amount: 0.1, hours: 0.1 }),
    ];

    const totals = calculatePeriodTotals(makePeriod(), entries, dayTypeById);

    expect(totals.amount).toBe(0.3);
    expect(totals.total_hours).toBe(0.3);
    expect(totals.norm_hours_covered).toBe(0.3);
    expect(totals.remaining_to_norm).toBe(159.7);
  });

  it("uses the closed snapshot and ignores entries for a closed period (section 6.4)", () => {
    // Закрытие фиксирует итог: никакие изменения ставок и правил на него не влияют.
    const dayTypeById = new Map([["work", workDayType]]);
    const entries = [makeEntry({ day_type_id: "work", hours: 8, amount: 80 })];
    const period = makePeriod({
      is_closed: true,
      closed_totals: { amount: 4321, total_hours: 168, norm_hours_covered: 160 },
      extra_amount: 50,
    });

    const totals = calculatePeriodTotals(period, entries, dayTypeById);

    expect(totals).toEqual({ amount: 4321, total_hours: 168, norm_hours_covered: 160, remaining_to_norm: 0 });
  });

  it("returns zero totals for a manual period with no snapshot yet", () => {
    // У ручного периода записей не бывает вовсе — ноль честнее суммы по ним.
    const totals = calculatePeriodTotals(makePeriod({ is_manual: true }), [], new Map());

    expect(totals).toEqual({ amount: 0, total_hours: 0, norm_hours_covered: 0, remaining_to_norm: 160 });
  });

  it("falls back to summing entries for a closed period whose snapshot was never written", () => {
    // Защита от потери данных при незавершённом закрытии.
    const dayTypeById = new Map([["work", workDayType]]);
    const entries = [makeEntry({ day_type_id: "work", hours: 8, amount: 80 })];

    const totals = calculatePeriodTotals(makePeriod({ is_closed: true }), entries, dayTypeById);

    expect(totals.amount).toBe(80);
    expect(totals.total_hours).toBe(8);
  });

  it("returns zero totals with no entries, remaining_to_norm equal to norm_hours", () => {
    const totals = calculatePeriodTotals(makePeriod(), [], new Map());

    expect(totals).toEqual({ amount: 0, total_hours: 0, norm_hours_covered: 0, remaining_to_norm: 160 });
  });
});
