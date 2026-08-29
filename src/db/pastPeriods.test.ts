import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/db";
import { listManualPeriods, removeManualPeriod, restoreManualPeriod, saveManualPeriod } from "@/db/pastPeriods";
import { getOrCreatePeriod, hasClosedPeriods } from "@/db/periods";
import { calculatePeriodTotals } from "@/lib/calc/period";
import { makeDayType, makeEntry, makePeriod, makeSettings, resetDb, USER_ID } from "@/test/factories";

const SETTINGS = { default_base_rate: 30, default_norm_hours: 160, period_start_day: 1 };

describe("saveManualPeriod", () => {
  beforeEach(resetDb);

  it("исторический месяц сохраняется закрытым, со снимком итогов и без записей (раздел 8.7)", async () => {
    const period = await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500.5 }, SETTINGS);

    expect(period).toMatchObject({ year: 2026, month: 5, is_manual: true, is_closed: true });
    expect(period.closed_totals).toEqual({ amount: 1500.5, total_hours: 100, norm_hours_covered: 100 });
    expect(await db.entries.count()).toBe(0);
  });

  it("итоги берутся из снимка, даже если в диапазоне месяца оказалась запись (инвариант 5)", async () => {
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500.5 }, SETTINGS);
    const dayType = makeDayType();
    await db.day_types.add(dayType);
    const stray = makeEntry({ id: "e-stray", date: "2026-05-11", hours: 8, amount: 240 });
    await db.entries.add(stray);

    const period = await db.periods.where("[user_id+year+month]").equals([USER_ID, 2026, 5]).first();
    const totals = calculatePeriodTotals(period!, [stray], new Map([[dayType.id, dayType]]));

    expect(totals.amount).toBe(1500.5);
    expect(totals.total_hours).toBe(100);
  });

  it("повторное сохранение того же месяца правит итоги, а не создаёт второй период", async () => {
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500 }, SETTINGS);
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 96, amount: 1450.25 }, SETTINGS);

    const rows = await db.periods.where("[user_id+year+month]").equals([USER_ID, 2026, 5]).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].closed_totals).toEqual({ amount: 1450.25, total_hours: 96, norm_hours_covered: 96 });
  });

  it("существующий обычный месяц становится ручным, его записи не трогаются", async () => {
    await db.periods.add(makePeriod({ id: "p-08", year: 2026, month: 8, base_rate: 33.3 }));
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-10" }));

    await saveManualPeriod(db, USER_ID, { year: 2026, month: 8, hours: 10, amount: 999 }, SETTINGS);

    expect(await db.periods.get("p-08")).toMatchObject({ is_manual: true, is_closed: true, base_rate: 33.3 });
    expect(await db.entries.get("e-1")).toBeTruthy();
  });

  it("ничего не блокируется: ноль часов, отрицательная сумма и месяц в будущем сохраняются (инвариант 54)", async () => {
    const zero = await saveManualPeriod(db, USER_ID, { year: 2026, month: 4, hours: 0, amount: 0 }, SETTINGS);
    const negative = await saveManualPeriod(db, USER_ID, { year: 2026, month: 3, hours: 8, amount: -500 }, SETTINGS);
    const future = await saveManualPeriod(db, USER_ID, { year: 2099, month: 12, hours: 8, amount: 100 }, SETTINGS);

    expect(zero.closed_totals?.amount).toBe(0);
    expect(negative.closed_totals?.amount).toBe(-500);
    expect(future.year).toBe(2099);
  });

  it("после первого исторического месяца день начала периода заблокирован (инвариант 4)", async () => {
    expect(await hasClosedPeriods(db, USER_ID)).toBe(false);
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500 }, SETTINGS);
    expect(await hasClosedPeriods(db, USER_ID)).toBe(true);
  });
});

describe("удаление исторического месяца", () => {
  beforeEach(resetDb);

  it("удаление мягкое, месяц исчезает из списка и снова разблокирует день начала периода", async () => {
    const period = await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500 }, SETTINGS);

    await removeManualPeriod(db, USER_ID, period, 1);

    expect(await listManualPeriods(db, USER_ID)).toEqual([]);
    expect(await db.periods.get(period.id)).toBeTruthy();
    expect(await hasClosedPeriods(db, USER_ID)).toBe(false);
  });

  it("отмена возвращает месяц", async () => {
    const period = await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500 }, SETTINGS);
    await removeManualPeriod(db, USER_ID, period, 1);

    await restoreManualPeriod(db, USER_ID, period);

    const restored = await listManualPeriods(db, USER_ID);
    expect(restored.map((row) => row.id)).toEqual([period.id]);
    expect(restored[0].closed_totals?.amount).toBe(1500);
  });

  it("если за окно отмены месяц завёлся заново, итоги переносятся в него, а не появляется вторая строка", async () => {
    const settings = makeSettings();
    await db.settings.add(settings);
    const period = await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500 }, SETTINGS);
    await removeManualPeriod(db, USER_ID, period, 1);
    // Пока действовало окно отмены, пользователь пролистал календарь на май.
    const recreated = await getOrCreatePeriod(db, USER_ID, 2026, 5, settings);

    await restoreManualPeriod(db, USER_ID, period);

    const live = await db.periods
      .where("[user_id+year+month]")
      .equals([USER_ID, 2026, 5])
      .filter((row) => row.deleted_at === null)
      .toArray();
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(recreated.id);
    expect(live[0].closed_totals?.amount).toBe(1500);
    expect(live[0].is_manual).toBe(true);
  });

  it("сохранение месяца, удалённого раньше, заводит его заново, а не правит удалённую строку", async () => {
    const period = await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500 }, SETTINGS);
    await removeManualPeriod(db, USER_ID, period, 1);

    const again = await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 8, amount: 200 }, SETTINGS);

    expect(again.id).not.toBe(period.id);
    expect(await listManualPeriods(db, USER_ID)).toHaveLength(1);
  });
});

describe("listManualPeriods", () => {
  beforeEach(resetDb);

  it("только ручные периоды, новые сверху", async () => {
    await db.periods.add(makePeriod({ id: "p-normal", year: 2026, month: 7 }));
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 1, amount: 1 }, SETTINGS);
    await saveManualPeriod(db, USER_ID, { year: 2025, month: 12, hours: 1, amount: 1 }, SETTINGS);
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 6, hours: 1, amount: 1 }, SETTINGS);

    const rows = await listManualPeriods(db, USER_ID);
    expect(rows.map((row) => `${row.year}-${row.month}`)).toEqual(["2026-6", "2026-5", "2025-12"]);
  });
});

describe("правка месяца у уже сохранённого исторического периода", () => {
  beforeEach(resetDb);

  it("смена месяца переносит ту же строку, а не заводит вторую", async () => {
    const may = await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500 }, SETTINGS);

    // Человек открыл май и понял, что месяц выбран не тот.
    await saveManualPeriod(
      db,
      USER_ID,
      { year: 2026, month: 6, hours: 100, amount: 1500, replacingId: may.id },
      SETTINGS,
    );

    const rows = await listManualPeriods(db, USER_ID);
    // Иначе один и тот же исторический итог оказался бы посчитан дважды, в
    // двух разных месяцах.
    expect(rows.map((row) => `${row.year}-${row.month}`)).toEqual(["2026-6"]);
    expect(rows[0].id).toBe(may.id);
  });

  it("смена месяца на уже занятый переносит итоги в него и освобождает прежний", async () => {
    const may = await saveManualPeriod(db, USER_ID, { year: 2026, month: 5, hours: 100, amount: 1500 }, SETTINGS);
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 6, hours: 8, amount: 200 }, SETTINGS);

    await saveManualPeriod(
      db,
      USER_ID,
      { year: 2026, month: 6, hours: 100, amount: 1500, replacingId: may.id },
      SETTINGS,
    );

    const rows = await listManualPeriods(db, USER_ID);
    expect(rows.map((row) => `${row.year}-${row.month}`)).toEqual(["2026-6"]);
    expect(rows[0].closed_totals?.amount).toBe(1500);
  });
});

describe("месяц с записями, превращённый в ручной", () => {
  beforeEach(resetDb);

  async function seedAugustWithEntry() {
    await db.settings.add(makeSettings());
    await db.day_types.add(makeDayType());
    await db.periods.add(
      makePeriod({ id: "p-aug", year: 2026, month: 8, base_rate: 33.3, norm_hours: 150, extra_amount: -120.75 }),
    );
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-10", amount: 240 }));
  }

  it("убрать его — значит вернуть месяц в обычное состояние, не потеряв ни числа", async () => {
    await seedAugustWithEntry();
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 8, hours: 10, amount: 999 }, SETTINGS);
    const converted = await db.periods.get("p-aug");

    await removeManualPeriod(db, USER_ID, converted!, 1);

    const period = await db.periods.get("p-aug");
    // Мягкое удаление строки стёрло бы ставку месяца, его норму и прочие
    // начисления: календарь завёл бы период заново по умолчаниям.
    expect(period).toMatchObject({
      deleted_at: null,
      is_manual: false,
      is_closed: false,
      closed_totals: null,
      base_rate: 33.3,
      norm_hours: 150,
      extra_amount: -120.75,
    });
    expect(await listManualPeriods(db, USER_ID)).toEqual([]);
  });

  it("отмена возвращает ручные итоги той же строке", async () => {
    await seedAugustWithEntry();
    await saveManualPeriod(db, USER_ID, { year: 2026, month: 8, hours: 10, amount: 999 }, SETTINGS);
    const converted = (await db.periods.get("p-aug"))!;
    await removeManualPeriod(db, USER_ID, converted, 1);

    await restoreManualPeriod(db, USER_ID, converted);

    const period = await db.periods.get("p-aug");
    expect(period).toMatchObject({ is_manual: true, is_closed: true, extra_amount: -120.75 });
    expect(period?.closed_totals).toEqual({ amount: 999, total_hours: 10, norm_hours_covered: 10 });
  });
});
