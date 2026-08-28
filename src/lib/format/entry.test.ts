import { describe, expect, it } from "vitest";
import { formatEntryDetail, rateNote } from "@/lib/format/entry";
import type { Entry } from "@/types/models";

type Detail = Parameters<typeof formatEntryDetail>[0];

function entry(overrides: Partial<Entry> = {}): Detail {
  return {
    hours: 8,
    rate_per_hour: 30,
    multiplier: 1,
    amount_override: null,
    rate_source: "period_base",
    rate_is_manual: false,
    ...overrides,
  };
}

describe("formatEntryDetail", () => {
  it("раскладывает почасовую запись на часы, ставку и множитель", () => {
    expect(formatEntryDetail(entry({ multiplier: 1.5, rate_per_hour: 45 }), "hourly")).toBe("8ч × 45.00 · ×1.5");
  });

  it("не показывает произведение там, где сумма от ставки не зависит", () => {
    expect(formatEntryDetail(entry({ hours: 0 }), "unpaid")).toBe("0ч · не оплачивается");
    expect(formatEntryDetail(entry(), "fixed_amount")).toBe("8ч · Фиксированная сумма за день");
  });

  it("отмечает замороженную ставку, ручную ставку и ручную сумму", () => {
    expect(formatEntryDetail(entry({ rate_is_manual: true, rate_source: "frozen" }), "hourly")).toContain(
      "ставка зафиксирована",
    );
    expect(formatEntryDetail(entry({ rate_is_manual: true, rate_source: "manual" }), "hourly")).toContain(
      "ставка вручную",
    );
    expect(formatEntryDetail(entry({ amount_override: 500 }), "hourly")).toContain("сумма вручную");
  });

  it("ручная сумма важнее происхождения ставки", () => {
    expect(rateNote(entry({ amount_override: 500, rate_is_manual: true, rate_source: "frozen" }))).toBe(
      "сумма вручную",
    );
  });

  it("для обычной записи подписи нет — «ставка периода» ничего не объясняет", () => {
    expect(rateNote(entry())).toBeNull();
  });

  it("тип дня мог быть удалён — формат не должен падать", () => {
    expect(formatEntryDetail(entry(), undefined)).toBe("8ч × 30.00 · ×1");
  });
});
