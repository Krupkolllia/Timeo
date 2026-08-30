import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { roundMoney } from "@/lib/calc/round";

const LEGACY_STORES = {
  settings: "id, user_id",
  periods: "id, user_id, [year+month]",
  day_types: "id, user_id, sort_order",
  entries: "id, user_id, date, day_type_id",
  holidays: "id, user_id, date",
};

function legacySettings(patch: Record<string, unknown> = {}) {
  return {
    id: "s1",
    user_id: "user-1",
    created_at: "",
    updated_at: "2026-08-01T00:00:00.000Z",
    deleted_at: null,
    currency: "PLN",
    period_start_day: 1,
    period_naming: "end_month",
    default_hours: 8,
    theme: "system",
    show_shift_times: false,
    reminder_enabled: false,
    reminder_time: null,
    week_starts_on: "monday",
    weekend_multipliers: { saturday: 1, sunday: 1, holiday: 1 },
    default_base_rate: 30,
    default_norm_hours: 160,
    default_base_rate_from_period: null,
    preferred_rate_change_mode: null,
    ...patch,
  };
}

function legacyPeriod(patch: Record<string, unknown> = {}) {
  return {
    id: "p1",
    user_id: "user-1",
    created_at: "",
    updated_at: "2026-08-01T00:00:00.000Z",
    deleted_at: null,
    year: 2026,
    month: 8,
    base_rate: 30,
    norm_hours: 160,
    extra_amount: 0,
    extra_note: "",
    is_closed: false,
    closed_totals: null,
    is_manual: false,
    ...patch,
  };
}

function legacyEntry(patch: Record<string, unknown> = {}) {
  return {
    id: "e1",
    user_id: "user-1",
    created_at: "",
    updated_at: "2026-08-01T00:00:00.000Z",
    deleted_at: null,
    date: "2026-08-10",
    day_type_id: "dt-1",
    hours: 8,
    multiplier: 1,
    rate_per_hour: 30,
    rate_is_manual: false,
    amount: 240,
    amount_override: null,
    start_time: null,
    end_time: null,
    break_minutes: null,
    note: "",
    rate_source: "period_base",
    ...patch,
  };
}


function legacyDayType(patch: Record<string, unknown> = {}) {
  return {
    id: "dt-1",
    user_id: "user-1",
    created_at: "",
    updated_at: "2026-08-01T00:00:00.000Z",
    deleted_at: null,
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
    is_archived: false,
    ...patch,
  };
}

let dbName: string | undefined;

afterEach(async () => {
  if (dbName) await Dexie.delete(dbName);
  dbName = undefined;
});

describe("TimeoDB schema migration", () => {
  it("upgrades a pre-existing v1 database (no compound period index) without erroring", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    // Reproduces the schema shape deployed back in Block 0 — before the
    // compound index [user_id+year+month] existed here.
    const legacy = new Dexie(dbName);
    legacy.version(1).stores({
      settings: "id, user_id",
      periods: "id, user_id, [year+month]",
      day_types: "id, user_id, sort_order",
      entries: "id, user_id, date, day_type_id",
      holidays: "id, user_id, date",
    });
    await legacy.open();
    await legacy.table("periods").add({ id: "p1", user_id: "user-1", year: 2026, month: 1 });
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const found = await upgraded.periods.where("[user_id+year+month]").equals(["user-1", 2026, 1]).first();
    expect(found?.id).toBe("p1");

    upgraded.close();
  });

  it("normalizes float tails already stored in entries when upgrading to v3", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores({
      settings: "id, user_id",
      periods: "id, user_id, [year+month]",
      day_types: "id, user_id, sort_order",
      entries: "id, user_id, date, day_type_id",
      holidays: "id, user_id, date",
    });
    await legacy.open();
    await legacy.table("entries").add({
      id: "e1",
      user_id: "user-1",
      created_at: "",
      updated_at: "2026-08-01T00:00:00.000Z",
      deleted_at: null,
      date: "2026-08-01",
      day_type_id: "dt-1",
      hours: 8,
      multiplier: 1.5015015015015014,
      rate_per_hour: 49.949999999999996,
      rate_is_manual: false,
      amount: 399.59999999999997,
      amount_override: null,
      start_time: null,
      end_time: null,
      break_minutes: null,
      duration_is_manual: false,
      note: "",
      rate_source: "period_base",
    });
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entry = await upgraded.entries.get("e1");
    expect(entry?.amount).toBe(399.6);
    expect(entry?.rate_per_hour).toBe(49.95);
    expect(entry?.multiplier).toBe(1.502);
    // updated_at не трогаем — иначе при синхронизации (блок 7) вся база разом
    // уедет в облако как «изменённая».
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    upgraded.close();
  });

  it("fills in default_base_rate_from_period on settings rows written before v4", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores({
      settings: "id, user_id",
      periods: "id, user_id, [year+month]",
      day_types: "id, user_id, sort_order",
      entries: "id, user_id, date, day_type_id",
      holidays: "id, user_id, date",
    });
    await legacy.open();
    await legacy.table("settings").add({
      id: "s1",
      user_id: "user-1",
      created_at: "",
      updated_at: "2026-08-01T00:00:00.000Z",
      deleted_at: null,
      currency: "PLN",
      period_start_day: 1,
      period_naming: "end_month",
      default_hours: 8,
      theme: "system",
      show_shift_times: false,
      reminder_enabled: false,
      reminder_time: null,
      week_starts_on: "monday",
      weekend_multipliers: { saturday: 1, sunday: 1, holiday: 1 },
      default_base_rate: 30,
      default_norm_hours: 160,
      preferred_rate_change_mode: null,
    });
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const settings = await upgraded.settings.get("s1");
    expect(settings?.default_base_rate_from_period).toBeNull();
    // Ставка и всё остальное не тронуты — миграция только дописывает поле.
    expect(settings?.default_base_rate).toBe(30);
    expect(settings?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    upgraded.close();
  });

  it("rewrites the multiplier to 1 on manual-rate entries stored under the old formula", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("periods").add(legacyPeriod({ base_rate: 30 }));
    // Старая форма: человек вписал ставку 50 при базовой 30, старый код вывел
    // из неё множитель 50 / 30 = 1.667 и посчитал сумму как 8 × 50.
    await legacy.table("entries").add(
      legacyEntry({
        id: "manual",
        hours: 8,
        multiplier: 1.667,
        rate_per_hour: 50,
        rate_is_manual: true,
        amount: 400,
        rate_source: "manual",
      }),
    );
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entry = await upgraded.entries.get("manual");
    // Сумма сохранена в точности, вписанная ставка не тронута, множитель
    // больше не удваивает коэффициент.
    expect(entry?.amount).toBe(400);
    expect(entry?.rate_per_hour).toBe(50);
    expect(entry?.multiplier).toBe(1);
    // И теперь запись согласована с новой формулой: правка любого поля даёт ту
    // же сумму, а не 8 × 50 × 1.667 = 666.80.
    expect(roundMoney(entry!.hours * entry!.rate_per_hour * entry!.multiplier)).toBe(400);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    upgraded.close();
  });

  it("restores the stored rate on auto-rate entries without changing their amount", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("periods").add(legacyPeriod({ base_rate: 30 }));
    // Старая форма: ночная смена ×1.5 при базовой 30 — ставка сохранена как
    // 45, сумма как 8 × 45.
    await legacy.table("entries").add(
      legacyEntry({
        id: "auto",
        hours: 8,
        multiplier: 1.5,
        rate_per_hour: 45,
        rate_is_manual: false,
        amount: 360,
        rate_source: "day_type_default",
      }),
    );
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entry = await upgraded.entries.get("auto");
    expect(entry?.amount).toBe(360);
    expect(entry?.multiplier).toBe(1.5);
    // Ставка снова та, что показывает поле «ставка за час», и строка
    // расшифровки «8ч × 30.00 · ×1.5» наконец даёт свою же сумму.
    expect(entry?.rate_per_hour).toBe(30);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    upgraded.close();
  });

  it("leaves entries inside a closed period untouched", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("periods").add(
      legacyPeriod({
        base_rate: 30,
        is_closed: true,
        closed_totals: { amount: 400, total_hours: 8, norm_hours_covered: 8 },
      }),
    );
    await legacy.table("entries").add(
      legacyEntry({
        id: "closed",
        hours: 8,
        multiplier: 1.667,
        rate_per_hour: 50,
        rate_is_manual: true,
        amount: 400,
        rate_source: "manual",
      }),
    );
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entry = await upgraded.entries.get("closed");
    expect(entry?.multiplier).toBe(1.667);
    expect(entry?.amount).toBe(400);

    upgraded.close();
  });

  it("leaves entries already written under the new formula alone", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("periods").add(legacyPeriod({ base_rate: 30 }));
    // Новая форма: 8 × 50 × 2 = 800. Множитель здесь работает, и обнулять его
    // значило бы урезать сумму вдвое.
    await legacy.table("entries").add(
      legacyEntry({
        id: "new-shape",
        hours: 8,
        multiplier: 2,
        rate_per_hour: 50,
        rate_is_manual: true,
        amount: 800,
        rate_source: "manual",
      }),
    );
    // amount_override сумма задана человеком целиком (инвариант 8).
    await legacy.table("entries").add(
      legacyEntry({
        id: "override",
        hours: 8,
        multiplier: 1.667,
        rate_per_hour: 50,
        rate_is_manual: true,
        amount: 400,
        amount_override: 400,
        rate_source: "manual",
      }),
    );
    // Не сходится ни по одной формуле — форму записи не опознали.
    await legacy.table("entries").add(
      legacyEntry({
        id: "unknown",
        hours: 8,
        multiplier: 1.667,
        rate_per_hour: 50,
        rate_is_manual: true,
        amount: 123.45,
        rate_source: "manual",
      }),
    );
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    expect((await upgraded.entries.get("new-shape"))?.multiplier).toBe(2);
    expect((await upgraded.entries.get("new-shape"))?.amount).toBe(800);
    expect((await upgraded.entries.get("override"))?.multiplier).toBe(1.667);
    expect((await upgraded.entries.get("unknown"))?.multiplier).toBe(1.667);
    expect((await upgraded.entries.get("unknown"))?.amount).toBe(123.45);

    upgraded.close();
  });

  it("keeps the period total equal to the sum of its entries across the upgrade", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("periods").add(legacyPeriod({ base_rate: 30 }));
    await legacy.table("entries").bulkAdd([
      legacyEntry({ id: "a", date: "2026-08-03", hours: 8, multiplier: 1.667, rate_per_hour: 50, rate_is_manual: true, amount: 400, rate_source: "manual" }),
      legacyEntry({ id: "b", date: "2026-08-04", hours: 8, multiplier: 1.5, rate_per_hour: 45, rate_is_manual: false, amount: 360, rate_source: "day_type_default" }),
      legacyEntry({ id: "c", date: "2026-08-05", hours: 8, multiplier: 1, rate_per_hour: 30, rate_is_manual: false, amount: 240, rate_source: "period_base" }),
    ]);
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entries = await upgraded.entries.toArray();
    expect(roundMoney(entries.reduce((sum, e) => sum + e.amount, 0))).toBe(1000);
    // И каждая строка теперь считается по новой формуле в свою же сумму.
    for (const e of entries) {
      expect(roundMoney(e.hours * e.rate_per_hour * e.multiplier)).toBe(e.amount);
    }

    upgraded.close();
  });

  it("defaults a missing period_start_day and survives a malformed entry date", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    // Строка настроек, записанная ещё до появления поля.
    const settings = legacySettings();
    delete (settings as Record<string, unknown>).period_start_day;
    await legacy.table("settings").add(settings);
    await legacy.table("periods").add(legacyPeriod({ base_rate: 30 }));
    await legacy.table("entries").bulkAdd([
      legacyEntry({ id: "ok", hours: 8, multiplier: 1.667, rate_per_hour: 50, rate_is_manual: true, amount: 400 }),
      // Дата, из которой период не вывести: миграция обязана не считать такую
      // запись закрытой и не падать на ней.
      legacyEntry({
        id: "broken-date",
        date: "не-дата",
        hours: 8,
        multiplier: 1.667,
        rate_per_hour: 50,
        rate_is_manual: true,
        amount: 400,
      }),
    ]);
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    expect((await upgraded.entries.get("ok"))?.multiplier).toBe(1);
    expect((await upgraded.entries.get("broken-date"))?.multiplier).toBe(1);

    upgraded.close();
  });

  it("leaves an auto-rate entry alone when the period base rate no longer reconciles", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    // Базовая ставка периода с тех пор изменилась: подставлять её в запись
    // задним числом значило бы придумать число, которого там не было.
    await legacy.table("periods").add(legacyPeriod({ base_rate: 50 }));
    await legacy.table("entries").add(
      legacyEntry({ id: "auto", hours: 8, multiplier: 1.5, rate_per_hour: 45, rate_is_manual: false, amount: 360 }),
    );
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entry = await upgraded.entries.get("auto");
    expect(entry?.rate_per_hour).toBe(45);
    expect(entry?.amount).toBe(360);

    upgraded.close();
  });

  it("leaves an auto-rate entry alone when its period row is missing", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("entries").add(
      legacyEntry({ id: "auto", hours: 8, multiplier: 1.5, rate_per_hour: 45, rate_is_manual: false, amount: 360 }),
    );
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    expect((await upgraded.entries.get("auto"))?.rate_per_hour).toBe(45);

    upgraded.close();
  });
  it("derives a day type badge from its name when upgrading to v6", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("day_types").bulkAdd([
      legacyDayType({ id: "work", name: "Рабочий день" }),
      legacyDayType({ id: "night", name: "  ночная смена", sort_order: 1 }),
      // Имя может быть пустым: раздел 9 запрещает жёсткую валидацию, и такой
      // тип дня мог быть создан. Пустой значок на календаре — регрессия.
      legacyDayType({ id: "nameless", name: "", sort_order: 2 }),
      legacyDayType({ id: "emoji", name: "🌙 ночь", sort_order: 3 }),
    ]);
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    expect((await upgraded.day_types.get("work"))?.label).toBe("Р");
    expect((await upgraded.day_types.get("night"))?.label).toBe("Н");
    expect((await upgraded.day_types.get("nameless"))?.label).toBe("•");
    expect((await upgraded.day_types.get("emoji"))?.label).toBe("🌙");
    for (const id of ["work", "night", "nameless", "emoji"]) {
      const row = await upgraded.day_types.get(id);
      expect(row?.label).not.toBe("");
      expect(row?.note).toBe("");
      // updated_at не трогаем — иначе при синхронизации (блок 8) все типы дней
      // разом уедут в облако как «изменённые».
      expect(row?.updated_at).toBe("2026-08-01T00:00:00.000Z");
      expect((row as unknown as { icon?: string }).icon).toBeUndefined();
    }

    upgraded.close();
  });

  it("infers rate_mode from the old default_rate convention on upgrade to v6", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("day_types").bulkAdd([
      legacyDayType({ id: "linked", default_rate: null }),
      // До блока 4 «своя ставка» выражалась именно так, и режим обязан
      // получиться тот же, каким он был вчера.
      legacyDayType({ id: "pinned", default_rate: 55, sort_order: 1 }),
    ]);
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    expect((await upgraded.day_types.get("linked"))?.rate_mode).toBe("multiplier");
    expect((await upgraded.day_types.get("pinned"))?.rate_mode).toBe("pinned");
    expect((await upgraded.day_types.get("pinned"))?.default_rate).toBe(55);

    upgraded.close();
  });

  it("changes no stored amount and no closed period when upgrading to v6", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    // Закрытый период плюс открытый: ни тот, ни другой миграция типов дней
    // трогать не имеет права (инвариант 2 и раздел 5.4 — записи самодостаточны).
    await legacy.table("periods").bulkAdd([
      legacyPeriod({
        id: "p-closed",
        year: 2026,
        month: 7,
        base_rate: 30,
        is_closed: true,
        closed_totals: { amount: 240, total_hours: 8, norm_hours_covered: 8 },
      }),
      legacyPeriod({ id: "p-open", year: 2026, month: 8, base_rate: 30 }),
    ]);
    await legacy.table("day_types").add(legacyDayType());
    await legacy.table("entries").bulkAdd([
      legacyEntry({ id: "closed", date: "2026-07-10", amount: 240 }),
      legacyEntry({ id: "open-a", date: "2026-08-10", amount: 240 }),
      legacyEntry({ id: "open-b", date: "2026-08-11", hours: 6, amount: 180 }),
    ]);
    legacy.close();

    const before = { closed: 240, open: 420 };

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entries = await upgraded.entries.toArray();
    const sumFor = (prefix: string) =>
      roundMoney(entries.filter((e) => e.date.startsWith(prefix)).reduce((sum, e) => sum + e.amount, 0));
    expect(sumFor("2026-07")).toBe(before.closed);
    expect(sumFor("2026-08")).toBe(before.open);
    for (const entry of entries) expect(entry.updated_at).toBe("2026-08-01T00:00:00.000Z");

    const closedPeriod = await upgraded.periods.get("p-closed");
    expect(closedPeriod?.is_closed).toBe(true);
    expect(closedPeriod?.closed_totals?.amount).toBe(240);
    expect(closedPeriod?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    upgraded.close();
  });

  it("leaves a day type that already carries the v6 fields untouched", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("day_types").add(
      legacyDayType({ id: "already", name: "Рабочий день", label: "☀", note: "своя заметка", rate_mode: "pinned" }),
    );
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const row = await upgraded.day_types.get("already");
    expect(row?.label).toBe("☀");
    expect(row?.note).toBe("своя заметка");
    // rate_mode задан явно и не должен переехать в "multiplier" из-за того,
    // что default_rate ещё не заполнен.
    expect(row?.rate_mode).toBe("pinned");

    upgraded.close();
  });
  it("fills in seeded_holiday_years on settings rows written before v7", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const settings = await upgraded.settings.get("s1");
    expect(settings?.seeded_holiday_years).toEqual([]);
    // updated_at не трогаем — иначе при синхронизации (блок 8) настройки разом
    // уедут в облако как «изменённые».
    expect(settings?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    upgraded.close();
  });

  it("keeps seeded_holiday_years that a settings row already carries", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings({ seeded_holiday_years: [2026] }));
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    // Иначе миграция «переоткрыла» бы уже засеянный год и вернула праздники,
    // которые пользователь удалил.
    expect((await upgraded.settings.get("s1"))?.seeded_holiday_years).toEqual([2026]);

    upgraded.close();
  });

  it("changes no stored amount, no closed period and no holiday when upgrading to v7", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("periods").bulkAdd([
      legacyPeriod({
        id: "p-closed",
        year: 2026,
        month: 7,
        base_rate: 30,
        is_closed: true,
        closed_totals: { amount: 240, total_hours: 8, norm_hours_covered: 8 },
      }),
      legacyPeriod({ id: "p-open", year: 2026, month: 8, base_rate: 30 }),
    ]);
    await legacy.table("day_types").add(legacyDayType());
    await legacy.table("entries").bulkAdd([
      legacyEntry({ id: "closed", date: "2026-07-10", amount: 240 }),
      legacyEntry({ id: "open-a", date: "2026-08-10", amount: 240 }),
      legacyEntry({ id: "open-b", date: "2026-08-11", hours: 6, amount: 180 }),
    ]);
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entries = await upgraded.entries.toArray();
    const sumFor = (prefix: string) =>
      roundMoney(entries.filter((e) => e.date.startsWith(prefix)).reduce((sum, e) => sum + e.amount, 0));
    expect(sumFor("2026-07")).toBe(240);
    expect(sumFor("2026-08")).toBe(420);
    for (const entry of entries) expect(entry.updated_at).toBe("2026-08-01T00:00:00.000Z");

    const closedPeriod = await upgraded.periods.get("p-closed");
    expect(closedPeriod?.is_closed).toBe(true);
    expect(closedPeriod?.closed_totals?.amount).toBe(240);
    expect(closedPeriod?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    // Миграция не засевает праздники: посев — это отдельный шаг запуска,
    // который спрашивает settings.seeded_holiday_years.
    expect(await upgraded.holidays.count()).toBe(0);

    upgraded.close();
  });
  it("version(8) помечает все существующие записи как duration_is_manual", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("periods").bulkAdd([
      legacyPeriod({
        id: "p-closed",
        year: 2026,
        month: 7,
        is_closed: true,
        closed_totals: { amount: 240, total_hours: 8, norm_hours_covered: 8 },
      }),
      legacyPeriod({ id: "p-open", year: 2026, month: 8 }),
    ]);
    await legacy.table("day_types").add(legacyDayType());
    await legacy.table("entries").bulkAdd([
      // Ровно тот случай, ради которого миграция и ставит true: времена
      // заполнены, а часы человек набрал сам. Вывод по разделу 6.1 дал бы
      // 7.5 вместо 8 и переписал бы 240 zł в 225 zł при первом же сохранении.
      legacyEntry({
        id: "with-times",
        date: "2026-08-10",
        hours: 8,
        amount: 240,
        start_time: "08:00",
        end_time: "16:00",
        break_minutes: 30,
      }),
      legacyEntry({ id: "no-times", date: "2026-08-11", hours: 6, amount: 180 }),
      legacyEntry({ id: "closed", date: "2026-07-10", hours: 8, amount: 240, start_time: "22:00", end_time: "06:00" }),
    ]);
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    const entries = await upgraded.entries.toArray();
    expect(entries).toHaveLength(3);
    // Всем, включая запись закрытого периода: оставить поле неопределённым
    // значило бы договориться о выводе длительности на случай переоткрытия.
    for (const entry of entries) expect(entry.duration_is_manual).toBe(true);

    // Ни одна сумма и ни одна длительность не изменились.
    expect((await upgraded.entries.get("with-times"))?.hours).toBe(8);
    expect((await upgraded.entries.get("with-times"))?.amount).toBe(240);
    expect((await upgraded.entries.get("with-times"))?.start_time).toBe("08:00");
    expect((await upgraded.entries.get("no-times"))?.amount).toBe(180);
    expect((await upgraded.entries.get("closed"))?.amount).toBe(240);
    expect(roundMoney(entries.reduce((sum, e) => sum + e.amount, 0))).toBe(660);

    // updated_at не тронут — иначе для синхронизации блока 8 вся база разом
    // выглядит изменённой.
    for (const entry of entries) expect(entry.updated_at).toBe("2026-08-01T00:00:00.000Z");

    // Инвариант 2: закрытый период неизменяем.
    const closedPeriod = await upgraded.periods.get("p-closed");
    expect(closedPeriod?.is_closed).toBe(true);
    expect(closedPeriod?.closed_totals).toEqual({ amount: 240, total_hours: 8, norm_hours_covered: 8 });
    expect(closedPeriod?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    upgraded.close();
  });

  it("version(8) на пустой базе ничего не создаёт", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;
    const upgraded = new TimeoDB(dbName);
    await upgraded.open();
    expect(await upgraded.entries.count()).toBe(0);
    upgraded.close();
  });

  it("version(9): день типа получает пустой шаблон времён, запись — paid_break_minutes=0, настройки — total_hours_paid_only=true", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;

    const legacy = new Dexie(dbName);
    legacy.version(1).stores(LEGACY_STORES);
    await legacy.open();
    await legacy.table("settings").add(legacySettings());
    await legacy.table("periods").add(
      legacyPeriod({
        id: "p-closed",
        year: 2026,
        month: 7,
        is_closed: true,
        closed_totals: { amount: 240, total_hours: 8, norm_hours_covered: 8 },
      }),
    );
    await legacy.table("day_types").add(legacyDayType());
    await legacy.table("entries").add(
      legacyEntry({ id: "closed", date: "2026-07-10", hours: 8, amount: 240, break_minutes: 30 }),
    );
    legacy.close();

    const upgraded = new TimeoDB(dbName);
    await upgraded.open();

    // day_types: времена и перерыв по умолчанию — null (их не было ни у
    // одного существующего типа), оплачиваемых минут перерыва — 0 (ни на что
    // не влияет без времён, но поле определено).
    const dayType = await upgraded.day_types.get("dt-1");
    expect(dayType?.default_start).toBeNull();
    expect(dayType?.default_end).toBeNull();
    expect(dayType?.default_break_minutes).toBeNull();
    expect(dayType?.default_break_paid_minutes).toBe(0);

    // entries: paid_break_minutes=0 воспроизводит старую формулу буквально —
    // ни hours, ни amount, ни updated_at, ни closed_totals не сдвинулись.
    const entry = await upgraded.entries.get("closed");
    expect(entry?.paid_break_minutes).toBe(0);
    expect(entry?.hours).toBe(8);
    expect(entry?.amount).toBe(240);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");

    const closedPeriod = await upgraded.periods.get("p-closed");
    expect(closedPeriod?.is_closed).toBe(true);
    expect(closedPeriod?.closed_totals).toEqual({ amount: 240, total_hours: 8, norm_hours_covered: 8 });

    // settings: итоги периода продолжают считаться по оплачиваемым часам, как
    // и до появления этой настройки.
    const settings = await upgraded.settings.get("s1");
    expect(settings?.total_hours_paid_only).toBe(true);

    upgraded.close();
  });

  it("version(9) на пустой базе ничего не создаёт", async () => {
    dbName = `timeo-test-${crypto.randomUUID()}`;
    const upgraded = new TimeoDB(dbName);
    await upgraded.open();
    expect(await upgraded.entries.count()).toBe(0);
    expect(await upgraded.day_types.count()).toBe(0);
    upgraded.close();
  });
});
