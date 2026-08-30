import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { MorePage } from "@/pages/More/MorePage";
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
});
