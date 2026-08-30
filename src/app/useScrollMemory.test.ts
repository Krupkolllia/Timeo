import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScrollMemory } from "@/app/useScrollMemory";

afterEach(() => {
  document.body.scrollTop = 0;
});

describe("useScrollMemory", () => {
  it("восстанавливает прокрутку, сохранённую на предыдущем заходе с тем же ключом", () => {
    const { unmount } = renderHook(() => useScrollMemory("/settings", true));
    document.body.scrollTop = 240;
    document.body.dispatchEvent(new Event("scroll"));
    unmount();

    document.body.scrollTop = 0;
    renderHook(() => useScrollMemory("/settings", true));

    expect(document.body.scrollTop).toBe(240);
  });

  it("не восстанавливает, пока контент не готов (ready=false)", () => {
    document.body.scrollTop = 0;
    renderHook(() => useScrollMemory("/never-scrolled-key", false));
    expect(document.body.scrollTop).toBe(0);
  });
});
