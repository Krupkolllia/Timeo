import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { App } from "@/app/App";
import { usePwaStore } from "@/store/pwaStore";
import { ru } from "@/i18n/ru";
import { resetDb } from "@/test/factories";

vi.mock("@/db/localUser", () => ({ getLocalUserId: () => "user-test" }));

beforeEach(async () => {
  await resetDb();
  usePwaStore.setState({ needsRefresh: false, applyUpdate: () => {} });
  window.history.pushState({}, "", "/");
});

describe("App", () => {
  it("открывается на календаре", async () => {
    render(<App />);
    await waitFor(() => expect(screen.queryByText(ru.calendar.loading)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: ru.calendar.prevPeriod })).toBeInTheDocument();
  });

  it("показывает плашку обновления поверх маршрутов", async () => {
    usePwaStore.setState({ needsRefresh: true });
    render(<App />);
    expect(await screen.findByRole("button", { name: ru.app.updateAvailable })).toBeInTheDocument();
  });

  it("неизвестный адрес показывает панель ошибки, а не пустой экран (инвариант 58)", async () => {
    // Роутер создаётся на импорте модуля и запоминает текущий адрес, поэтому
    // адрес задаётся до импорта, а модули сбрасываются.
    window.history.pushState({}, "", "/такого-адреса-нет");
    vi.resetModules();
    const { App: FreshApp } = await import("@/app/App");

    render(<FreshApp />);
    expect(await screen.findByText(ru.error.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ru.error.reload })).toBeInTheDocument();
  });
});
