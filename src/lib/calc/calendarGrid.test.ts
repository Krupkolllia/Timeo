import { describe, expect, it } from "vitest";
import { buildWeeks, toISODate } from "@/lib/calc/calendarGrid";

describe("toISODate", () => {
  it("pads month and day to two digits", () => {
    expect(toISODate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("buildWeeks", () => {
  it("pads the range to full Monday-start weeks", () => {
    // 2026-02-01 is a Sunday, 2026-02-28 is a Saturday.
    const weeks = buildWeeks(new Date(2026, 1, 1), new Date(2026, 1, 28));

    expect(weeks[0][0]).toEqual(new Date(2026, 0, 26)); // Monday before Feb 1
    expect(weeks[0]).toHaveLength(7);
    const lastWeek = weeks[weeks.length - 1];
    expect(lastWeek[lastWeek.length - 1]).toEqual(new Date(2026, 2, 1)); // Sunday after Feb 28
  });

  it("returns a single week when the range already fits one", () => {
    // 2026-06-01 is a Monday, 2026-06-07 is a Sunday.
    const weeks = buildWeeks(new Date(2026, 5, 1), new Date(2026, 5, 7));

    expect(weeks).toHaveLength(1);
    expect(weeks[0][0]).toEqual(new Date(2026, 5, 1));
    expect(weeks[0][6]).toEqual(new Date(2026, 5, 7));
  });
});
