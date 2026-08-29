import { describe, expect, it } from "vitest";
import { buildHolidayByDate, compareHolidays, pickHoliday, polishHolidaysForYear } from "@/lib/calc/holidays";
import type { Holiday } from "@/types/models";

function makeHoliday(overrides: Partial<Holiday> = {}): Holiday {
  return {
    id: "h-1",
    user_id: "user-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    date: "2026-05-01",
    name: "Праздник труда",
    is_custom: false,
    ...overrides,
  };
}

describe("polishHolidaysForYear", () => {
  it("даёт тринадцать праздников", () => {
    expect(polishHolidaysForYear(2026)).toHaveLength(13);
  });

  it("подставляет подвижные праздники от Пасхи 2026 года (5 апреля)", () => {
    const byName = new Map(polishHolidaysForYear(2026).map((h) => [h.name, h.date]));
    expect(byName.get("Пасха")).toBe("2026-04-05");
    expect(byName.get("Пасхальный понедельник")).toBe("2026-04-06");
    // +49 и +60 дней от 5 апреля.
    expect(byName.get("Пятидесятница")).toBe("2026-05-24");
    expect(byName.get("Праздник Тела Христова")).toBe("2026-06-04");
  });

  it("считает подвижные праздники через границу месяца при мартовской Пасхе", () => {
    // 2024: Пасха 31 марта, значит понедельник — уже 1 апреля.
    const byName = new Map(polishHolidaysForYear(2024).map((h) => [h.name, h.date]));
    expect(byName.get("Пасха")).toBe("2024-03-31");
    expect(byName.get("Пасхальный понедельник")).toBe("2024-04-01");
    expect(byName.get("Пятидесятница")).toBe("2024-05-19");
    expect(byName.get("Праздник Тела Христова")).toBe("2024-05-30");
  });

  it("в високосном году считает через 29 февраля без особой обработки", () => {
    const dates = polishHolidaysForYear(2024).map((h) => h.date);
    // Все даты принадлежат запрошенному году и разбираются обратно один в один
    // (инвариант 27: никакого UTC).
    for (const iso of dates) {
      const [y, m, d] = iso.split("-").map(Number);
      expect(y).toBe(2024);
      const local = new Date(y, m - 1, d);
      expect(local.getFullYear()).toBe(y);
      expect(local.getMonth() + 1).toBe(m);
      expect(local.getDate()).toBe(d);
    }
  });

  it("даёт строки YYYY-MM-DD, отсортированные по дате", () => {
    const dates = polishHolidaysForYear(2027).map((h) => h.date);
    for (const iso of dates) expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...dates].sort()).toEqual(dates);
  });

  it("не даёт двух праздников на одну дату ни в одном году до 2100", () => {
    for (let year = 2020; year <= 2100; year++) {
      const dates = polishHolidaysForYear(year).map((h) => h.date);
      expect(new Set(dates).size).toBe(dates.length);
    }
  });
});

describe("compareHolidays / pickHoliday — инвариант 53", () => {
  const earlier = makeHoliday({ id: "b", created_at: "2026-01-01T00:00:00.000Z", name: "Праздник труда" });
  const later = makeHoliday({ id: "a", created_at: "2026-02-01T00:00:00.000Z", name: "День фирмы" });

  it("выбирает самый ранний по created_at, а не самый ранний по id", () => {
    expect(pickHoliday([earlier, later])?.name).toBe("Праздник труда");
  });

  it("даёт тот же ответ при любом порядке входа", () => {
    expect(pickHoliday([later, earlier])?.id).toBe(pickHoliday([earlier, later])?.id);
  });

  it("при одинаковом created_at решает id", () => {
    const same = makeHoliday({ id: "a", name: "День фирмы" });
    expect(pickHoliday([earlier, same])?.id).toBe("a");
    expect(pickHoliday([same, earlier])?.id).toBe("a");
  });

  it("на пустом списке даёт undefined", () => {
    expect(pickHoliday([])).toBeUndefined();
  });

  it("compareHolidays даёт ноль для одной и той же строки", () => {
    expect(compareHolidays(earlier, earlier)).toBe(0);
  });
});

describe("buildHolidayByDate", () => {
  it("оставляет на дате победителя по инварианту 53, а не последнюю строку", () => {
    const earlier = makeHoliday({ id: "b", created_at: "2026-01-01T00:00:00.000Z", name: "Праздник труда" });
    const later = makeHoliday({ id: "c", created_at: "2026-02-01T00:00:00.000Z", name: "День фирмы" });
    expect(buildHolidayByDate([earlier, later]).get("2026-05-01")?.name).toBe("Праздник труда");
    expect(buildHolidayByDate([later, earlier]).get("2026-05-01")?.name).toBe("Праздник труда");
  });

  it("совпадает с pickHoliday на той же выборке", () => {
    const rows = [
      makeHoliday({ id: "b", created_at: "2026-02-01T00:00:00.000Z" }),
      makeHoliday({ id: "a", created_at: "2026-01-01T00:00:00.000Z" }),
      makeHoliday({ id: "c", date: "2026-05-03", created_at: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(buildHolidayByDate(rows).get("2026-05-01")?.id).toBe(pickHoliday(rows.filter((h) => h.date === "2026-05-01"))?.id);
    expect(buildHolidayByDate(rows).size).toBe(2);
  });
});
