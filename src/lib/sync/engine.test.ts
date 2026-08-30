import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/db";
import { readSyncMeta } from "@/db/syncMeta";
import { syncOnce } from "@/lib/sync/engine";
import { FakeCloud } from "@/test/fakeCloud";
import type { Entry, Holiday, Period } from "@/types/models";
import { USER_ID, makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings, resetDb } from "@/test/factories";

beforeEach(async () => {
  await resetDb();
});

describe("syncOnce", () => {
  it("инвариант 41: два устройства правят разные записи одного периода — выживают обе", async () => {
    const cloud = new FakeCloud();
    const dayType = makeDayType();
    // Локально: правка записи за 10 августа. В облаке: правка записи за 11-е,
    // сделанная другим устройством. Суммы намеренно «неслучайные» — ветка по
    // умолчанию таких чисел не выдаёт.
    const tenth = makeEntry({ id: "e-10", date: "2026-08-10", amount: 271.53, updated_at: "2026-08-30T09:00:00.000Z" });
    const eleventh = makeEntry({
      id: "e-11",
      date: "2026-08-11",
      amount: 318.47,
      updated_at: "2026-08-30T09:30:00.000Z",
    });

    await db.day_types.put(dayType);
    await db.entries.put(tenth);
    cloud.seed("day_types", [dayType]);
    cloud.seed("entries", [eleventh]);

    await syncOnce(db, USER_ID, cloud);

    const local = await db.entries.orderBy("date").toArray();
    expect(local.map((row) => [row.id, row.amount])).toEqual([
      ["e-10", 271.53],
      ["e-11", 318.47],
    ]);
    // И обе лежат в облаке: локальная уехала наверх этим же проходом.
    expect(cloud.row<Entry>("entries", "e-10")?.amount).toBe(271.53);
    expect(cloud.row<Entry>("entries", "e-11")?.amount).toBe(318.47);
  });

  it("инвариант 42: строка с updated_at из будущего не выигрывает конфликт навсегда", async () => {
    const cloud = new FakeCloud("2026-08-30T12:00:00.000Z");
    // Телефон с часами на год вперёд сохранил ставку 41.5.
    await db.periods.put(makePeriod({ id: "p-1", base_rate: 41.5, updated_at: "2027-08-30T10:00:00.000Z" }));

    await syncOnce(db, USER_ID, cloud);

    // Отметка починена серверным временем и в облаке, и локально.
    expect(cloud.row<Period>("periods", "p-1")?.updated_at).toBe("2026-08-30T12:00:00.000Z");
    expect((await db.periods.get("p-1"))?.updated_at).toBe("2026-08-30T12:00:00.000Z");

    // Теперь второе устройство правит тот же период позже — и выигрывает.
    cloud.advance(60_000);
    cloud.seed(
      "periods",
      [makePeriod({ id: "p-1", base_rate: 37.25, updated_at: "2026-08-30T12:00:30.000Z" })],
    );

    await syncOnce(db, USER_ID, cloud);

    expect((await db.periods.get("p-1"))?.base_rate).toBe(37.25);
  });

  it("инвариант 43: упавшая выгрузка не теряет локальных данных и повторяется целиком", async () => {
    const cloud = new FakeCloud();
    await db.periods.put(makePeriod({ id: "p-1", base_rate: 41.5, updated_at: "2026-08-30T09:00:00.000Z" }));
    cloud.failNextPush = "network down";

    await expect(syncOnce(db, USER_ID, cloud)).rejects.toThrow("network down");

    // Локальная строка цела, в облако ничего не легло, ошибка записана.
    expect((await db.periods.get("p-1"))?.base_rate).toBe(41.5);
    expect(cloud.rows("periods")).toEqual([]);
    expect((await readSyncMeta(db, USER_ID)).last_error).toBe("network down");

    await syncOnce(db, USER_ID, cloud);

    expect(cloud.row<Period>("periods", "p-1")?.base_rate).toBe(41.5);
    expect((await readSyncMeta(db, USER_ID)).last_error).toBeNull();
  });

  it("инвариант 43: удалённая строка исчезает из облака только после подтверждения", async () => {
    const cloud = new FakeCloud();
    const holiday = makeHoliday({ id: "h-1", updated_at: "2026-08-30T09:00:00.000Z" });
    await db.holidays.put(holiday);
    await syncOnce(db, USER_ID, cloud);

    // Мягкое удаление на телефоне, и связь обрывается посреди выгрузки.
    await db.holidays.update("h-1", { deleted_at: "2026-08-30T10:00:00.000Z", updated_at: "2026-08-30T10:00:00.000Z" });
    cloud.failNextPush = "offline";
    await expect(syncOnce(db, USER_ID, cloud)).rejects.toThrow("offline");

    // Строка на месте локально — удаление мягкое и никуда не делось, — а в
    // облаке ещё живая: сервер удаления не подтверждал.
    expect((await db.holidays.get("h-1"))?.deleted_at).toBe("2026-08-30T10:00:00.000Z");
    expect(cloud.row<Holiday>("holidays", "h-1")?.deleted_at).toBeNull();

    await syncOnce(db, USER_ID, cloud);

    expect(cloud.row<Holiday>("holidays", "h-1")?.deleted_at).toBe("2026-08-30T10:00:00.000Z");
    expect(await db.holidays.get("h-1")).toBeDefined();
  });

  it("инвариант 37: синхронизация не оставляет запись без её типа дня", async () => {
    const cloud = new FakeCloud();
    const dayType = makeDayType({ id: "dt-night", name: "Ночная" });
    const entry = makeEntry({ id: "e-night", day_type_id: "dt-night", amount: 412.81 });

    // Запись приехала на сервер РАНЬШЕ своего типа дня.
    cloud.seed("entries", [entry], "2026-08-30T09:00:00.000Z");
    cloud.seed("day_types", [dayType], "2026-08-30T09:00:05.000Z");

    await syncOnce(db, USER_ID, cloud);

    const stored = await db.entries.get("e-night");
    expect(stored).toBeDefined();
    expect(await db.day_types.get("dt-night")).toBeDefined();

    expect(stored?.amount).toBe(412.81);

    // Ни одна живая запись в базе не ссылается на отсутствующий тип дня.
    const typeIds = new Set(await db.day_types.toCollection().primaryKeys());
    const orphans = (await db.entries.toArray()).filter(
      (row) => row.deleted_at === null && !typeIds.has(row.day_type_id),
    );
    expect(orphans).toEqual([]);
  });

  it("инвариант 37: запись, чей тип дня ещё не приехал, откладывается и не теряется", async () => {
    const cloud = new FakeCloud();
    cloud.seed("entries", [makeEntry({ id: "e-orphan", day_type_id: "dt-missing" })], "2026-08-30T09:00:00.000Z");

    const first = await syncOnce(db, USER_ID, cloud);

    expect(first.deferred).toBe(1);
    expect(await db.entries.get("e-orphan")).toBeUndefined();

    // Тип дня появляется в облаке позже — запись доезжает следующим проходом.
    cloud.seed("day_types", [makeDayType({ id: "dt-missing" })], "2026-08-30T09:10:00.000Z");
    await syncOnce(db, USER_ID, cloud);

    expect(await db.entries.get("e-orphan")).toBeDefined();
  });

  it("докачка идёт по серверной отметке: второй проход не тянет то же самое заново", async () => {
    const cloud = new FakeCloud();
    cloud.seed("holidays", [makeHoliday({ id: "h-1" })], "2026-08-30T09:00:00.000Z");

    const first = await syncOnce(db, USER_ID, cloud);
    expect(first.pulled).toBe(1);

    const second = await syncOnce(db, USER_ID, cloud);
    expect(second.pulled).toBe(0);
  });

  it("собственная выгрузка не возвращается обратно как чужая правка", async () => {
    const cloud = new FakeCloud();
    await db.holidays.put(makeHoliday({ id: "h-1", updated_at: "2026-08-30T09:00:00.000Z" }));

    const first = await syncOnce(db, USER_ID, cloud);
    expect(first.pushed).toBe(1);

    // Выгрузка подняла серверную отметку выше курсора докачки, и на следующем
    // проходе строка приезжает обратно. Она в точности та же самая — принимать
    // и показывать это как изменение нельзя.
    const second = await syncOnce(db, USER_ID, cloud);
    expect(second.pulled).toBe(0);
    expect(second.pushed).toBe(0);
  });

  it("инвариант 43: упавшая вторая порция не оставляет невыгруженных строк навсегда", async () => {
    const cloud = new FakeCloud();
    // 250 строк, у которых порядок ключей ОБРАТЕН порядку правок: h-000 правили
    // последним. Порции нарезаются по 200, и знак выгрузки, поставленный по
    // первой порции, перепрыгнул бы через оставшиеся 50, будь порядок ключевым.
    const rows = Array.from({ length: 250 }, (_, i) =>
      makeHoliday({
        id: `h-${String(i).padStart(3, "0")}`,
        date: "2026-08-10",
        updated_at: new Date(Date.parse("2026-08-30T09:00:00.000Z") - i * 1000).toISOString(),
      }),
    );
    await db.holidays.bulkPut(rows);

    // Первая порция уходит, вторая падает.
    cloud.failPushAfterChunks = 1;
    await expect(syncOnce(db, USER_ID, cloud)).rejects.toThrow();
    await syncOnce(db, USER_ID, cloud);
    await syncOnce(db, USER_ID, cloud);

    expect(cloud.rows("holidays")).toHaveLength(250);
  });

  it("инвариант 37: застрявшая докачка записей расталкивает себя сама", async () => {
    const cloud = new FakeCloud();
    cloud.seed("day_types", [makeDayType({ id: "dt-night" })], "2026-08-30T09:00:00.000Z");
    cloud.seed(
      "entries",
      [makeEntry({ id: "e-night", day_type_id: "dt-night", amount: 412.81 })],
      "2026-08-30T09:30:00.000Z",
    );
    // Курсор типов дня уже за их строкой, а самого типа в базе нет: так
    // выглядит устройство, чью базу очистили после докачки. Без сброса курсора
    // запись ждала бы тип, который никогда не приедет.
    await db.sync_meta.put({
      user_id: USER_ID,
      pull_cursor: { day_types: "2026-08-30T09:10:00.000Z" },
      pushed_through: {},
      clock_guard: 0,
      last_sync_at: null,
      last_error: null,
    });

    const first = await syncOnce(db, USER_ID, cloud);
    expect(first.deferred).toBe(1);

    const second = await syncOnce(db, USER_ID, cloud);

    expect(second.deferred).toBe(0);
    expect((await db.entries.get("e-night"))?.amount).toBe(412.81);
    expect(await db.day_types.get("dt-night")).toBeDefined();
  });

  it("строка настроек получает облачный идентификатор: два устройства не плодят вторую", async () => {
    const cloud = new FakeCloud();
    await db.settings.put(makeSettings({ id: "s-local-random", default_base_rate: 33.75 }));

    await syncOnce(db, USER_ID, cloud);

    const rows = await db.settings.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(USER_ID);
    expect(rows[0].default_base_rate).toBe(33.75);
    expect(cloud.rows("settings").map((row) => row.id)).toEqual([USER_ID]);
  });
});
