import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/db";
import { adoptAccount, fetchCloudSnapshot, summarizeLocalData, wipeLocalData } from "@/db/account";
import { readBackup } from "@/db/backup";
import { FakeCloud } from "@/test/fakeCloud";
import { USER_ID, makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings, resetDb } from "@/test/factories";

const LOCAL_ID = "local-anon-uuid";
const CLOUD_ID = "11111111-2222-3333-4444-555555555555";

async function seedLocal(userId: string): Promise<void> {
  await db.settings.put(makeSettings({ id: "s-1", user_id: userId, default_base_rate: 33.75 }));
  await db.day_types.put(makeDayType({ user_id: userId }));
  await db.periods.put(
    makePeriod({
      id: "p-closed",
      user_id: userId,
      year: 2026,
      month: 7,
      is_closed: true,
      base_rate: 28.4,
      closed_totals: { amount: 4211.19, total_hours: 167.5, norm_hours_covered: 160 },
    }),
  );
  await db.periods.put(makePeriod({ id: "p-open", user_id: userId, year: 2026, month: 8, base_rate: 31.6 }));
  await db.entries.put(
    makeEntry({ id: "e-closed", user_id: userId, date: "2026-07-14", amount: 271.53, hours: 7.75 }),
  );
  await db.entries.put(makeEntry({ id: "e-open", user_id: userId, date: "2026-08-11", amount: 318.47, hours: 9.25 }));
  await db.holidays.put(makeHoliday({ user_id: userId }));
}

beforeEach(async () => {
  await resetDb();
});

describe("adoptAccount — переезд локальных данных на настоящий user_id", () => {
  it("переписывает все пять таблиц и не меняет ни одной суммы и ни одного закрытого периода (инварианты 2 и 51)", async () => {
    await seedLocal(LOCAL_ID);
    const before = {
      closed: await db.periods.get("p-closed"),
      closedEntry: await db.entries.get("e-closed"),
      openEntry: await db.entries.get("e-open"),
      settings: await db.settings.get("s-1"),
    };

    await adoptAccount(db, { localUserId: LOCAL_ID, cloudUserId: CLOUD_ID, snapshot: null, mode: null });

    // Ни одной строки не осталось под старым идентификатором.
    for (const table of [db.settings, db.periods, db.day_types, db.entries, db.holidays]) {
      expect(await table.where("user_id").equals(LOCAL_ID).count()).toBe(0);
    }
    expect(await db.periods.where("user_id").equals(CLOUD_ID).count()).toBe(2);
    expect(await db.entries.where("user_id").equals(CLOUD_ID).count()).toBe(2);
    expect(await db.day_types.where("user_id").equals(CLOUD_ID).count()).toBe(1);
    expect(await db.holidays.where("user_id").equals(CLOUD_ID).count()).toBe(1);
    expect(await db.settings.where("user_id").equals(CLOUD_ID).count()).toBe(1);

    const closed = await db.periods.get("p-closed");
    expect(closed?.closed_totals).toEqual(before.closed?.closed_totals);
    expect(closed?.is_closed).toBe(true);
    expect(closed?.base_rate).toBe(28.4);
    // updated_at исторический — переезд не правка (иначе первая же выгрузка
    // выглядела бы как «изменилось всё»).
    expect(closed?.updated_at).toBe(before.closed?.updated_at);

    expect((await db.entries.get("e-closed"))?.amount).toBe(before.closedEntry?.amount);
    expect((await db.entries.get("e-closed"))?.updated_at).toBe(before.closedEntry?.updated_at);
    expect((await db.entries.get("e-open"))?.amount).toBe(before.openEntry?.amount);
    expect((await db.settings.get("s-1"))?.default_base_rate).toBe(before.settings?.default_base_rate);
  });

  it("режим «добавить недостающее» оставляет локальные записи и добавляет облачные", async () => {
    await seedLocal(LOCAL_ID);
    const cloud = new FakeCloud();
    cloud.seed("day_types", [makeDayType({ id: "dt-cloud", user_id: CLOUD_ID, name: "Ночная" })]);
    cloud.seed("entries", [
      makeEntry({ id: "e-cloud", user_id: CLOUD_ID, day_type_id: "dt-cloud", date: "2026-08-19", amount: 517.42 }),
    ]);
    const snapshot = await fetchCloudSnapshot(cloud, CLOUD_ID, "test");

    await adoptAccount(db, { localUserId: LOCAL_ID, cloudUserId: CLOUD_ID, snapshot, mode: "merge" });

    expect((await db.entries.get("e-open"))?.amount).toBe(318.47);
    expect((await db.entries.get("e-cloud"))?.amount).toBe(517.42);
    expect((await db.entries.get("e-cloud"))?.user_id).toBe(CLOUD_ID);
  });

  it("режим «заменить всё» отдаёт устройство облачной копии", async () => {
    await seedLocal(LOCAL_ID);
    const cloud = new FakeCloud();
    cloud.seed("day_types", [makeDayType({ id: "dt-cloud", user_id: CLOUD_ID })]);
    cloud.seed("entries", [
      makeEntry({ id: "e-cloud", user_id: CLOUD_ID, day_type_id: "dt-cloud", date: "2026-08-19", amount: 517.42 }),
    ]);
    const snapshot = await fetchCloudSnapshot(cloud, CLOUD_ID, "test");

    await adoptAccount(db, { localUserId: LOCAL_ID, cloudUserId: CLOUD_ID, snapshot, mode: "replace" });

    expect(await db.entries.get("e-open")).toBeUndefined();
    expect((await db.entries.get("e-cloud"))?.amount).toBe(517.42);
  });
});

describe("wipeLocalData", () => {
  it("инвариант 44: стирает всё, включая курсоры синхронизации", async () => {
    await seedLocal(USER_ID);
    await db.sync_meta.put({
      user_id: USER_ID,
      pull_cursor: { entries: "2026-08-30T09:00:00.000Z" },
      pushed_through: {},
      clock_guard: 0,
      last_sync_at: null,
      last_error: null,
    });

    await wipeLocalData(db);

    expect(await db.entries.count()).toBe(0);
    expect(await db.periods.count()).toBe(0);
    expect(await db.day_types.count()).toBe(0);
    expect(await db.holidays.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
    expect(await db.sync_meta.count()).toBe(0);
  });
});

describe("summarizeLocalData", () => {
  it("считает месяцы с деньгами — то число, которым предупреждение говорит о цене", async () => {
    await seedLocal(USER_ID);

    const summary = await summarizeLocalData(db, USER_ID);

    expect(summary.periods).toBe(2);
    expect(summary.entries).toBe(2);
    // Июль и август — по записи с ненулевой суммой в каждом.
    expect(summary.months_with_money).toBe(2);
  });

  it("не считает мягко удалённые строки", async () => {
    await db.entries.put(makeEntry({ id: "e-gone", deleted_at: "2026-08-30T00:00:00.000Z", amount: 999.13 }));

    const summary = await summarizeLocalData(db, USER_ID);

    expect(summary.entries).toBe(0);
    expect(summary.months_with_money).toBe(0);
  });
});

describe("экспорт и облако", () => {
  it("инвариант 46: в файле нет ни токенов, ни push-подписок, ни служебного состояния синхронизации", async () => {
    await seedLocal(USER_ID);
    await db.sync_meta.put({
      user_id: USER_ID,
      pull_cursor: { entries: "2026-08-30T09:00:00.000Z" },
      pushed_through: { entries: "2026-08-30T09:00:00.000Z" },
      clock_guard: 1,
      last_sync_at: "2026-08-30T09:00:00.000Z",
      last_error: null,
    });
    localStorage.setItem("sb-test-auth-token", "секретный токен");

    const file = await readBackup(db, USER_ID, "test");
    const text = JSON.stringify(file);

    expect(Object.keys(file).sort()).toEqual(
      ["app_version", "day_types", "entries", "exported_at", "holidays", "periods", "schema_version", "settings"],
    );
    expect(text).not.toContain("push_subscriptions");
    expect(text).not.toContain("секретный токен");
    expect(text).not.toContain("pull_cursor");
    expect(text).not.toContain("server_updated_at");
    localStorage.removeItem("sb-test-auth-token");
  });
});
