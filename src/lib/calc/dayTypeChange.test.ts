import { describe, expect, it } from "vitest";
import { hasFinancialChange, planDayTypeChange, type EntryDayTypePatch } from "@/lib/calc/dayTypeChange";
import { makeDayType, makeEntry, makeHoliday, makePeriod } from "@/test/factories";
import type { Entry, Holiday } from "@/types/models";

const PERIOD_START = "2026-08-01";
const PERIOD_END = "2026-08-31";
const period = makePeriod({ base_rate: 30 });
const weekendMultipliers = { saturday: 1.5, sunday: 2, holiday: 2.5 };

function plan(
  dayType = makeDayType(),
  entries: Entry[] = [],
  holidays: Holiday[] = [],
): EntryDayTypePatch[] {
  return planDayTypeChange({
    dayType,
    entries,
    period,
    periodStartISO: PERIOD_START,
    periodEndISO: PERIOD_END,
    holidayByDate: new Map(holidays.map((h) => [h.date, h])),
    weekendMultipliers,
  });
}

describe("hasFinancialChange", () => {
  it("считает косметику косметикой: имя, цвет, значок, заметка и порядок ничего не пересчитывают", () => {
    const before = makeDayType();
    const after = makeDayType({
      name: "Другое имя",
      color: "#ffffff",
      label: "Д",
      note: "описание",
      sort_order: 5,
      is_archived: true,
    });

    expect(hasFinancialChange(before, after)).toBe(false);
  });

  it("узнаёт каждое финансовое поле раздела 6.7", () => {
    const before = makeDayType();
    const cases = [
      { pay_mode: "unpaid" as const },
      { rate_mode: "pinned" as const },
      { fixed_amount: 100 },
      { default_multiplier: 2 },
      { default_rate: 50 },
      { default_hours: 12 },
      { default_start: "09:00" },
      { default_end: "17:00" },
      { default_break_minutes: 30 },
      { default_break_paid_minutes: 15 },
      { counts_as_work: false },
      { counts_toward_norm: false },
      { ignore_auto_multipliers: true },
    ];

    for (const patch of cases) {
      expect(hasFinancialChange(before, makeDayType(patch))).toBe(true);
    }
  });
});

describe("planDayTypeChange", () => {
  it("пересчитывает записи текущего периода по новому множителю типа дня", () => {
    const dayType = makeDayType({ default_multiplier: 1.5 });
    const entry = makeEntry({ date: "2026-08-10", multiplier: 1, rate_per_hour: 30, amount: 240 });

    expect(plan(dayType, [entry])).toEqual([
      {
        id: entry.id,
        multiplier: 1.5,
        rate_per_hour: 30,
        rate_is_manual: false,
        amount: 360, // 8 × 30 × 1.5
        rate_source: "period_base",
      },
    ]);
  });

  it("не трогает записи за пределами текущего периода (инвариант 1, раздел 6.7)", () => {
    // Прошлый месяц не включается никогда, даже по явному согласию: правка
    // прошлого делается отдельно, с экрана того периода.
    const dayType = makeDayType({ default_multiplier: 2 });
    const past = makeEntry({ id: "e-past", date: "2026-07-31" });
    const future = makeEntry({ id: "e-future", date: "2026-09-01" });

    expect(plan(dayType, [past, future])).toEqual([]);
  });

  it("исключает записи с ручной ставкой и ручной суммой (инварианты 8 и 9)", () => {
    const dayType = makeDayType({ default_multiplier: 2 });
    const manualRate = makeEntry({ id: "e-manual", date: "2026-08-10", rate_is_manual: true, rate_per_hour: 50 });
    const override = makeEntry({ id: "e-override", date: "2026-08-11", amount_override: 500, amount: 500 });

    expect(plan(dayType, [manualRate, override])).toEqual([]);
  });

  it("не трогает записи чужих типов дня и удалённые записи", () => {
    const dayType = makeDayType({ default_multiplier: 2 });
    const other = makeEntry({ id: "e-other", date: "2026-08-10", day_type_id: "dt-other" });
    const deleted = makeEntry({ id: "e-deleted", date: "2026-08-11", deleted_at: "2026-08-11T10:00:00.000Z" });

    expect(plan(dayType, [other, deleted])).toEqual([]);
  });

  it("оставляет часы записи как есть: default_hours — шаблон для новых, а не факт прошлого", () => {
    // Человек отработал 6 часов. Новый шаблон типа дня — 12. Часы в журнале
    // остаются 6, меняется только то, что из них посчитано.
    const dayType = makeDayType({ default_hours: 12, default_multiplier: 2 });
    const entry = makeEntry({ date: "2026-08-10", hours: 6, multiplier: 1, amount: 180 });

    const patches = plan(dayType, [entry]);
    expect(patches).toHaveLength(1);
    expect(patches[0].amount).toBe(360); // 6 × 30 × 2, а не 12 × 30 × 2
    expect(patches[0]).not.toHaveProperty("hours");
  });

  it("правка времён/перерыва по умолчанию не даёт ни одного патча: они финансовые (раздел 6.7), но влияют только на новые записи", () => {
    // hasFinancialChange для этих полей — true (см. выше), поэтому экран
    // покажет вопрос "обновить N записей?", но само число N всегда 0: они не
    // входят в формулу суммы существующей записи вовсе.
    const dayType = makeDayType({
      default_start: "09:00",
      default_end: "17:00",
      default_break_minutes: 30,
      default_break_paid_minutes: 15,
      default_multiplier: 1,
    });
    const entry = makeEntry({ date: "2026-08-10", hours: 6, multiplier: 1, rate_per_hour: 30, amount: 180 });

    expect(plan(dayType, [entry])).toEqual([]);
  });

  it("не выпускает патч, когда пересчёт дал те же числа (инвариант 13)", () => {
    const dayType = makeDayType({ default_multiplier: 1 });
    const entry = makeEntry({ date: "2026-08-10", multiplier: 1, rate_per_hour: 30, amount: 240 });

    expect(plan(dayType, [entry])).toEqual([]);
  });

  it("идемпотентен: второй прогон подряд не меняет ничего", () => {
    const dayType = makeDayType({ default_multiplier: 1.5 });
    const entry = makeEntry({ date: "2026-08-10", multiplier: 1, amount: 240 });

    const first = plan(dayType, [entry]);
    const updated: Entry = { ...entry, ...first[0], id: entry.id };
    expect(plan(dayType, [updated])).toEqual([]);
  });

  it("применяет правило праздника и выходного к пересчитанным записям (раздел 6.2)", () => {
    const dayType = makeDayType({ default_multiplier: 1.2 });
    // 2 августа 2026 — воскресенье, 3 августа — понедельник.
    const sunday = makeEntry({ id: "e-sun", date: "2026-08-02", multiplier: 1, amount: 240 });
    const monday = makeEntry({ id: "e-mon", date: "2026-08-03", multiplier: 1, amount: 240 });
    const holiday = makeEntry({ id: "e-hol", date: "2026-08-15", multiplier: 1, amount: 240 });

    const patches = plan(dayType, [sunday, monday, holiday], [makeHoliday({ date: "2026-08-15" })]);
    const byId = new Map(patches.map((p) => [p.id, p]));
    expect(byId.get("e-sun")?.multiplier).toBe(2);
    expect(byId.get("e-mon")?.multiplier).toBe(1.2);
    expect(byId.get("e-hol")?.multiplier).toBe(2.5);
  });

  it("закрытие замка отвязывает записи от базовой ставки и снимает множитель", () => {
    // Раздел 6.2 + 6.3: ставка берётся у типа дня, множитель не применяется,
    // и запись помечается rate_is_manual — дальше её не тронет ни смена
    // базовой ставки (инвариант 9), ни следующая правка типа дня.
    const dayType = makeDayType({ rate_mode: "pinned", default_rate: 50, default_multiplier: 2 });
    const entry = makeEntry({ date: "2026-08-02", multiplier: 1, rate_per_hour: 30, amount: 240 });

    expect(plan(dayType, [entry])).toEqual([
      {
        id: entry.id,
        multiplier: 1,
        rate_per_hour: 50,
        rate_is_manual: true,
        amount: 400, // 8 × 50, без множителя и без правила воскресенья
        rate_source: "type_pinned",
      },
    ]);
  });

  it("не даёт закрытому замку с пустой ставкой утащить сумму на базовую ставку периода", () => {
    const dayType = makeDayType({ rate_mode: "pinned", default_rate: null });
    const entry = makeEntry({ date: "2026-08-10", amount: 240 });

    const patches = plan(dayType, [entry]);
    expect(patches[0].rate_per_hour).toBe(0);
    expect(patches[0].amount).toBe(0);
  });

  it("считает unpaid и fixed_amount по разделу 6.4, а не по часам и ставке", () => {
    const unpaid = plan(makeDayType({ pay_mode: "unpaid" }), [makeEntry({ date: "2026-08-10", amount: 240 })]);
    expect(unpaid[0].amount).toBe(0);

    const fixed = plan(makeDayType({ pay_mode: "fixed_amount", fixed_amount: 120 }), [
      makeEntry({ date: "2026-08-10", amount: 240 }),
    ]);
    expect(fixed[0].amount).toBe(120);
  });

  it("пропускает запись с датой, из которой период не выводится", () => {
    // Такая строка могла приехать импортом или синхронизацией. Гадать на
    // платёжном журнале нельзя — запись просто не трогаем.
    const dayType = makeDayType({ default_multiplier: 2 });
    // Дата внутри границ периода лексикографически ("1x" между "01" и "31"),
    // но числом не разбирается — иначе проверку съел бы фильтр диапазона и
    // ветка разбора даты осталась бы непройденной.
    const broken = makeEntry({ date: "2026-08-1x", amount: 240 });

    expect(plan(dayType, [broken])).toEqual([]);
  });
});
