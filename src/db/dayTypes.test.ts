import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { ensureDayTypesSeeded, PRESET_DAY_TYPES } from "@/db/dayTypes";

let db: TimeoDB | undefined;

afterEach(async () => {
  await db?.delete();
  db = undefined;
});

function openDb(): TimeoDB {
  db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  return db;
}

describe("ensureDayTypesSeeded", () => {
  it("seeds all preset day types for a new user", async () => {
    const database = openDb();

    await ensureDayTypesSeeded(database, "user-1");

    const rows = await database.day_types.where("user_id").equals("user-1").toArray();
    expect(rows).toHaveLength(PRESET_DAY_TYPES.length);
    expect(rows.map((r) => r.name).sort()).toEqual(PRESET_DAY_TYPES.map((p) => p.name).sort());
  });

  it("marks vacation and sick leave to ignore automatic weekend/holiday multipliers", async () => {
    const database = openDb();

    await ensureDayTypesSeeded(database, "user-1");

    const rows = await database.day_types.where("user_id").equals("user-1").toArray();
    const vacation = rows.find((r) => r.name === "Отпуск");
    const sickLeave = rows.find((r) => r.name === "Больничный");
    expect(vacation?.ignore_auto_multipliers).toBe(true);
    expect(sickLeave?.ignore_auto_multipliers).toBe(true);
  });

  it("is idempotent — running it again does not duplicate rows", async () => {
    const database = openDb();

    await ensureDayTypesSeeded(database, "user-1");
    await ensureDayTypesSeeded(database, "user-1");

    const rows = await database.day_types.where("user_id").equals("user-1").toArray();
    expect(rows).toHaveLength(PRESET_DAY_TYPES.length);
  });

  it("seeds independently per user", async () => {
    const database = openDb();

    await ensureDayTypesSeeded(database, "user-1");
    await ensureDayTypesSeeded(database, "user-2");

    const user1Rows = await database.day_types.where("user_id").equals("user-1").toArray();
    const user2Rows = await database.day_types.where("user_id").equals("user-2").toArray();
    expect(user1Rows).toHaveLength(PRESET_DAY_TYPES.length);
    expect(user2Rows).toHaveLength(PRESET_DAY_TYPES.length);
  });
});
