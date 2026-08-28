import { describe, expect, it } from "vitest";
import {
  applyMultiplierEdit,
  applyRateEdit,
  buildEntryDefaultsForDayType,
  calculateEntryAmount,
} from "@/lib/calc/entry";
import type { DayType } from "@/types/models";

const period = { base_rate: 20 };
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
    is_archived: false,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<Parameters<typeof calculateEntryAmount>[0]> = {}) {
  return {
    amount_override: null,
    hours: 8,
    multiplier: 1,
    rate_per_hour: 0,
    rate_is_manual: false,
    ...overrides,
  };
}

describe("calculateEntryAmount", () => {
  it("amount_override wins over everything else, regardless of pay_mode", () => {
    const entry = makeEntry({ amount_override: 999, hours: 8, multiplier: 2 });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.amount).toBe(999);
  });

  it("unpaid day type always yields zero", () => {
    const entry = makeEntry({ hours: 8 });
    const dayType = { pay_mode: "unpaid" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.amount).toBe(0);
  });

  it("fixed_amount uses the day type's fixed amount regardless of hours", () => {
    const entry = makeEntry({ hours: 3 });
    const dayType = { pay_mode: "fixed_amount" as const, fixed_amount: 150 };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.amount).toBe(150);
  });

  it("fixed_amount with a null amount defaults to zero rather than throwing", () => {
    const entry = makeEntry();
    const dayType = { pay_mode: "fixed_amount" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.amount).toBe(0);
  });

  it("hourly with an automatic rate derives rate_per_hour from base_rate * multiplier and writes it back", () => {
    const entry = makeEntry({ hours: 8, multiplier: 1.5, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.rate_per_hour).toBe(30); // 20 * 1.5
    expect(result.amount).toBe(240); // 8 * 30
  });

  it("hourly with a manual rate uses rate_per_hour as-is, ignoring base_rate and multiplier", () => {
    const entry = makeEntry({ hours: 8, multiplier: 1.5, rate_is_manual: true, rate_per_hour: 100 });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.rate_per_hour).toBe(100);
    expect(result.amount).toBe(800); // 8 * 100
  });

  it("allows a zero base_rate without dividing by zero or throwing", () => {
    const entry = makeEntry({ hours: 8, multiplier: 2, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, { base_rate: 0 });
    expect(result.rate_per_hour).toBe(0);
    expect(result.amount).toBe(0);
  });

  it("rounds money to two decimals instead of leaking float tails into the entry", () => {
    // Воспроизведение бага: base_rate 33.3 и пресет «Ночная смена» (×1.5) давали
    // rate_per_hour 49.949999999999996 и amount 399.59999999999997 прямо в поле ввода.
    const entry = makeEntry({ hours: 8, multiplier: 1.5, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, { base_rate: 33.3 });
    expect(result.rate_per_hour).toBe(49.95);
    expect(result.amount).toBe(399.6);
  });

  it("rounds the rate before multiplying by hours, not after", () => {
    // 8 × 49.949999… снова даёт хвост, если округлять только итог.
    const entry = makeEntry({ hours: 8, multiplier: 3, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, { base_rate: 33.3 });
    expect(result.rate_per_hour).toBe(99.9);
    expect(result.amount).toBe(799.2);
  });

  it("does not block negative hours or negative override amounts (section 8: no hard validation)", () => {
    const entry = makeEntry({ amount_override: -50 });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.amount).toBe(-50);
  });
});

describe("buildEntryDefaultsForDayType", () => {
  it("derives an automatic rate from base_rate * resolved multiplier when default_rate is unset", () => {
    // 2026-01-05 is a Monday: no weekend/holiday rule, default_multiplier=1 -> "default" source.
    const dayType = makeDayType({ default_hours: 8, default_multiplier: 1 });
    const result = buildEntryDefaultsForDayType(new Date(2026, 0, 5), dayType, period, undefined, weekendMultipliers);

    expect(result.rate_is_manual).toBe(false);
    expect(result.multiplier).toBe(1);
    expect(result.rate_per_hour).toBe(20);
    expect(result.amount).toBe(160);
    expect(result.rate_source).toBe("period_base");
    expect(result.multiplier_source).toBe("default");
  });

  it("applies the weekend multiplier and reports it as weekend_rule", () => {
    // 2026-01-04 is a Sunday.
    const dayType = makeDayType();
    const result = buildEntryDefaultsForDayType(new Date(2026, 0, 4), dayType, period, undefined, weekendMultipliers);

    expect(result.multiplier).toBe(2);
    expect(result.rate_per_hour).toBe(40);
    expect(result.rate_source).toBe("weekend_rule");
  });

  it("treats a day type's own default_rate as a manual rate that ignores base_rate", () => {
    const dayType = makeDayType({ default_rate: 35, default_multiplier: 1.5 });
    const result = buildEntryDefaultsForDayType(new Date(2026, 0, 5), dayType, period, undefined, weekendMultipliers);

    expect(result.rate_is_manual).toBe(true);
    expect(result.rate_per_hour).toBe(35);
    expect(result.amount).toBe(35 * dayType.default_hours);
    expect(result.rate_source).toBe("manual");
  });

  it("respects fixed_amount pay mode regardless of hours/multiplier", () => {
    const dayType = makeDayType({ pay_mode: "fixed_amount", fixed_amount: 200, default_hours: 8 });
    const result = buildEntryDefaultsForDayType(new Date(2026, 0, 5), dayType, period, undefined, weekendMultipliers);

    expect(result.amount).toBe(200);
  });

  it("day type opting out of auto multipliers keeps its own multiplier even on a holiday", () => {
    const dayType = makeDayType({ ignore_auto_multipliers: true, default_multiplier: 1 });
    const holiday = {
      id: "h-1",
      user_id: "user-1",
      created_at: "",
      updated_at: "",
      deleted_at: null,
      date: "2026-01-01",
      name: "Новый год",
      is_custom: false,
    };
    const result = buildEntryDefaultsForDayType(new Date(2026, 0, 1), dayType, period, holiday, weekendMultipliers);

    expect(result.multiplier).toBe(1);
    // Подавление сработало (множитель праздника 2.5 не применён), но ×1 не
    // подписывается как множитель типа дня — см. resolveMultiplier.
    expect(result.multiplier_source).toBe("default");
    expect(result.rate_source).toBe("period_base");
  });
});

// --- Раздел 5.3.1: множитель и ставка связаны в обе стороны -------------------

const hourly = makeDayType();
const autoDefault = { value: 1, source: "default" } as const;

function makeLinked(overrides: Partial<Parameters<typeof applyMultiplierEdit>[0]> = {}) {
  return {
    hours: 8,
    multiplier: 1,
    rate_per_hour: 0,
    rate_is_manual: false,
    amount_override: null,
    rate_source: "period_base" as const,
    ...overrides,
  };
}

describe("applyMultiplierEdit", () => {
  it("пересчитывает ставку из базовой ставки периода и возвращает её в авто-режим", () => {
    const entry = makeLinked({ rate_per_hour: 50, rate_is_manual: true, rate_source: "manual" });

    const result = applyMultiplierEdit(entry, 2, hourly, { base_rate: 20 }, autoDefault);

    expect(result.rate_per_hour).toBe(40);
    expect(result.rate_is_manual).toBe(false);
    expect(result.amount).toBe(320);
  });

  it("не обнуляет ставку, введённую вручную, когда базовая ставка периода равна нулю", () => {
    // Регрессия: пользователь набрал ставку 50 на периоде без базовой ставки,
    // затем поправил множитель — ставка обнулялась, потому что авто-режим
    // считал её как 0 × multiplier.
    const entry = makeLinked({ rate_per_hour: 50, rate_is_manual: true, rate_source: "manual" });

    const result = applyMultiplierEdit(entry, 2, hourly, { base_rate: 0 }, autoDefault);

    expect(result.rate_per_hour).toBe(50);
    expect(result.rate_is_manual).toBe(true);
    expect(result.rate_source).toBe("manual");
    expect(result.multiplier).toBe(2);
    expect(result.amount).toBe(400);
  });

  it("при нулевой базовой ставке не переводит авто-ставку в ручную", () => {
    // Иначе запись навсегда выпала бы из пересчёта по инварианту 9, и заданная
    // позже базовая ставка периода до неё уже не дошла бы.
    const result = applyMultiplierEdit(makeLinked(), 2, hourly, { base_rate: 0 }, autoDefault);

    expect(result.rate_is_manual).toBe(false);
    expect(result.rate_per_hour).toBe(0);
  });

  it("подписывает источник авто-правилом, когда значение совпало с ним", () => {
    const auto = { value: 2, source: "sunday" } as const;

    const result = applyMultiplierEdit(makeLinked(), 2, hourly, { base_rate: 20 }, auto);

    expect(result.rate_source).toBe("weekend_rule");
  });

  it("подписывает источник ставкой периода, когда значение задано вручную", () => {
    const auto = { value: 2, source: "sunday" } as const;

    const result = applyMultiplierEdit(makeLinked(), 1.7, hourly, { base_rate: 20 }, auto);

    expect(result.rate_source).toBe("period_base");
  });

  it("не трогает сумму записи с ручной суммой (инвариант 8)", () => {
    const entry = makeLinked({ amount_override: 999 });

    const result = applyMultiplierEdit(entry, 3, hourly, { base_rate: 20 }, autoDefault);

    expect(result.amount).toBe(999);
  });
});

describe("applyRateEdit", () => {
  it("выводит множитель из ставки и базовой ставки периода", () => {
    const result = applyRateEdit(makeLinked(), 40, hourly, { base_rate: 20 });

    expect(result.multiplier).toBe(2);
    expect(result.rate_per_hour).toBe(40);
    expect(result.rate_is_manual).toBe(true);
    expect(result.rate_source).toBe("manual");
    expect(result.amount).toBe(320);
  });

  it("оставляет множитель как есть, когда базовая ставка равна нулю", () => {
    const result = applyRateEdit(makeLinked({ multiplier: 1.5 }), 50, hourly, { base_rate: 0 });

    expect(result.multiplier).toBe(1.5);
    expect(result.rate_per_hour).toBe(50);
    expect(result.amount).toBe(400);
  });

  it("округляет множитель до тысячных, а не тащит хвост деления", () => {
    const result = applyRateEdit(makeLinked(), 50, hourly, { base_rate: 33.3 });

    expect(result.multiplier).toBe(1.502);
  });

  it("ставка и обратно множитель переживают круговой обход без потери значения", () => {
    const afterRate = applyRateEdit(makeLinked(), 40, hourly, { base_rate: 20 });
    const afterMultiplier = applyMultiplierEdit(
      { ...makeLinked(), ...afterRate },
      afterRate.multiplier,
      hourly,
      { base_rate: 20 },
      autoDefault,
    );

    expect(afterMultiplier.rate_per_hour).toBe(40);
  });
});
