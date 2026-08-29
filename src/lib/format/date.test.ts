import { describe, expect, it } from "vitest";
import { formatDayShort, formatDayTitle } from "@/lib/format/date";

describe("formatDayTitle", () => {
  it("renders the day in the genitive case with the weekday", () => {
    expect(formatDayTitle("2026-08-28")).toBe("28 августа, Пт");
  });

  it("maps Sunday to the last column of a Monday-first week", () => {
    // getDay() считает от воскресенья, неделя в приложении — от понедельника
    // (раздел 5.1). Ошибка на единицу здесь сдвигает подпись каждого дня.
    expect(formatDayTitle("2026-08-30")).toBe("30 августа, Вс");
    expect(formatDayTitle("2026-08-31")).toBe("31 августа, Пн");
  });

  it("does not shift the date through UTC (invariant 27)", () => {
    // new Date("2026-01-01") — это UTC-полночь; на положительном смещении она
    // превратилась бы в 31 декабря.
    expect(formatDayTitle("2026-01-01")).toBe("1 января, Чт");
  });

  it("handles a leap day as an ordinary day (invariant 34)", () => {
    expect(formatDayTitle("2028-02-29")).toBe("29 февраля, Вт");
  });
});

describe("formatDayShort", () => {
  it("renders the abbreviated month used by the period breakdown", () => {
    expect(formatDayShort("2026-08-28")).toBe("28 авг, Пт");
    expect(formatDayShort("2026-05-01")).toBe("1 мая, Пт");
  });
});
