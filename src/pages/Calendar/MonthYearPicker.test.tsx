import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MonthYearPicker } from "@/pages/Calendar/MonthYearPicker";
import { ru } from "@/i18n/ru";

function setup(overrides: Partial<Parameters<typeof MonthYearPicker>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(<MonthYearPicker year={2026} month={8} onSelect={onSelect} onClose={onClose} {...overrides} />);
  return { onSelect, onClose };
}

describe("MonthYearPicker", () => {
  it("selects a month of the shown year", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Мар" }));
    expect(onSelect).toHaveBeenCalledWith({ year: 2026, month: 3 });
  });

  it("pages the year without closing or switching the period", () => {
    // Стрелки года не должны сами применять выбор: иначе долистать до 2024
    // невозможно — период сменился бы на первом же нажатии.
    const { onSelect } = setup();
    fireEvent.click(screen.getByRole("button", { name: ru.calendar.prevYear }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("2025")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Янв" }));
    expect(onSelect).toHaveBeenCalledWith({ year: 2025, month: 1 });
  });

  it("pages the year forward", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByRole("button", { name: ru.calendar.nextYear }));
    expect(screen.getByText("2027")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Дек" }));
    expect(onSelect).toHaveBeenCalledWith({ year: 2027, month: 12 });
  });

  it("marks the current month only on its own year", () => {
    setup();
    const august = screen.getByRole("button", { name: "Авг" });
    expect(august.className).toContain("bg-app-accent");

    fireEvent.click(screen.getByRole("button", { name: ru.calendar.nextYear }));
    expect(screen.getByRole("button", { name: "Авг" }).className).not.toContain("bg-app-accent");
  });

  it("closes on the backdrop but not on the card itself", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText("2026").closest("div")!.parentElement!);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector(".fixed.inset-0")!);
    expect(onClose).toHaveBeenCalled();
  });
});
