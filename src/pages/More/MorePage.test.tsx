import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { MorePage } from "@/pages/More/MorePage";
import { useSyncStore } from "@/store/syncStore";
import { ru } from "@/i18n/ru";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderMore() {
  return render(
    <MemoryRouter initialEntries={["/more"]}>
      <Routes>
        <Route path="/more" element={<MorePage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MorePage", () => {
  it("показывает версию на экране", () => {
    renderMore();
    expect(screen.getByText(new RegExp(`${ru.more.version} \\d+\\.\\d+\\.\\d+`))).toBeInTheDocument();
  });

  it("ссылка «Прошлые периоды» уходит с return=/more", () => {
    renderMore();
    fireEvent.click(screen.getByRole("button", { name: ru.more.pastPeriods }));
    expect(screen.getByTestId("location").textContent).toBe("/settings/past-periods?return=%2Fmore");
  });

  it("ссылка «Экспорт и восстановление» уходит с return=/more", () => {
    renderMore();
    fireEvent.click(screen.getByRole("button", { name: ru.more.exportRestore }));
    expect(screen.getByTestId("location").textContent).toBe("/settings/export?return=%2Fmore");
  });

  it("раздел 8.4.1: на месте, зарезервированном под аккаунт, теперь вход в аккаунт", () => {
    useSyncStore.setState({ phase: "signed_out", account: null });
    renderMore();

    fireEvent.click(screen.getByRole("button", { name: ru.more.account }));

    expect(screen.getByTestId("location").textContent).toBe("/more/account?return=%2Fmore");
  });

  it("состояние аккаунта видно словами прямо на вкладке", () => {
    useSyncStore.setState({ phase: "idle", account: { userId: "u-1", email: "test@example.com" } });
    renderMore();

    expect(screen.getByText("test@example.com")).toBeInTheDocument();
  });
});
