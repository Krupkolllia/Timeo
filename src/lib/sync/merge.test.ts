import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_TOLERANCE_MS,
  clampFutureUpdatedAt,
  comparableUpdatedAt,
  planDayTypesPull,
  planEntriesPull,
  planPull,
  resolveRow,
  rowsEqual,
} from "@/lib/sync/merge";
import { makeDayType, makeEntry, makePeriod } from "@/test/factories";
import type { RemoteRow } from "@/lib/sync/types";
import type { BaseRecord, DayType, Entry, Period } from "@/types/models";

const SERVER_NOW = "2026-08-30T12:00:00.000Z";

function remote<T extends BaseRecord>(row: T, serverAt: string): RemoteRow<T> {
  return { ...row, server_updated_at: serverAt };
}

describe("resolveRow", () => {
  it("побеждает более свежая правка, ничья остаётся за облаком", () => {
    const older = { updated_at: "2026-08-30T10:11:13.000Z" };
    const newer = { updated_at: "2026-08-30T10:11:14.000Z" };

    expect(resolveRow(newer, { ...older, server_updated_at: SERVER_NOW }, SERVER_NOW)).toBe("local");
    expect(resolveRow(older, { ...newer, server_updated_at: SERVER_NOW }, SERVER_NOW)).toBe("remote");
    expect(resolveRow(older, { ...older, server_updated_at: SERVER_NOW }, SERVER_NOW)).toBe("remote");
  });

  it("инвариант 42: чужая правка с часами на год вперёд не выигрывает у более поздней настоящей", () => {
    // Устройство с часами на год вперёд выгрузило строку: клиентская отметка —
    // 2027 год, серверная — момент приёма, вчера.
    const fromFastClock = {
      updated_at: "2027-08-30T10:00:00.000Z",
      server_updated_at: "2026-08-29T12:00:00.000Z",
    };
    // Наша правка сделана сегодня, часы исправны.
    const mine = { updated_at: "2026-08-30T11:59:00.000Z" };

    expect(resolveRow(mine, fromFastClock, SERVER_NOW)).toBe("local");
  });

  it("отметка в пределах допуска остаётся собственной отметкой строки", () => {
    const slightlyAhead = {
      updated_at: new Date(Date.parse(SERVER_NOW) + CLOCK_SKEW_TOLERANCE_MS - 1000).toISOString(),
      server_updated_at: "2026-08-01T00:00:00.000Z",
    };
    expect(comparableUpdatedAt(slightlyAhead, SERVER_NOW)).toBe(Date.parse(slightlyAhead.updated_at));

    const wayAhead = { ...slightlyAhead, updated_at: "2027-01-01T00:00:00.000Z" };
    expect(comparableUpdatedAt(wayAhead, SERVER_NOW)).toBe(Date.parse(wayAhead.server_updated_at));
  });

  it("непарсимая отметка времени проигрывает, а не выигрывает у всех", () => {
    expect(resolveRow({ updated_at: "не дата" }, { updated_at: "2026-01-01T00:00:00.000Z" }, SERVER_NOW)).toBe("remote");
  });
});

describe("clampFutureUpdatedAt", () => {
  it("чинит отметку из будущего серверным временем и не трогает исправную", () => {
    const future = makePeriod({ updated_at: "2027-08-30T10:00:00.000Z" });
    const sane = makePeriod({ updated_at: "2026-08-30T10:00:00.000Z" });

    expect(clampFutureUpdatedAt(future, SERVER_NOW).updated_at).toBe(SERVER_NOW);
    expect(clampFutureUpdatedAt(sane, SERVER_NOW)).toBe(sane);
  });

  it("чинится только момент правки: ни одно число периода не меняется", () => {
    const closed = makePeriod({
      updated_at: "2027-08-30T10:00:00.000Z",
      is_closed: true,
      base_rate: 33.75,
      closed_totals: { amount: 4211.19, total_hours: 167.5, norm_hours_covered: 160 },
    });

    const repaired = clampFutureUpdatedAt(closed, SERVER_NOW);
    expect(repaired.closed_totals).toEqual(closed.closed_totals);
    expect(repaired.base_rate).toBe(33.75);
    expect(repaired.is_closed).toBe(true);
  });
});

describe("planPull", () => {
  it("инвариант 41: правки разных строк одного периода с двух устройств выживают обе", () => {
    // Локально правили запись за 10-е, в облаке — за 11-е. Обе в августе.
    const localTenth = makeEntry({ id: "e-10", date: "2026-08-10", amount: 271.53, updated_at: "2026-08-30T09:00:00.000Z" });
    const remoteEleventh = remote(
      makeEntry({ id: "e-11", date: "2026-08-11", amount: 318.47, updated_at: "2026-08-30T09:30:00.000Z" }),
      "2026-08-30T09:30:05.000Z",
    );

    const plan = planPull<Entry>(new Map([[localTenth.id, localTenth]]), [remoteEleventh], SERVER_NOW);

    expect(plan.apply.map((row) => row.id)).toEqual(["e-11"]);
    expect(plan.keptLocal).toEqual([]);
    // Локальная строка в плане не упоминается вовсе — её никто не трогает.
    expect(plan.apply.find((row) => row.id === "e-10")).toBeUndefined();
  });

  it("серверная колонка не попадает в локальную строку", () => {
    const row = remote(makePeriod({ id: "p-1" }), "2026-08-30T09:30:05.000Z");
    const plan = planPull<Period>(new Map(), [row], SERVER_NOW);
    expect(plan.apply[0]).not.toHaveProperty("server_updated_at");
  });

  it("устаревшая облачная версия не применяется, а ставится в очередь на выгрузку", () => {
    const local = makePeriod({ id: "p-1", base_rate: 41.5, updated_at: "2026-08-30T11:00:00.000Z" });
    const stale = remote(makePeriod({ id: "p-1", base_rate: 30, updated_at: "2026-08-29T11:00:00.000Z" }), "2026-08-29T11:00:01.000Z");

    const plan = planPull<Period>(new Map([[local.id, local]]), [stale], SERVER_NOW);

    expect(plan.apply).toEqual([]);
    expect(plan.keptLocal).toEqual(["p-1"]);
  });
});

describe("planEntriesPull", () => {
  it("инвариант 37: запись без своего типа дня не записывается, а откладывается", () => {
    const orphan = remote(makeEntry({ id: "e-new", day_type_id: "dt-unknown" }), "2026-08-30T09:30:05.000Z");
    const known = remote(makeEntry({ id: "e-known", day_type_id: "dt-hourly" }), "2026-08-30T09:30:06.000Z");

    const plan = planEntriesPull(new Map(), [orphan, known], SERVER_NOW, new Set(["dt-hourly"]));

    expect(plan.apply.map((row) => row.id)).toEqual(["e-known"]);
    expect(plan.deferred.map((row) => row.id)).toEqual(["e-new"]);
  });

  it("удаление записи применяется даже без типа дня: осиротить оно не может", () => {
    const deletion = remote(
      makeEntry({ id: "e-gone", day_type_id: "dt-unknown", deleted_at: "2026-08-30T09:00:00.000Z" }),
      "2026-08-30T09:30:05.000Z",
    );

    const plan = planEntriesPull(new Map(), [deletion], SERVER_NOW, new Set());

    expect(plan.apply.map((row) => row.id)).toEqual(["e-gone"]);
    expect(plan.deferred).toEqual([]);
  });
});

describe("rowsEqual", () => {
  it("эхо собственной выгрузки узнаётся, даже если Postgres переставил ключи внутри jsonb", () => {
    const own = makePeriod({
      id: "p-08",
      is_closed: true,
      closed_totals: { amount: 4128.72, total_hours: 168, norm_hours_covered: 168 },
    });
    // Ровно та же строка, вернувшаяся из облака: jsonb хранит ключи в своём
    // порядке, и порядок полей верхнего уровня тоже другой.
    const echoed = {
      ...own,
      closed_totals: { norm_hours_covered: 168, amount: 4128.72, total_hours: 168 },
    } as typeof own;

    expect(rowsEqual(own, echoed)).toBe(true);
  });

  it("разное содержимое вложенного объекта остаётся разным", () => {
    const own = makePeriod({ id: "p-08", closed_totals: { amount: 4128.72, total_hours: 168, norm_hours_covered: 168 } });
    const other = { ...own, closed_totals: { amount: 4128.73, total_hours: 168, norm_hours_covered: 168 } } as typeof own;

    expect(rowsEqual(own, other)).toBe(false);
  });
});

describe("planDayTypesPull", () => {
  it("инвариант 37: приехавшее удаление типа дня не применяется, пока на него ссылаются живые записи", () => {
    // Имена намеренно разные: на одинаковых проверка ниже проходила бы при
    // любом поведении и ничего бы не доказывала.
    const local = makeDayType({ id: "dt-hourly", name: "Смена", updated_at: "2026-08-01T00:00:00.000Z" });
    const deletion = remote(
      makeDayType({
        id: "dt-hourly",
        name: "Ночная смена",
        deleted_at: "2026-08-30T09:00:00.000Z",
        updated_at: "2026-08-30T09:00:00.000Z",
      }),
      "2026-08-30T09:30:05.000Z",
    );

    const plan = planDayTypesPull(
      new Map<string, DayType>([[local.id, local]]),
      [deletion],
      SERVER_NOW,
      new Set(["dt-hourly"]),
    );

    expect(plan.apply).toEqual([]);
    expect(plan.resurrect.map((row) => row.id)).toEqual(["dt-hourly"]);
    expect(plan.resurrect[0].deleted_at).toBeNull();
  });

  it("воскрешение берёт приехавшее имя, а не устаревшее локальное", () => {
    // Другое устройство переименовало тип и потом удалило его. Локальная
    // версия старше — она проиграла last-write-wins и попала сюда только
    // потому, что удаление применить нельзя. Разлить её обратно значит
    // откатить переименование на всех устройствах: воскрешённое уходит в
    // forcePush и выгружается поверх облачной версии.
    const local = makeDayType({ id: "dt-hourly", name: "Смена", updated_at: "2026-08-01T00:00:00.000Z" });
    const deletion = remote(
      makeDayType({
        id: "dt-hourly",
        name: "Ночная смена",
        default_multiplier: 1.5,
        deleted_at: "2026-08-30T09:00:00.000Z",
        updated_at: "2026-08-30T09:00:00.000Z",
      }),
      "2026-08-30T09:30:05.000Z",
    );

    const plan = planDayTypesPull(
      new Map<string, DayType>([[local.id, local]]),
      [deletion],
      SERVER_NOW,
      new Set(["dt-hourly"]),
    );

    expect(plan.resurrect[0].name).toBe("Ночная смена");
    expect(plan.resurrect[0].default_multiplier).toBe(1.5);
    expect(plan.resurrect[0].deleted_at).toBeNull();
  });

  it("удаление типа дня, на который никто не ссылается, применяется как обычная строка", () => {
    const local = makeDayType({ id: "dt-old", updated_at: "2026-08-01T00:00:00.000Z" });
    const deletion = remote(
      makeDayType({ id: "dt-old", deleted_at: "2026-08-30T09:00:00.000Z", updated_at: "2026-08-30T09:00:00.000Z" }),
      "2026-08-30T09:30:05.000Z",
    );

    const plan = planDayTypesPull(new Map<string, DayType>([[local.id, local]]), [deletion], SERVER_NOW, new Set());

    expect(plan.apply.map((row) => row.id)).toEqual(["dt-old"]);
    expect(plan.resurrect).toEqual([]);
  });
});
