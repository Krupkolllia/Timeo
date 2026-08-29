import { describe, expect, it } from "vitest";
import { usePwaStore } from "@/store/pwaStore";

describe("pwaStore", () => {
  it("стартует без обновления, и применение до регистрации ничего не ломает", () => {
    usePwaStore.setState({ needsRefresh: false, applyUpdate: usePwaStore.getInitialState().applyUpdate });
    expect(usePwaStore.getState().needsRefresh).toBe(false);
    // До registerPwaUpdates применять нечего — вызов обязан быть безопасным.
    expect(() => usePwaStore.getState().applyUpdate()).not.toThrow();
  });
});
