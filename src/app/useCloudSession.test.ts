import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { FOREGROUND_SYNC_INTERVAL_MS, useCloudSession } from "@/app/useCloudSession";
import { useSyncStore } from "@/store/syncStore";

const handleAccountChange = vi.fn().mockResolvedValue(undefined);
const runSync = vi.fn().mockResolvedValue(undefined);
const currentAccount = vi.fn().mockResolvedValue(null);
const completeOAuthReturn = vi.fn().mockResolvedValue({ kind: "none" });
const unsubscribe = vi.fn();
let authCallback: ((account: unknown) => void) | null = null;

vi.mock("@/lib/sync/controller", () => ({
  handleAccountChange: (...args: unknown[]) => handleAccountChange(...args),
  runSync: (...args: unknown[]) => runSync(...args),
}));

vi.mock("@/lib/sync/auth", () => ({
  currentAccount: () => currentAccount(),
  completeOAuthReturn: () => completeOAuthReturn(),
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
  currentAccount.mockResolvedValue(null);
  completeOAuthReturn.mockResolvedValue({ kind: "none" });
  useSyncStore.setState({ signInError: null });
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

  it("возврат от провайдера разбирается раньше вопроса о сессии", async () => {
    const account = { userId: "u-google", email: "father@example.com" };
    completeOAuthReturn.mockImplementation(() => {
      // Обмен кода и создаёт ту сессию, о которой спрашивает currentAccount:
      // спросить раньше — значит не увидеть только что случившийся вход.
      currentAccount.mockResolvedValue(account);
      return Promise.resolve({ kind: "signed_in", account });
    });

    renderHook(() => useCloudSession());

    await vi.waitFor(() => expect(handleAccountChange).toHaveBeenCalled());
    expect(handleAccountChange.mock.calls[0][2]).toEqual(account);
    expect(useSyncStore.getState().signInError).toBeNull();
  });

  it("отказ провайдера доезжает до экрана словами, а облако всё равно заводится", async () => {
    completeOAuthReturn.mockResolvedValue({ kind: "failed", code: "oauth_cancelled", message: "denied" });

    renderHook(() => useCloudSession());

    await vi.waitFor(() => expect(useSyncStore.getState().signInError).toBe("oauth_cancelled"));
    // Отказ не обрывает запуск: сессию всё равно спросили, синхронизацию завели.
    expect(currentAccount).toHaveBeenCalled();
    await vi.waitFor(() => expect(handleAccountChange).toHaveBeenCalled());
  });

  it("упавший разбор возврата не оставляет запуск облака недоделанным", async () => {
    completeOAuthReturn.mockRejectedValue(new Error("history is not available"));

    renderHook(() => useCloudSession());

    await vi.waitFor(() => expect(useSyncStore.getState().signInError).toBe("oauth_failed"));
    await vi.waitFor(() => expect(handleAccountChange).toHaveBeenCalled());
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
