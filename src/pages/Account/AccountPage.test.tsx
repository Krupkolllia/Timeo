import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { db } from "@/db/db";
import { AccountPage } from "@/pages/Account/AccountPage";
import { useSyncStore } from "@/store/syncStore";
import { useUserStore } from "@/store/userStore";
import { FakeCloud } from "@/test/fakeCloud";
import { makeDayType, makeEntry, makePeriod, makeSettings, resetDb } from "@/test/factories";
import { ru } from "@/i18n/ru";
import type { AuthResult } from "@/lib/sync/auth";

const LOCAL_ID = "local-anon-uuid";
const ACCOUNT = { userId: "11111111-2222-3333-4444-555555555555", email: "test@example.com" };

const cloud = new FakeCloud();
const signInMock = vi.fn<(email: string, password: string) => Promise<AuthResult>>();
const signOutMock = vi.fn<() => Promise<void>>();

vi.mock("@/lib/sync/cloud", () => ({
  get cloudGateway() {
    return cloud;
  },
}));

vi.mock("@/lib/sync/auth", () => ({
  signInWithPassword: (email: string, password: string) => signInMock(email, password),
  signUpWithPassword: (email: string, password: string) => signInMock(email, password),
  signOut: () => signOutMock(),
  currentAccount: () => Promise.resolve(null),
  onAuthChange: () => () => {},
  isCloudConfigured: () => true,
}));

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderAccount() {
  return render(
    <MemoryRouter initialEntries={["/more/account"]}>
      <Routes>
        <Route path="/more/account" element={<AccountPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await resetDb();
  localStorage.clear();
  localStorage.setItem("timeo:local-user-id", LOCAL_ID);
  useUserStore.setState({ userId: LOCAL_ID });
  useSyncStore.setState({
    phase: "signed_out",
    account: null,
    lastSyncAt: null,
    lastError: null,
    choice: null,
    differentUser: null,
    busy: false,
  });
  signInMock.mockReset();
  signOutMock.mockReset();
  signOutMock.mockResolvedValue(undefined);
});

describe("AccountPage — вход", () => {
  it("инвариант 54: ошибка входа показывается рядом с полями, экран остаётся рабочим", async () => {
    signInMock.mockResolvedValue({ ok: false, code: "invalid_credentials", message: "Invalid login credentials" });
    renderAccount();

    fireEvent.change(screen.getByLabelText(ru.account.email), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(ru.account.password), { target: { value: "неверный" } });
    fireEvent.click(screen.getByRole("button", { name: ru.account.signIn }));

    expect(await screen.findByText(ru.account.errorInvalidCredentials)).toBeInTheDocument();
    // Поля на месте, ввод не потерян, никакой модалки-ловушки.
    expect(screen.getByLabelText(ru.account.email)).toHaveValue("test@example.com");
    expect(screen.getByRole("button", { name: ru.account.signIn })).toBeEnabled();
  });

  it("инвариант 58: упавший вход не оставляет экран без объяснения", async () => {
    signInMock.mockRejectedValue(new Error("TypeError: Failed to fetch"));
    renderAccount();

    fireEvent.change(screen.getByLabelText(ru.account.email), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(ru.account.password), { target: { value: "пароль" } });
    fireEvent.click(screen.getByRole("button", { name: ru.account.signIn }));

    expect(await screen.findByText(/Failed to fetch/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ru.account.signIn })).toBeEnabled();
  });

  it("пустая почта не уходит в сеть вовсе", () => {
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: ru.account.signIn }));

    expect(screen.getByText(ru.account.errorEmptyEmail)).toBeInTheDocument();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("удачный вход на чистой установке доводит до состояния «синхронизировано»", async () => {
    signInMock.mockResolvedValue({ ok: true, account: ACCOUNT });
    cloud.seed("day_types", [makeDayType({ id: "dt-cloud", user_id: ACCOUNT.userId })]);
    cloud.seed("entries", [
      makeEntry({ id: "e-cloud", user_id: ACCOUNT.userId, day_type_id: "dt-cloud", amount: 517.42 }),
    ]);
    renderAccount();

    fireEvent.change(screen.getByLabelText(ru.account.email), { target: { value: "test@example.com" } });
    fireEvent.change(screen.getByLabelText(ru.account.password), { target: { value: "пароль" } });
    fireEvent.click(screen.getByRole("button", { name: ru.account.signIn }));

    // Сначала ждём экран, и только потом читаем базу.
    await screen.findByRole("button", { name: ru.account.signOut });
    await waitFor(async () => expect(await db.entries.get("e-cloud")).toBeDefined());
    expect(localStorage.getItem("timeo:cloud-user-id")).toBe(ACCOUNT.userId);
  });
});

describe("AccountPage — выход", () => {
  it("инвариант 44: выход не стирает локальную базу", async () => {
    await db.settings.put(makeSettings({ id: "s-1", user_id: ACCOUNT.userId }));
    await db.entries.put(makeEntry({ id: "e-1", user_id: ACCOUNT.userId, amount: 318.47 }));
    localStorage.setItem("timeo:cloud-user-id", ACCOUNT.userId);
    useSyncStore.setState({ phase: "idle", account: ACCOUNT });
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: ru.account.signOut }));

    await screen.findByRole("button", { name: ru.account.signIn });
    expect(signOutMock).toHaveBeenCalled();
    await waitFor(async () => expect((await db.entries.get("e-1"))?.amount).toBe(318.47));
  });
});

describe("AccountPage — первый вход при данных с обеих сторон", () => {
  it("инвариант 47: показывает оба режима и ни один не выбран заранее", () => {
    useSyncStore.setState({
      phase: "choice_required",
      account: ACCOUNT,
      choice: {
        account: ACCOUNT,
        snapshot: {
          schema_version: 1,
          exported_at: "2026-08-30T09:00:00.000Z",
          app_version: "test",
          settings: null,
          periods: [makePeriod({ id: "p-cloud", user_id: ACCOUNT.userId })],
          day_types: [],
          entries: [],
          holidays: [],
        },
        cloud: { periods: 1, day_types: 0, entries: 0, holidays: 0, months_with_money: 0 },
        local: { periods: 2, day_types: 3, entries: 7, holidays: 13, months_with_money: 2 },
      },
    });
    renderAccount();

    expect(screen.getByRole("button", { name: ru.account.choiceMerge })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ru.account.choiceReplace })).toBeInTheDocument();
    // Числа обеих сторон видны: выбор делается по ним, а не вслепую.
    expect(screen.getByText(new RegExp(`${ru.account.choiceLocal} 2 `))).toBeInTheDocument();
  });

  it("«заменить всё» спрашивает подтверждение и до него ничего не делает", async () => {
    await db.entries.put(makeEntry({ id: "e-local", user_id: LOCAL_ID, amount: 318.47 }));
    useSyncStore.setState({
      phase: "choice_required",
      account: ACCOUNT,
      choice: {
        account: ACCOUNT,
        snapshot: {
          schema_version: 1,
          exported_at: "2026-08-30T09:00:00.000Z",
          app_version: "test",
          settings: null,
          periods: [],
          day_types: [],
          entries: [],
          holidays: [],
        },
        cloud: { periods: 0, day_types: 0, entries: 0, holidays: 0, months_with_money: 0 },
        local: { periods: 0, day_types: 0, entries: 1, holidays: 0, months_with_money: 1 },
      },
    });
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: ru.account.choiceReplace }));

    expect(await screen.findByText(ru.account.choiceReplaceConfirmTitle)).toBeInTheDocument();
    expect((await db.entries.get("e-local"))?.amount).toBe(318.47);
  });
});

describe("AccountPage — вход другим пользователем", () => {
  it("инвариант 44: кнопка стирания недоступна, пока предупреждение не прочитано", () => {
    useSyncStore.setState({
      phase: "different_user",
      account: ACCOUNT,
      differentUser: {
        account: ACCOUNT,
        local: { periods: 4, day_types: 5, entries: 61, holidays: 13, months_with_money: 4 },
      },
    });
    renderAccount();

    const erase = screen.getByRole("button", { name: ru.account.differentUserConfirm });
    expect(erase).toBeDisabled();
    // Что именно будет стёрто — числами, а не «все данные».
    expect(screen.getByText(new RegExp(`${ru.account.differentUserWillErase} 4 `))).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(ru.account.differentUserStep1));
    expect(screen.getByRole("button", { name: ru.account.differentUserConfirm })).toBeEnabled();
  });

  it("предлагает сначала сохранить файл — и уводит на экран экспорта", () => {
    useSyncStore.setState({
      phase: "different_user",
      account: ACCOUNT,
      differentUser: {
        account: ACCOUNT,
        local: { periods: 1, day_types: 1, entries: 1, holidays: 1, months_with_money: 1 },
      },
    });
    renderAccount();

    fireEvent.click(screen.getByRole("button", { name: ru.account.differentUserExportFirst }));

    expect(screen.getByTestId("location").textContent).toBe("/settings/export?return=%2Fmore%2Faccount");
  });
});

describe("AccountPage — сборка без облака", () => {
  it("инвариант 39: экран объясняет, что облака нет, и не предлагает войти", () => {
    useSyncStore.setState({ phase: "disabled", account: null });
    renderAccount();

    expect(screen.getByText(ru.account.disabledTitle)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ru.account.signIn })).not.toBeInTheDocument();
  });
});
