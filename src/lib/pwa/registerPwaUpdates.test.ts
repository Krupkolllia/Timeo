import { beforeEach, describe, expect, it, vi } from "vitest";

const registerSW = vi.fn();
vi.mock("virtual:pwa-register", () => ({ registerSW: (options: unknown) => registerSW(options) }));

import { registerPwaUpdates } from "@/lib/pwa/registerPwaUpdates";
import { usePwaStore } from "@/store/pwaStore";

type Options = {
  onNeedRefresh: () => void;
  onRegisteredSW: (url: string, registration?: { update: () => void }) => void;
};

beforeEach(() => {
  registerSW.mockReset();
  usePwaStore.setState({ needsRefresh: false, applyUpdate: () => {} });
});

describe("registerPwaUpdates", () => {
  it("поднимает флаг обновления и вешает применение на стор", () => {
    const updateSW = vi.fn();
    registerSW.mockReturnValue(updateSW);
    registerPwaUpdates();

    const options = registerSW.mock.calls[0][0] as Options;
    options.onNeedRefresh();
    expect(usePwaStore.getState().needsRefresh).toBe(true);

    usePwaStore.getState().applyUpdate();
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it("перепроверяет обновление при возвращении на передний план", () => {
    // Раздел 12: без этого телефон, поднятый из фона, может сидеть на старой
    // сборке сколько угодно.
    registerSW.mockReturnValue(vi.fn());
    registerPwaUpdates();

    const options = registerSW.mock.calls[0][0] as Options;
    const update = vi.fn();
    options.onRegisteredSW("/sw.js", { update });

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenCalled();

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(update).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("без регистрации сервис-воркера ничего не слушает", () => {
    registerSW.mockReturnValue(vi.fn());
    registerPwaUpdates();

    const options = registerSW.mock.calls[0][0] as Options;
    const addEventListener = vi.spyOn(document, "addEventListener");
    options.onRegisteredSW("/sw.js", undefined);
    expect(addEventListener).not.toHaveBeenCalled();
    addEventListener.mockRestore();
  });
});
