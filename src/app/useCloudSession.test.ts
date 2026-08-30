import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { FOREGROUND_SYNC_INTERVAL_MS, useCloudSession } from "@/app/useCloudSession";

const handleAccountChange = vi.fn().mockResolvedValue(undefined);
const runSync = vi.fn().mockResolvedValue(undefined);
const currentAccount = vi.fn().mockResolvedValue(null);
const unsubscribe = vi.fn();
let authCallback: ((account: unknown) => void) | null = null;

vi.mock("@/lib/sync/controller", () => ({
  handleAccountChange: (...args: unknown[]) => handleAccountChange(...args),
  runSync: (...args: unknown[]) => runSync(...args),
}));

vi.mock("@/lib/sync/auth", () => ({
  currentAccount: () => currentAccount(),
  onAuthChange: (cb: (account: unknown) => void) => {
    authCallback = cb;
    return unsubscribe;
  },
  isCloudConfigured: () => true,
}));

vi.mock("@/lib/sync/cloud", () => ({ cloudGateway: { serverNow: () => Promise.resolve("now") } }));

beforeEach(() => {
  vi.clearAllMocks();
  authCallback = null;
});

describe("useCloudSession", () => {
  it("спрашивает сессию при запуске и подписывается на вход и выход", async () => {
    const { unmount } = renderHook(() => useCloudSession());

    await vi.waitFor(() => expect(handleAccountChange).toHaveBeenCalled());
    expect(typeof authCallback).toBe("function");

    authCallback?.({ userId: "u-1", email: "a@b.c" });
    expect(handleAccountChange).toHaveBeenCalledTimes(2);

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("синхронизирует при возврате в приложение, появлении сети и по таймеру", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useCloudSession());

      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(FOREGROUND_SYNC_INTERVAL_MS);

      // visibilityState в jsdom — "visible", поэтому считаются все три события.
      expect(runSync).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("после размонтирования события больше ничего не запускают", () => {
    const { unmount } = renderHook(() => useCloudSession());
    unmount();
    runSync.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));

    expect(runSync).not.toHaveBeenCalled();
  });
});
