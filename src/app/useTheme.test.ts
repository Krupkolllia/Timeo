import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "@/app/useTheme";

function setMatches(matches: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches,
    media: "(prefers-color-scheme: light)",
    onchange: null,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  return { fire: () => listeners.forEach((listener) => listener()) };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

describe("useTheme", () => {
  it("light ставит data-theme=light и обновляет meta theme-color", () => {
    renderHook(() => useTheme("light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#f8fafc");
  });

  it("dark ставит data-theme=dark", () => {
    renderHook(() => useTheme("dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#0f172a");
  });

  it("до приезда настроек (undefined) тема остаётся тёмной", () => {
    setMatches(true);
    renderHook(() => useTheme(undefined));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("system читает matchMedia и реагирует на его смену", () => {
    const { fire } = setMatches(false);
    renderHook(() => useTheme("system"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    fire();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
