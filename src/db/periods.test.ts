import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { getOrCreatePeriod } from "@/db/periods";

let db: TimeoDB | undefined;

afterEach(async () => {
  await db?.delete();
  db = undefined;
});

function openDb(): TimeoDB {
  db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  return db;
}

const settings = { default_base_rate: 25, default_norm_hours: 168 };

describe("getOrCreatePeriod", () => {
  it("creates a period from settings defaults when there is no previous period", async () => {
    const database = openDb();

    const period = await getOrCreatePeriod(database, "user-1", 2026, 1, settings);

    expect(period.base_rate).toBe(25);
    expect(period.norm_hours).toBe(168);
  });

  it("returns the same row on a second call instead of creating a duplicate", async () => {
    const database = openDb();

    const first = await getOrCreatePeriod(database, "user-1", 2026, 1, settings);
    const second = await getOrCreatePeriod(database, "user-1", 2026, 1, settings);

    expect(second.id).toBe(first.id);
    const rows = await database.periods.where({ user_id: "user-1", year: 2026, month: 1 }).toArray();
    expect(rows).toHaveLength(1);
  });

  it("copies base_rate/norm_hours from the previous period instead of settings defaults", async () => {
    const database = openDb();
    const january = await getOrCreatePeriod(database, "user-1", 2026, 1, settings);
    await database.periods.update(january.id, { base_rate: 40, norm_hours: 150 });

    const february = await getOrCreatePeriod(database, "user-1", 2026, 2, settings);

    expect(february.base_rate).toBe(40);
    expect(february.norm_hours).toBe(150);
  });

  it("copies values, not a reference — editing the new period never touches the previous one", async () => {
    const database = openDb();
    await getOrCreatePeriod(database, "user-1", 2026, 1, settings);
    const february = await getOrCreatePeriod(database, "user-1", 2026, 2, settings);

    await database.periods.update(february.id, { base_rate: 999 });

    const january = await database.periods.where({ user_id: "user-1", year: 2026, month: 1 }).first();
    expect(january?.base_rate).toBe(25);
  });

  it("falls back to settings defaults when the previous period is in a different year", async () => {
    const database = openDb();

    const january = await getOrCreatePeriod(database, "user-1", 2027, 1, settings);

    expect(january.base_rate).toBe(25);
    expect(january.norm_hours).toBe(168);
  });

  it("never creates two rows when called concurrently for the same period", async () => {
    const database = openDb();

    const [first, second] = await Promise.all([
      getOrCreatePeriod(database, "user-1", 2026, 1, settings),
      getOrCreatePeriod(database, "user-1", 2026, 1, settings),
    ]);

    expect(second.id).toBe(first.id);
    const rows = await database.periods.where({ user_id: "user-1", year: 2026, month: 1 }).toArray();
    expect(rows).toHaveLength(1);
  });
});
