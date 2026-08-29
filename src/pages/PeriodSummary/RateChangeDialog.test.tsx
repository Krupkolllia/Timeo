import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RateChangeDialog } from "@/pages/PeriodSummary/RateChangeDialog";
import { ru } from "@/i18n/ru";

type Props = Parameters<typeof RateChangeDialog>[0];

function setup(overrides: Partial<Props> = {}) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(
    <RateChangeDialog
      currentRate={30}
      newRate={40}
      currency="PLN"
      preferredMode={null}
      periodStartISO="2026-08-01"
      periodEndISO="2026-08-31"
      todayISO="2026-08-15"
      nextPeriodLabel="Сентябрь 2026"
      nextPeriodExists={false}
      onApply={onApply}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onApply, onCancel };
}

describe("RateChangeDialog", () => {
  it("shows both numbers so the change can be judged by its difference", () => {
    setup();
    expect(screen.getByText("30.00 → 40.00 PLN")).toBeInTheDocument();
  });

  it("defaults to recalculating the period", () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));
    expect(onApply).toHaveBeenCalledWith("recalculate_period", null);
  });

  it("preselects the remembered mode but still shows the dialog (section 6.6)", () => {
    const { onApply } = setup({ preferredMode: "apply_next_period" });
    expect(screen.getByRole("button", { name: new RegExp(ru.period.modeNextPeriod) })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));
    expect(onApply).toHaveBeenCalledWith("apply_next_period", null);
  });

  it("offers today as the from-date when today falls inside the period", () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.period.modeFromDate) }));
    expect(screen.getByLabelText(ru.period.fromDate)).toHaveValue("2026-08-15");

    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));
    expect(onApply).toHaveBeenCalledWith("apply_from_date", "2026-08-15");
  });

  it("falls back to the period start when today is outside the period", () => {
    // Экран периода открывается и на прошлом месяце: «сегодня» там не лежит,
    // и подставлять его значило бы предложить дату вне периода.
    setup({ todayISO: "2026-09-20" });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.period.modeFromDate) }));
    expect(screen.getByLabelText(ru.period.fromDate)).toHaveValue("2026-08-01");
  });

  it("accepts a typed from-date and falls back to the period start when cleared", () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.period.modeFromDate) }));
    const input = screen.getByLabelText(ru.period.fromDate);

    fireEvent.change(input, { target: { value: "2026-08-20" } });
    expect(input).toHaveValue("2026-08-20");

    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("2026-08-01");

    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));
    expect(onApply).toHaveBeenCalledWith("apply_from_date", "2026-08-01");
  });

  it("hides the date field for the other modes", () => {
    setup();
    expect(screen.queryByLabelText(ru.period.fromDate)).not.toBeInTheDocument();
  });

  it("warns, without blocking, that an existing next period will not be rewritten", () => {
    // Раздел 9: прозрачность вместо запрета — режим остаётся выбираемым.
    const { onApply } = setup({ nextPeriodExists: true });
    expect(screen.getByText(ru.period.modeNextPeriodHintExists)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.period.modeNextPeriod) }));
    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));
    expect(onApply).toHaveBeenCalledWith("apply_next_period", null);
  });

  it("names the next period in the hint", () => {
    setup();
    expect(screen.getByText(`${ru.period.modeNextPeriodHint} Сентябрь 2026`)).toBeInTheDocument();
    expect(screen.queryByText(ru.period.modeNextPeriodHintExists)).not.toBeInTheDocument();
  });

  it("cancels from the button and from the backdrop", () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole("button", { name: ru.period.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(document.querySelector(".day-sheet-overlay")!);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("does not cancel when the sheet itself is tapped", () => {
    const { onCancel } = setup();
    fireEvent.click(document.querySelector(".day-sheet")!);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
