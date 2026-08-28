import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { DEFAULT_SETTINGS, ensureSettings } from "@/db/settings";

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
