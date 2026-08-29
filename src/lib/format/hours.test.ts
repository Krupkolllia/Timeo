import { describe, expect, it } from "vitest";
import { formatHours } from "@/lib/format/hours";

describe("formatHours", () => {
  it.each([
    [8, "8"],
    [7.5, "7.5"],
    [7.25, "7.25"],
    // Ради этого случая функция и существует: 7ч20м лежит в базе как 440/60.
    [440 / 60, "7.33"],
    [485 / 60, "8.08"],
    [1 / 60, "0.02"],
    [0, "0"],
    [24, "24"],
    // Хвостовые нули убираются: «7.50ч» в ячейке календаря читается хуже.
    [7.5000001, "7.5"],
    [8.004, "8"],
    // Инвариант 24: отрицательные значения законны и не должны ломать формат.
    [-7.5, "-7.5"],
    [-440 / 60, "-7.33"],
  ])("%s → %s", (value, expected) => {
    expect(formatHours(value)).toBe(expected);
  });

  it("не роняется на нечисловых значениях", () => {
    expect(formatHours(NaN)).toBe("NaN");
    expect(formatHours(Infinity)).toBe("Infinity");
  });
});
