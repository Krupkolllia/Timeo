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

  it("ставка равна базовой ставке периода — множитель в неё не входит", () => {
    const entry = makeEntry({ hours: 8, multiplier: 1.5, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.rate_per_hour).toBe(20);
    expect(result.amount).toBe(240); // 8 × 20 × 1.5
  });

  it("множитель применяется и к ставке, вписанной руками", () => {
    const entry = makeEntry({ hours: 8, multiplier: 1.5, rate_is_manual: true, rate_per_hour: 100 });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.rate_per_hour).toBe(100);
    expect(result.amount).toBe(1200); // 8 × 100 × 1.5
  });

  it("множитель работает и без базовой ставки периода, если ставка вписана руками", () => {
    // Ровно тот случай, ради которого множитель отделён от ставки: на свежем
    // периоде base_rate = 0, и прежняя формула base_rate × multiplier делала
    // множитель бесполезным.
    const entry = makeEntry({ hours: 8, multiplier: 2, rate_is_manual: true, rate_per_hour: 50 });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, { base_rate: 0 });
    expect(result.rate_per_hour).toBe(50);
    expect(result.amount).toBe(800);
  });

  it("нулевая базовая ставка без ручной ставки даёт ноль, а не падение", () => {
    const entry = makeEntry({ hours: 8, multiplier: 2, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, { base_rate: 0 });
    expect(result.rate_per_hour).toBe(0);
    expect(result.amount).toBe(0);
  });

  it("множитель ноль — это законный неоплачиваемый день (инвариант 23)", () => {
    const entry = makeEntry({ hours: 8, multiplier: 0, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, period);
    expect(result.rate_per_hour).toBe(20);
    expect(result.amount).toBe(0);
  });

  it("округляет деньги до сотых, а не тащит float-хвост в запись", () => {
    // Воспроизведение бага: base_rate 33.3 и пресет «Ночная смена» (×1.5) давали
    // amount 399.59999999999997 прямо в поле ввода.
    const entry = makeEntry({ hours: 8, multiplier: 1.5, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, { base_rate: 33.3 });
    expect(result.rate_per_hour).toBe(33.3);
    expect(result.amount).toBe(399.6);
  });

  it("округляет сумму один раз на итоговом произведении (инвариант 18)", () => {
    const entry = makeEntry({ hours: 8, multiplier: 3, rate_is_manual: false });
    const dayType = { pay_mode: "hourly" as const, fixed_amount: null };
    const result = calculateEntryAmount(entry, dayType, { base_rate: 33.3 });
    expect(result.rate_per_hour).toBe(33.3);
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
  it("берёт базовую ставку периода, когда у типа дня нет собственной", () => {
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

  it("подставляет воскресный множитель, не трогая ставку", () => {
    // 2026-01-04 is a Sunday.
    const dayType = makeDayType();
    const result = buildEntryDefaultsForDayType(new Date(2026, 0, 4), dayType, period, undefined, weekendMultipliers);

    expect(result.multiplier).toBe(2);
    // Ставка остаётся базовой ставкой периода: правило выходного объясняет
    // множитель, а не ставку, поэтому и rate_source — «ставка периода».
    expect(result.rate_per_hour).toBe(20);
    expect(result.amount).toBe(320); // 8 × 20 × 2
    expect(result.rate_source).toBe("period_base");
    expect(result.multiplier_source).toBe("sunday");
  });

  it("собственная ставка типа дня считается ручной и не зависит от базовой", () => {
    const dayType = makeDayType({ default_rate: 35, default_multiplier: 1.5 });
    const result = buildEntryDefaultsForDayType(new Date(2026, 0, 5), dayType, period, undefined, weekendMultipliers);

    expect(result.rate_is_manual).toBe(true);
    expect(result.rate_per_hour).toBe(35);
    expect(result.amount).toBe(420); // 8 × 35 × 1.5
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
  it("не трогает ставку — множитель в неё не входит", () => {
    const entry = makeLinked({ rate_per_hour: 50, rate_is_manual: true, rate_source: "manual" });

    const result = applyMultiplierEdit(entry, 2, hourly, { base_rate: 20 });

    expect(result.rate_per_hour).toBe(50);
    expect(result.rate_is_manual).toBe(true);
    expect(result.rate_source).toBe("manual");
    expect(result.amount).toBe(800); // 8 × 50 × 2
  });

  it("работает на периоде без базовой ставки, если ставка вписана руками", () => {
    // Тот самый случай: раньше множитель здесь не делал ничего, потому что
    // ставка считалась как base_rate × multiplier = 0.
    const entry = makeLinked({ rate_per_hour: 50, rate_is_manual: true, rate_source: "manual" });

    const result = applyMultiplierEdit(entry, 2, hourly, { base_rate: 0 });

    expect(result.rate_per_hour).toBe(50);
    expect(result.amount).toBe(800);
  });

  it("пересчитывает сумму от базовой ставки периода, когда ставка автоматическая", () => {
    const result = applyMultiplierEdit(makeLinked(), 1.5, hourly, { base_rate: 20 });

    expect(result.rate_per_hour).toBe(20);
    expect(result.amount).toBe(240); // 8 × 20 × 1.5
    expect(result.rate_is_manual).toBe(false);
    expect(result.rate_source).toBe("period_base");
  });

  it("не трогает сумму записи с ручной суммой (инвариант 8)", () => {
    const entry = makeLinked({ amount_override: 999 });

    const result = applyMultiplierEdit(entry, 3, hourly, { base_rate: 20 });

    expect(result.amount).toBe(999);
  });
});

describe("applyRateEdit", () => {
  it("записывает ставку как ручную и не трогает множитель", () => {
    const result = applyRateEdit(makeLinked({ multiplier: 1.5 }), 40, hourly, { base_rate: 20 });

    expect(result.multiplier).toBe(1.5);
    expect(result.rate_per_hour).toBe(40);
    expect(result.rate_is_manual).toBe(true);
    expect(result.rate_source).toBe("manual");
    expect(result.amount).toBe(480); // 8 × 40 × 1.5
  });

  it("не зависит от базовой ставки периода", () => {
    const result = applyRateEdit(makeLinked({ multiplier: 2 }), 50, hourly, { base_rate: 0 });

    expect(result.multiplier).toBe(2);
    expect(result.rate_per_hour).toBe(50);
    expect(result.amount).toBe(800);
  });

  it("правка ставки и множителя в любом порядке даёт один и тот же результат", () => {
    const first = applyMultiplierEdit(
      { ...makeLinked(), ...applyRateEdit(makeLinked(), 40, hourly, { base_rate: 20 }) },
      2,
      hourly,
      { base_rate: 20 },
    );
    const second = applyRateEdit(
      { ...makeLinked(), ...applyMultiplierEdit(makeLinked(), 2, hourly, { base_rate: 20 }) },
      40,
      hourly,
      { base_rate: 20 },
    );

    expect(first.amount).toBe(640); // 8 × 40 × 2
    expect(second.amount).toBe(first.amount);
    expect(second.rate_per_hour).toBe(first.rate_per_hour);
    expect(second.multiplier).toBe(first.multiplier);
  });
});
