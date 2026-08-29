import { describe, expect, it } from "vitest";
import { roundHours, roundMoney, roundMultiplier } from "@/lib/calc/round";

describe("roundMoney", () => {
  it("keeps money at two decimals", () => {
    expect(roundMoney(399.59999999999997)).toBe(399.6);
    expect(roundMoney(8 * 33.3 * 1.5)).toBe(399.6);
    expect(roundMoney(0)).toBe(0);
  });

  it("rounds negative amounts towards +Infinity, as documented", () => {
    // Раздел 8 разрешает отрицательные суммы; асимметрия на копейку выбрана
    // осознанно и зафиксирована здесь, чтобы не «исправиться» молча.
    expect(roundMoney(-1.505)).toBe(-1.5);
    expect(roundMoney(-1.506)).toBe(-1.51);
  });

  it("passes non-finite values through untouched", () => {
    // NaN и Infinity сюда доходить не должны, но округлять их в 0 значило бы
    // спрятать испорченное число вместо того, чтобы показать его.
    expect(roundMoney(Number.NaN)).toBeNaN();
    expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundMoney(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("roundMultiplier", () => {
  it("keeps multipliers at three decimals", () => {
    expect(roundMultiplier(1.5015015015015014)).toBe(1.502);
    expect(roundMultiplier(2)).toBe(2);
  });

  it("passes non-finite values through untouched", () => {
    expect(roundMultiplier(Number.NaN)).toBeNaN();
    expect(roundMultiplier(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("roundHours", () => {
  it("keeps hours at two decimals", () => {
    expect(roundHours(0.1 + 0.2)).toBe(0.3);
    expect(roundHours(8)).toBe(8);
  });

  it("passes non-finite values through untouched", () => {
    expect(roundHours(Number.NaN)).toBeNaN();
    expect(roundHours(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});
