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
});
