import { describe, expect, it } from "vitest";
import { TimeoDB } from "@/db/schema";
import { bootstrapUser } from "@/db/bootstrap";
import { PRESET_DAY_TYPES } from "@/db/dayTypes";

async function freshDb() {
  const db = new TimeoDB(`timeo-test-${crypto.randomUUID()}`);
  await db.open();
  return db;
}

describe("bootstrapUser", () => {
  it("creates settings and seeds the day types on first launch", async () => {
    const db = await freshDb();
    const settings = await bootstrapUser(db, "user-1");

    expect(settings.user_id).toBe("user-1");
    expect(settings.currency).toBe("PLN");
    expect(await db.day_types.where("user_id").equals("user-1").count()).toBe(PRESET_DAY_TYPES.length);

    db.close();
  });

  it("is idempotent — a second launch adds nothing", async () => {
    const db = await freshDb();
    const first = await bootstrapUser(db, "user-1");
    const second = await bootstrapUser(db, "user-1");

    expect(second.id).toBe(first.id);
    expect(await db.settings.count()).toBe(1);
    expect(await db.day_types.count()).toBe(PRESET_DAY_TYPES.length);

    db.close();
  });

  it("keeps users apart", async () => {
    const db = await freshDb();
    await bootstrapUser(db, "user-1");
    await bootstrapUser(db, "user-2");

    expect(await db.settings.count()).toBe(2);
    expect(await db.day_types.where("user_id").equals("user-2").count()).toBe(PRESET_DAY_TYPES.length);

    db.close();
  });
});
