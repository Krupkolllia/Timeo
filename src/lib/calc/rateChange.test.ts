import { describe, expect, it } from "vitest";
import { planRateChange, type EntryRatePatch } from "@/lib/calc/rateChange";
import type { DayType, Entry } from "@/types/models";

const PERIOD_START = "2026-03-01";
const PERIOD_END = "2026-03-31";

const dayTypeById = new Map<string, Pick<DayType, "pay_mode" | "fixed_amount" | "rate_mode">>([
  ["hourly", { pay_mode: "hourly", fixed_amount: null, rate_mode: "multiplier" }],
  ["unpaid", { pay_mode: "unpaid", fixed_amount: null, rate_mode: "multiplier" }],
  ["fixed", { pay_mode: "fixed_amount", fixed_amount: 120, rate_mode: "multiplier" }],
  // Раздел 6.6: тип дня с закрытым замком из пересчёта исключён целиком.
  ["pinned", { pay_mode: "hourly", fixed_amount: null, rate_mode: "pinned" }],
]);

function entry(overrides: Partial<Entry> & Pick<Entry, "id" | "date">): Entry {
  return {
    user_id: "user-1",
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-01T00:00:00.000Z",
    deleted_at: null,
    day_type_id: "hourly",
    hours: 8,
    multiplier: 1,
    rate_per_hour: 30,
    rate_is_manual: false,
    amount: 240,
    amount_override: null,
    start_time: null,
    end_time: null,
    break_minutes: null,
    paid_break_minutes: null,
    duration_is_manual: false,
    note: "",
    rate_source: "period_base",
    ...overrides,
  };
}

function plan(
  mode: "recalculate_period" | "apply_from_date" | "apply_next_period",
  entries: Entry[],
  newBaseRate = 40,
  fromDateISO: string | null = null,
): EntryRatePatch[] {
  return planRateChange({
    mode,
    newBaseRate,
    entries,
    dayTypeById,
    periodStartISO: PERIOD_START,
    periodEndISO: PERIOD_END,
    fromDateISO,
  });
}

/** Применяет патчи к копиям записей — для проверки идемпотентности вторым прогоном. */
function applyPatches(entries: Entry[], patches: EntryRatePatch[]): Entry[] {
  const byId = new Map(patches.map((patch) => [patch.id, patch]));
  return entries.map((row) => {
    const patch = byId.get(row.id);
    return patch ? { ...row, ...patch } : row;
  });
}

describe("planRateChange — пересчёт всего периода", () => {
  it("пересчитывает обычную почасовую запись по новой базовой ставке", () => {
    const patches = plan("recalculate_period", [entry({ id: "a", date: "2026-03-10" })]);

    expect(patches).toEqual([
      { id: "a", rate_per_hour: 40, amount: 320, rate_is_manual: false, rate_source: "period_base" },
    ]);
  });

  it("ставит новую базовую ставку в поле, а множитель применяет к сумме", () => {
    const patches = plan("recalculate_period", [
      entry({ id: "a", date: "2026-03-10", multiplier: 1.5, rate_per_hour: 30, amount: 360 }),
    ]);

    // Множитель в ставку не входит: в поле оказывается ровно новая базовая
    // ставка, а ×1.5 участвует только в сумме.
    expect(patches[0].rate_per_hour).toBe(40);
    expect(patches[0].amount).toBe(480); // 8 × 40 × 1.5
  });

  it("не трогает записи с ручной ставкой (инвариант 9)", () => {
    const patches = plan("recalculate_period", [
      entry({ id: "a", date: "2026-03-10", rate_is_manual: true, rate_source: "manual" }),
    ]);

    expect(patches).toEqual([]);
  });

  it("не трогает записи с ручной суммой (инвариант 8)", () => {
    const patches = plan("recalculate_period", [
      entry({ id: "a", date: "2026-03-10", amount_override: 500, amount: 500 }),
    ]);

    expect(patches).toEqual([]);
  });

  it("не трогает записи неизвестного типа дня — считать их не по чему", () => {
    const patches = plan("recalculate_period", [entry({ id: "a", date: "2026-03-10", day_type_id: "gone" })]);

    expect(patches).toEqual([]);
  });

  it("не выпускает патч для unpaid и fixed_amount: их сумма от базовой ставки не зависит", () => {
    const patches = plan("recalculate_period", [
      entry({ id: "a", date: "2026-03-10", day_type_id: "unpaid", amount: 0 }),
      entry({ id: "b", date: "2026-03-11", day_type_id: "fixed", amount: 120 }),
    ]);

    expect(patches).toEqual([]);
  });

  it("пропускает мягко удалённые записи", () => {
    const patches = plan("recalculate_period", [
      entry({ id: "a", date: "2026-03-10", deleted_at: "2026-03-12T00:00:00.000Z" }),
    ]);

    expect(patches).toEqual([]);
  });

  it("второй прогон подряд не пишет ничего (инвариант 13 — идемпотентность)", () => {
    const entries = [entry({ id: "a", date: "2026-03-10" })];
    const first = plan("recalculate_period", entries);

    expect(plan("recalculate_period", applyPatches(entries, first))).toEqual([]);
  });
});

describe("planRateChange — изоляция периодов (инвариант 1)", () => {
  it("не трогает записи до начала и после конца периода", () => {
    const patches = plan("recalculate_period", [
      entry({ id: "before", date: "2026-02-28" }),
      entry({ id: "inside", date: "2026-03-01" }),
      entry({ id: "last", date: "2026-03-31" }),
      entry({ id: "after", date: "2026-04-01" }),
    ]);

    expect(patches.map((patch) => patch.id)).toEqual(["inside", "last"]);
  });

  it("режим «со следующего периода» не выпускает ни одного патча", () => {
    const patches = plan("apply_next_period", [
      entry({ id: "a", date: "2026-03-10" }),
      entry({ id: "b", date: "2026-03-20" }),
    ]);

    expect(patches).toEqual([]);
  });
});

describe("planRateChange — применение с даты", () => {
  it("замораживает записи до даты и пересчитывает остальные", () => {
    const patches = plan(
      "apply_from_date",
      [
        entry({ id: "before", date: "2026-03-09" }),
        entry({ id: "onDate", date: "2026-03-10" }),
        entry({ id: "after", date: "2026-03-20" }),
      ],
      40,
      "2026-03-10",
    );

    expect(patches).toEqual([
      { id: "before", rate_per_hour: 30, amount: 240, rate_is_manual: true, rate_source: "frozen" },
      { id: "onDate", rate_per_hour: 40, amount: 320, rate_is_manual: false, rate_source: "period_base" },
      { id: "after", rate_per_hour: 40, amount: 320, rate_is_manual: false, rate_source: "period_base" },
    ]);
  });

  it("не замораживает записи, чья сумма от ставки не зависит", () => {
    const patches = plan(
      "apply_from_date",
      [
        entry({ id: "unpaid", date: "2026-03-05", day_type_id: "unpaid", amount: 0 }),
        entry({ id: "fixed", date: "2026-03-06", day_type_id: "fixed", amount: 120 }),
      ],
      40,
      "2026-03-10",
    );

    expect(patches).toEqual([]);
  });

  it("не замораживает записи соседних периодов", () => {
    const patches = plan(
      "apply_from_date",
      [entry({ id: "before", date: "2026-02-20" }), entry({ id: "after", date: "2026-04-05" })],
      40,
      "2026-03-10",
    );

    expect(patches).toEqual([]);
  });

  it("дата, равная началу периода, ничего не замораживает", () => {
    const patches = plan("apply_from_date", [entry({ id: "a", date: "2026-03-01" })], 40, PERIOD_START);

    expect(patches).toEqual([
      { id: "a", rate_per_hour: 40, amount: 320, rate_is_manual: false, rate_source: "period_base" },
    ]);
  });

  it("второй прогон подряд не пишет ничего", () => {
    const entries = [entry({ id: "before", date: "2026-03-09" }), entry({ id: "after", date: "2026-03-20" })];
    const first = plan("apply_from_date", entries, 40, "2026-03-10");

    expect(plan("apply_from_date", applyPatches(entries, first), 40, "2026-03-10")).toEqual([]);
  });

  it("без даты вырождается в пересчёт всего периода", () => {
    const patches = plan("apply_from_date", [entry({ id: "a", date: "2026-03-02" })], 40, null);

    expect(patches[0].rate_is_manual).toBe(false);
    expect(patches[0].amount).toBe(320);
  });

  it("rewrites rate_source to period_base on recalculated entries (invariant 15)", () => {
    // Запись, созданная до отделения множителя от ставки: источником ставки
    // тогда считалось правило выходного дня. После пересчёта ставка выведена
    // из базовой ставки периода, и старая подпись описывала бы не то число.
    const legacy = entry({ id: "e1", date: "2026-03-10", rate_source: "weekend_rule" });
    const patches = plan("recalculate_period", [legacy]);

    expect(patches).toHaveLength(1);
    expect(patches[0].rate_source).toBe("period_base");
    expect(patches[0].rate_per_hour).toBe(40);
  });

  it("emits a patch for a stale rate_source even when the numbers do not change", () => {
    // Ставка та же — меняется только подпись о её происхождении. Без патча
    // запись навсегда осталась бы с чужим rate_source.
    const legacy = entry({ id: "e1", date: "2026-03-10", rate_source: "day_type_default" });
    const patches = plan("recalculate_period", [legacy], 30);

    expect(patches).toHaveLength(1);
    expect(patches[0].amount).toBe(240);
    expect(patches[0].rate_source).toBe("period_base");
  });

  it("stays idempotent after the rate_source rewrite (invariant 13)", () => {
    const legacy = entry({ id: "e1", date: "2026-03-10", rate_source: "holiday_rule" });
    const first = plan("recalculate_period", [legacy]);
    const second = plan("recalculate_period", applyPatches([legacy], first));

    expect(second).toEqual([]);
  });

  it("не пересчитывает записи типа дня с закрытым замком (раздел 6.6)", () => {
    // Запись создана, когда замок у типа был открыт, поэтому rate_is_manual на
    // ней ещё false. После закрытия замка её ставку объявил своей тип дня, и
    // смена базовой ставки периода не имеет к ней отношения.
    const row = entry({ id: "pinned-entry", date: "2026-03-10", day_type_id: "pinned" });

    expect(plan("recalculate_period", [row])).toEqual([]);
  });
});
