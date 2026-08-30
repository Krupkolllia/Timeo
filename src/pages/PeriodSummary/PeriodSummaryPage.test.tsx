import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { db } from "@/db/db";
import { PeriodSummaryPage } from "@/pages/PeriodSummary/PeriodSummaryPage";
import { ru } from "@/i18n/ru";
import { makeDayType, makeEntry, makePeriod, makeSettings, resetDb, USER_ID } from "@/test/factories";
import type { Period } from "@/types/models";

vi.mock("@/db/localUser", () => ({ getLocalUserId: () => "user-test" }));

const hourly = makeDayType();
const unpaid = makeDayType({
  id: "dt-unpaid",
  name: "Отгул",
  pay_mode: "unpaid",
  counts_as_work: false,
  counts_toward_norm: false,
});

/** Показывает текущий адрес, чтобы переходы можно было проверить. */
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(search = "?year=2026&month=8", initialEntries = [`/period${search}`]) {
  // MemoryRouter, а не createMemoryRouter: data-router в jsdom спотыкается на
  // AbortSignal при программной навигации, а экрану нужны только
  // useNavigate/useLocation/useSearchParams.
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<p>календарь</p>} />
        <Route path="/period" element={<PeriodSummaryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function seed(period: Partial<Period> = {}) {
  await db.settings.add(makeSettings());
  await db.day_types.bulkAdd([hourly, unpaid]);
  await db.periods.add(makePeriod(period));
}

/** Экран открывается через загрузку — ждём, пока появится поле базовой ставки. */
async function ready() {
  return screen.findByLabelText(ru.period.baseRate);
}

beforeEach(async () => {
  await resetDb();
});

describe("PeriodSummaryPage — загрузка и выбор периода", () => {
  it("показывает загрузку, пока настроек нет", () => {
    renderPage();
    expect(screen.getByText(ru.calendar.loading)).toBeInTheDocument();
  });

  it("берёт период из параметров адреса", async () => {
    await seed();
    renderPage("?year=2026&month=8");
    await ready();
    expect(screen.getByText("Август 2026")).toBeInTheDocument();
  });

  it("без параметров берёт период сегодняшнего дня", async () => {
    vi.setSystemTime(new Date(2026, 7, 15));
    await seed();
    renderPage("");
    await ready();
    expect(screen.getByText("Август 2026")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("игнорирует мусор в параметрах", async () => {
    vi.setSystemTime(new Date(2026, 7, 15));
    await seed();
    renderPage("?year=abc&month=99");
    await ready();
    expect(screen.getByText("Август 2026")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("создаёт период, которого ещё нет", async () => {
    await db.settings.add(makeSettings({ default_base_rate: 55, default_norm_hours: 168 }));
    await db.day_types.add(hourly);
    renderPage("?year=2026&month=9");

    await ready();
    await waitFor(async () => {
      const created = await db.periods.where("[user_id+year+month]").equals([USER_ID, 2026, 9]).first();
      expect(created?.base_rate).toBe(55);
    });
  });

  it("возвращает на календарь, когда истории переходов нет", async () => {
    // В standalone-режиме браузерной кнопки «назад» нет, а history может быть
    // пустой (прямой заход, восстановление PWA): navigate(-1) тогда никуда не
    // ведёт и экран замирает.
    await seed();
    renderPage();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: ru.period.back }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/"));
    expect(screen.getByText("календарь")).toBeInTheDocument();
  });

  it("возвращает шагом назад, когда история есть", async () => {
    await seed();
    renderPage("?year=2026&month=8", ["/", "/period?year=2026&month=8"]);
    await ready();

    fireEvent.click(screen.getByRole("button", { name: ru.period.back }));
    await waitFor(() => expect(screen.getByText("календарь")).toBeInTheDocument());
  });
});

describe("PeriodSummaryPage — итоги", () => {
  it("суммирует записи периода и считает часы только по рабочим типам", async () => {
    await seed();
    await db.entries.bulkAdd([
      makeEntry({ id: "e-1", date: "2026-08-03", hours: 8, amount: 240 }),
      makeEntry({ id: "e-2", date: "2026-08-04", hours: 6, amount: 180 }),
      makeEntry({ id: "e-3", date: "2026-08-05", day_type_id: "dt-unpaid", hours: 8, amount: 0 }),
    ]);
    renderPage();
    await ready();

    expect(await screen.findByText("420.00 PLN")).toBeInTheDocument();
    expect(screen.getByText("14 ч")).toBeInTheDocument();
    expect(screen.getByText("146 ч")).toBeInTheDocument();
  });

  it("не берёт записи соседних периодов (инвариант 1)", async () => {
    await seed();
    await db.entries.bulkAdd([
      makeEntry({ id: "in", date: "2026-08-01", amount: 240 }),
      makeEntry({ id: "before", date: "2026-07-31", amount: 999 }),
      makeEntry({ id: "after", date: "2026-09-01", amount: 999 }),
    ]);
    renderPage();
    await ready();

    expect(await screen.findByText("240.00 PLN")).toBeInTheDocument();
  });

  it("не считает мягко удалённые записи (инвариант 38)", async () => {
    await seed();
    await db.entries.bulkAdd([
      makeEntry({ id: "live", date: "2026-08-01", amount: 240 }),
      makeEntry({ id: "gone", date: "2026-08-02", amount: 500, deleted_at: "2026-08-02T00:00:00.000Z" }),
    ]);
    renderPage();
    await ready();

    expect(await screen.findByText("240.00 PLN")).toBeInTheDocument();
  });

  it("сообщает, что записей нет", async () => {
    await seed();
    renderPage();
    await ready();
    expect(await screen.findByText(ru.period.noEntries)).toBeInTheDocument();
  });

  it("печатает расшифровку строкой на запись", async () => {
    await seed();
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-03", multiplier: 1.5, amount: 360 }));
    renderPage();
    await ready();

    const list = await screen.findByRole("list");
    expect(within(list).getByText(/3 авг, Пн · Рабочий день/)).toBeInTheDocument();
    expect(within(list).getByText("8ч × 30.00 · ×1.5")).toBeInTheDocument();
    expect(within(list).getByText("360.00")).toBeInTheDocument();
  });

  it("держит устойчивый порядок строк внутри одного дня", async () => {
    // Порядок по индексу date внутри одного дня не гарантирован, а строки
    // расшифровки не должны переставляться между перечитываниями.
    await seed();
    await db.entries.bulkAdd([
      makeEntry({ id: "second", date: "2026-08-03", created_at: "2026-08-03T20:00:00.000Z", amount: 120 }),
      makeEntry({ id: "first", date: "2026-08-03", created_at: "2026-08-03T08:00:00.000Z", amount: 240 }),
    ]);
    renderPage();
    await ready();

    const list = await screen.findByRole("list");
    const amounts = within(list)
      .getAllByText(/^\d+\.\d\d$/)
      .map((node) => node.textContent);
    expect(amounts).toEqual(["240.00", "120.00"]);
  });

  it("строку с исчезнувшим типом дня рисует прочерком, а не падением", async () => {
    await seed();
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-03", day_type_id: "dt-gone" }));
    renderPage();
    await ready();
    expect(await screen.findByText(/3 авг, Пн · —/)).toBeInTheDocument();
  });
});

describe("PeriodSummaryPage — норма, прочие начисления и комментарий", () => {
  it("сохраняет норму часов", async () => {
    await seed();
    renderPage();
    await ready();

    fireEvent.change(screen.getByLabelText(ru.period.normHours), { target: { value: "168" } });
    await waitFor(async () => expect((await db.periods.get("p-2026-08"))?.norm_hours).toBe(168));
  });

  it("сохраняет прочие начисления и предупреждает об отрицательной сумме", async () => {
    await seed();
    renderPage();
    await ready();

    fireEvent.change(screen.getByLabelText(ru.period.extraAmount), { target: { value: "-200" } });
    await waitFor(async () => expect((await db.periods.get("p-2026-08"))?.extra_amount).toBe(-200));
    await waitFor(() => expect(screen.getByText(ru.period.hintNegativeExtra).className).not.toContain("invisible"));
  });

  it("прочие начисления входят в итог", async () => {
    await seed({ extra_amount: 100 });
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-03", amount: 240 }));
    renderPage();
    await ready();
    expect(await screen.findByText("340.00 PLN")).toBeInTheDocument();
  });

  it("комментарий держится черновиком и не теряет набранное", async () => {
    await seed();
    renderPage();
    await ready();

    const note = screen.getByLabelText(ru.period.extraNote);
    fireEvent.change(note, { target: { value: "премия" } });
    expect(note).toHaveValue("премия");
    await waitFor(async () => expect((await db.periods.get("p-2026-08"))?.extra_note).toBe("премия"));
    expect(note).toHaveValue("премия");
  });
});

describe("PeriodSummaryPage — смена базовой ставки (раздел 6.6)", () => {
  async function openDialog(newRate = "40") {
    fireEvent.change(await screen.findByLabelText(ru.period.baseRate), { target: { value: newRate } });
    fireEvent.click(await screen.findByRole("button", { name: ru.period.baseRateSave }));
    return screen.findByText(ru.period.rateDialogTitle);
  }

  it("кнопка сохранения появляется только когда ставка изменилась", async () => {
    await seed();
    renderPage();
    await ready();
    expect(screen.queryByRole("button", { name: ru.period.baseRateSave })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(ru.period.baseRate), { target: { value: "40" } });
    expect(screen.getByRole("button", { name: ru.period.baseRateSave })).toBeInTheDocument();
  });

  it("пересчёт всего периода обновляет записи и сообщает сколько", async () => {
    await seed();
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-03", amount: 240 }));
    renderPage();
    await openDialog("40");

    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));

    await waitFor(async () => expect((await db.entries.get("e-1"))?.amount).toBe(320));
    expect((await db.periods.get("p-2026-08"))?.base_rate).toBe(40);
    expect(await screen.findByText(`${ru.period.recalculatedNotice}: 1`)).toBeInTheDocument();
  });

  it("вторая подряд смена ставки перезапускает свою же плашку", async () => {
    await seed();
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-03", amount: 240 }));
    renderPage();
    await openDialog("40");
    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));
    await screen.findByText(`${ru.period.recalculatedNotice}: 1`);

    await openDialog("50");
    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));

    await waitFor(async () => expect((await db.entries.get("e-1"))?.amount).toBe(400));
    expect(await screen.findByText(`${ru.period.recalculatedNotice}: 1`)).toBeInTheDocument();
  });

  it("набранная ставка не стирается эхом обновлённой строки периода", async () => {
    await seed();
    renderPage();
    const rate = (await ready()) as HTMLInputElement;

    fireEvent.change(rate, { target: { value: "50" } });
    // Строка периода обновилась сама (наш же пересчёт, правка с другого
    // устройства): раньше на это был подвешен сброс черновика, и набранное
    // число молча исчезало вместе с кнопкой сохранения.
    await db.periods.update("p-2026-08", { base_rate: 45 });

    await waitFor(async () => expect((await db.periods.get("p-2026-08"))?.base_rate).toBe(45));
    expect(await screen.findByLabelText(ru.period.baseRate)).toHaveValue("50");
    expect(screen.getByRole("button", { name: ru.period.baseRateSave })).toBeInTheDocument();
  });

  it("«с даты» замораживает ставку более ранних записей", async () => {
    await seed();
    await db.entries.bulkAdd([
      makeEntry({ id: "early", date: "2026-08-03", amount: 240 }),
      makeEntry({ id: "late", date: "2026-08-20", amount: 240 }),
    ]);
    renderPage();
    await openDialog("40");

    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.period.modeFromDate) }));
    fireEvent.change(screen.getByLabelText(ru.period.fromDate), { target: { value: "2026-08-10" } });
    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));

    await waitFor(async () => expect((await db.entries.get("late"))?.amount).toBe(320));
    const early = await db.entries.get("early");
    expect(early?.amount).toBe(240);
    expect(early?.rate_is_manual).toBe(true);
    expect(early?.rate_source).toBe("frozen");
  });

  it("«со следующего периода» не трогает текущий и возвращает поле к его ставке", async () => {
    await seed();
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-03", amount: 240 }));
    renderPage();
    await openDialog("60");

    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.period.modeNextPeriod) }));
    fireEvent.click(screen.getByRole("button", { name: ru.period.apply }));

    await waitFor(async () => {
      const settings = await db.settings.where("user_id").equals(USER_ID).first();
      expect(settings?.default_base_rate).toBe(60);
      expect(settings?.default_base_rate_from_period).toEqual({ year: 2026, month: 9 });
    });
    expect((await db.entries.get("e-1"))?.amount).toBe(240);
    expect((await db.periods.get("p-2026-08"))?.base_rate).toBe(30);
    await waitFor(() => expect(screen.getByLabelText(ru.period.baseRate)).toHaveValue("30"));
  });

  it("диалог закрывается по отмене, ничего не меняя", async () => {
    await seed();
    renderPage();
    await openDialog("40");

    fireEvent.click(screen.getByRole("button", { name: ru.period.cancel }));
    await waitFor(() => expect(screen.queryByText(ru.period.rateDialogTitle)).not.toBeInTheDocument());
    expect((await db.periods.get("p-2026-08"))?.base_rate).toBe(30);
  });

  it("нулевая ставка объясняется подсказкой, а не запретом", async () => {
    await seed({ base_rate: 0 });
    renderPage();
    await ready();
    expect(screen.getByText(ru.period.hintZeroBaseRate).className).not.toContain("invisible");
  });
});

describe("PeriodSummaryPage — закрытие и переоткрытие (инварианты 2 и 3)", () => {
  it("закрытие фиксирует снимок и запирает поля", async () => {
    await seed();
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-03", amount: 240 }));
    renderPage();
    await ready();
    await screen.findByText("240.00 PLN");

    fireEvent.click(screen.getByRole("button", { name: ru.period.closePeriod }));

    await waitFor(async () => expect((await db.periods.get("p-2026-08"))?.is_closed).toBe(true));
    expect((await db.periods.get("p-2026-08"))?.closed_totals).toEqual({
      amount: 240,
      total_hours: 8,
      norm_hours_covered: 8,
    });
    expect(await screen.findByText(ru.period.closedBanner)).toBeInTheDocument();
    expect(screen.getByLabelText(ru.period.baseRate)).toBeDisabled();
    expect(screen.getByLabelText(ru.period.normHours)).toBeDisabled();
    expect(screen.getByLabelText(ru.period.extraAmount)).toBeDisabled();
    expect(screen.getByLabelText(ru.period.extraNote)).toBeDisabled();
  });

  it("закрытый период отдаёт снимок, а не сумму по записям", async () => {
    await seed({ is_closed: true, closed_totals: { amount: 1000, total_hours: 40, norm_hours_covered: 40 } });
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-03", amount: 240 }));
    renderPage();
    await ready();

    expect(await screen.findByText("1000.00 PLN")).toBeInTheDocument();
    expect(screen.getByText("40 ч")).toBeInTheDocument();
  });

  it("переоткрытие требует подтверждения и сохраняет снимок", async () => {
    await seed({ is_closed: true, closed_totals: { amount: 1000, total_hours: 40, norm_hours_covered: 40 } });
    renderPage();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: ru.period.reopen }));
    expect(screen.getByText(ru.period.reopenConfirmTitle)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.period.reopenConfirmAction }));

    await waitFor(async () => expect((await db.periods.get("p-2026-08"))?.is_closed).toBe(false));
    expect((await db.periods.get("p-2026-08"))?.closed_totals?.amount).toBe(1000);
    expect(await screen.findByText(new RegExp(ru.period.snapshot))).toBeInTheDocument();
  });

  it("подтверждение переоткрытия можно отменить", async () => {
    await seed({ is_closed: true, closed_totals: { amount: 1000, total_hours: 40, norm_hours_covered: 40 } });
    renderPage();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: ru.period.reopen }));
    fireEvent.click(screen.getByRole("button", { name: ru.period.cancel }));
    await waitFor(() => expect(screen.queryByText(ru.period.reopenConfirmTitle)).not.toBeInTheDocument());
    expect((await db.periods.get("p-2026-08"))?.is_closed).toBe(true);
  });

  it("подтверждение закрывается по фону", async () => {
    await seed({ is_closed: true, closed_totals: { amount: 1, total_hours: 0, norm_hours_covered: 0 } });
    renderPage();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: ru.period.reopen }));
    fireEvent.click(document.querySelector(".day-sheet-overlay")!);
    await waitFor(() => expect(screen.queryByText(ru.period.reopenConfirmTitle)).not.toBeInTheDocument());
  });

  it("тап по самому окну подтверждения его не закрывает", async () => {
    await seed({ is_closed: true, closed_totals: { amount: 1, total_hours: 0, norm_hours_covered: 0 } });
    renderPage();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: ru.period.reopen }));
    fireEvent.click(screen.getByText(ru.period.reopenConfirmTitle));
    expect(screen.getByText(ru.period.reopenConfirmTitle)).toBeInTheDocument();
  });
});

describe("PeriodSummaryPage — ручной период (блок 6)", () => {
  it("ручной период показывает вписанные итоги, а не сумму записей (инвариант 5)", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.bulkAdd([hourly, unpaid]);
    await db.periods.add(
      makePeriod({
        is_manual: true,
        is_closed: true,
        closed_totals: { amount: 1500.5, total_hours: 100, norm_hours_covered: 100 },
      }),
    );
    // Запись внутри диапазона месяца: у ручного периода её быть не должно, но
    // если она там оказалась, суммироваться она не имеет права.
    await db.entries.add(makeEntry({ id: "e-stray", date: "2026-08-11", amount: 240 }));

    renderPage();
    await ready();

    expect(await screen.findByText("1500.50 PLN")).toBeInTheDocument();
    expect(screen.queryByText("1740.50 PLN")).not.toBeInTheDocument();
  });

  it("у ручного периода нет предупреждения про нулевую ставку: часы по ней не считаются", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.bulkAdd([hourly, unpaid]);
    await db.periods.add(
      makePeriod({
        base_rate: 0,
        is_manual: true,
        is_closed: true,
        closed_totals: { amount: 1500.5, total_hours: 100, norm_hours_covered: 100 },
      }),
    );

    renderPage();
    await ready();

    expect(screen.getByText(ru.period.hintZeroBaseRate).className).toContain("invisible");
  });

  it("мягко удалённый период не показывается как существующий (инвариант 38)", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.bulkAdd([hourly, unpaid]);
    await db.periods.add(makePeriod({ deleted_at: "2026-08-20T00:00:00.000Z", base_rate: 99 }));

    renderPage("?year=2026&month=8");

    // Экран заводит период заново по правилам раздела 5.2 — со ставкой из
    // настроек, а не со ставкой удалённой строки.
    const rate = (await ready()) as HTMLInputElement;
    await waitFor(() => expect(rate).not.toHaveValue("99"));
  });
});
