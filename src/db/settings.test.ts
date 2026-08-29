import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { DEFAULT_SETTINGS, ensureSettings, updateWeekendMultipliers } from "@/db/settings";

let db: TimeoDB | undefined;

afterEach(async () => {
  await db?.delete();
  db = undefined;
});

function openDb(): TimeoDB {
  db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  return db;
}

describe("ensureSettings", () => {
  it("creates a default settings row for a new user", async () => {
    const database = openDb();

    const settings = await ensureSettings(database, "user-1");

    expect(settings.user_id).toBe("user-1");
    expect(settings).toMatchObject(DEFAULT_SETTINGS);
  });

  it("returns the existing row instead of creating a second one", async () => {
    const database = openDb();

    const first = await ensureSettings(database, "user-1");
    const second = await ensureSettings(database, "user-1");

    expect(second.id).toBe(first.id);
    const rows = await database.settings.where("user_id").equals("user-1").toArray();
    expect(rows).toHaveLength(1);
  });

  it("never creates two rows when called concurrently (e.g. React StrictMode double effect)", async () => {
    const database = openDb();

    const [first, second] = await Promise.all([ensureSettings(database, "user-1"), ensureSettings(database, "user-1")]);

    expect(second.id).toBe(first.id);
    const rows = await database.settings.where("user_id").equals("user-1").toArray();
    expect(rows).toHaveLength(1);
  });
});

describe("updateWeekendMultipliers", () => {
  it("записывает все три множителя и не открывает таблицу записей (инвариант 51)", async () => {
    const database = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
    try {
      const settings = await ensureSettings(database, "user-1");
      await database.entries.add({
        id: "e-1",
        user_id: "user-1",
        created_at: "2026-08-01T00:00:00.000Z",
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
      });

      await updateWeekendMultipliers(database, settings.id, { saturday: 1.5, sunday: 2, holiday: 2.5 });

      expect((await database.settings.get(settings.id))?.weekend_multipliers).toEqual({
        saturday: 1.5,
        sunday: 2,
        holiday: 2.5,
      });
      const entry = await database.entries.get("e-1");
      expect(entry?.amount).toBe(240);
      expect(entry?.multiplier).toBe(1);
      expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");
    } finally {
      await database.delete();
    }
  });
});
