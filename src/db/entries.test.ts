import { afterEach, describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { createEntry, listActiveEntriesForDate, restoreEntry, softDeleteEntry, updateEntry } from "@/db/entries";
import type { Entry } from "@/types/models";

let db: TimeoDB | undefined;

afterEach(async () => {
  await db?.delete();
  db = undefined;
});

function openDb(): TimeoDB {
  db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  return db;
}

const baseFields: Omit<Entry, "id" | "created_at" | "updated_at" | "deleted_at"> = {
  user_id: "user-1",
  date: "2026-01-05",
  day_type_id: "dt-1",
  hours: 8,
  multiplier: 1,
  rate_per_hour: 20,
  rate_is_manual: false,
  amount: 160,
  amount_override: null,
  start_time: null,
  end_time: null,
  break_minutes: null,
  note: "",
  rate_source: "period_base",
};

describe("createEntry", () => {
  it("generates id/timestamps and persists the row", async () => {
    const database = openDb();

    const entry = await createEntry(database, baseFields);

    expect(entry.id).toBeTruthy();
    expect(entry.deleted_at).toBeNull();
    const stored = await database.entries.get(entry.id);
    expect(stored).toMatchObject(baseFields);
  });
});

describe("listActiveEntriesForDate", () => {
  it("returns only entries for the given user and date, excluding soft-deleted ones", async () => {
    const database = openDb();
    const mine = await createEntry(database, baseFields);
    await createEntry(database, { ...baseFields, user_id: "user-2" });
    await createEntry(database, { ...baseFields, date: "2026-01-06" });
    const deleted = await createEntry(database, baseFields);
    await softDeleteEntry(database, deleted.id);

    const result = await listActiveEntriesForDate(database, "user-1", "2026-01-05");

    expect(result.map((e) => e.id)).toEqual([mine.id]);
  });
});

describe("updateEntry", () => {
  it("applies a partial patch and bumps updated_at", async () => {
    const database = openDb();
    const entry = await createEntry(database, baseFields);

    await updateEntry(database, entry.id, { hours: 10, amount: 200 });

    const updated = await database.entries.get(entry.id);
    expect(updated?.hours).toBe(10);
    expect(updated?.amount).toBe(200);
    expect(updated?.note).toBe(""); // untouched fields survive a partial patch
    expect(updated?.updated_at).not.toBe(entry.updated_at);
  });
});

describe("softDeleteEntry / restoreEntry", () => {
  it("soft-deletes without removing the row, and restore clears deleted_at", async () => {
    const database = openDb();
    const entry = await createEntry(database, baseFields);

    await softDeleteEntry(database, entry.id);
    const deleted = await database.entries.get(entry.id);
    expect(deleted?.deleted_at).not.toBeNull();
    expect(await listActiveEntriesForDate(database, "user-1", "2026-01-05")).toHaveLength(0);

    await restoreEntry(database, entry.id);
    const restored = await database.entries.get(entry.id);
    expect(restored?.deleted_at).toBeNull();
    expect(await listActiveEntriesForDate(database, "user-1", "2026-01-05")).toHaveLength(1);
  });
});
