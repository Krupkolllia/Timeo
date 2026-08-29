import { describe, expect, it } from "vitest";
import { easterSunday } from "@/lib/calc/easter";

describe("easterSunday", () => {
  // Известные даты григорианской Пасхи. 2024 — високосный год И мартовская
  // Пасха разом (инвариант 34), 2038 и 2011 — крайние поздние/ранние случаи.
  it.each([
    [2020, 4, 12],
    [2021, 4, 4],
    [2022, 4, 17],
    [2023, 4, 9],
    [2024, 3, 31],
    [2025, 4, 20],
    [2026, 4, 5],
    [2027, 3, 28],
    [2028, 4, 16],
    [2030, 4, 21],
    [2011, 4, 24],
    [2038, 4, 25],
  ])("%i", (year, month, day) => {
    expect(easterSunday(year)).toEqual({ year, month, day });
  });

  it("всегда попадает в март или апрель", () => {
    for (let year = 1900; year <= 2100; year++) {
      const easter = easterSunday(year);
      expect([3, 4]).toContain(easter.month);
      expect(easter.day).toBeGreaterThanOrEqual(1);
      expect(easter.day).toBeLessThanOrEqual(31);
    }
  });

  it("всегда воскресенье", () => {
    for (let year = 1900; year <= 2100; year++) {
      const { month, day } = easterSunday(year);
      expect(new Date(year, month - 1, day).getDay()).toBe(0);
    }
  });
});
