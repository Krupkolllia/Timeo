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

  // Клик по <a> реального BrowserRouter в jsdom падает на AbortSignal внутри
  // undici (несовместимость jsdom и Node на этой версии, независимая от
  // нашего кода) — тот же класс проблем, из-за которого страницы в остальных
  // тестах рендерятся в MemoryRouter напрямую, а не через вложенный маршрут.
  // Поэтому переход проверяется тем же приёмом, что и в тесте «неизвестный
  // адрес» ниже: адрес задаётся до монтирования свежего App, а то, что сама
  // ссылка ведёт на этот адрес, проверяет TabBar.test.tsx.
  it("вкладка «Настройки» открывает экран настроек", async () => {
    window.history.pushState({}, "", "/settings");
    vi.resetModules();
    const { App: FreshApp } = await import("@/app/App");
    render(<FreshApp />);
    expect(await screen.findByRole("heading", { name: ru.settings.title })).toBeInTheDocument();
  });

  it("вкладка «Период» открывает итоги текущего периода без кнопки назад", async () => {
    window.history.pushState({}, "", "/period");
    vi.resetModules();
    const { App: FreshApp } = await import("@/app/App");
    render(<FreshApp />);
    await screen.findByText(ru.period.baseRate);
    expect(screen.queryByRole("button", { name: ru.period.back })).not.toBeInTheDocument();
  });

  it("вкладка «Ещё» открывает экран данных и версии", async () => {
    window.history.pushState({}, "", "/more");
    vi.resetModules();
    const { App: FreshApp } = await import("@/app/App");
    render(<FreshApp />);
    expect(await screen.findByText(ru.more.pastPeriods)).toBeInTheDocument();
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
