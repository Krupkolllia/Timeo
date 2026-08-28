import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";

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
});
