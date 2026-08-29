import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { PastPeriodsPage } from "@/pages/PastPeriods/PastPeriodsPage";
import { ru } from "@/i18n/ru";
import { makeDayType, makeEntry, makePeriod, makeSettings, resetDb } from "@/test/factories";
import type { Period, Settings } from "@/types/models";

const userId = getLocalUserId();

function makeRow(overrides: Partial<Period> = {}): Period {
  return makePeriod({ user_id: userId, ...overrides });
}

async function seed({ periods = [], settings = {} }: { periods?: Period[]; settings?: Partial<Settings> } = {}) {
  await db.settings.add(makeSettings({ user_id: userId, id: "s-local", ...settings }));
  if (periods.length > 0) await db.periods.bulkAdd(periods);
}

function LocationProbe() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <>
      <span data-testid="location">{`${location.pathname}${location.search}`}</span>
      <span data-testid="nav-type">{type}</span>
    </>
  );
}

function renderPage(initialEntry: string | string[] = "/settings/past-periods", initialIndex?: number) {
  const entries = Array.isArray(initialEntry) ? initialEntry : [initialEntry];
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex ?? entries.length - 1}>
      <LocationProbe />
      <Routes>
        <Route path="/settings/past-periods" element={<PastPeriodsPage />} />
        <Route path="*" element={<span data-testid="elsewhere" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function currentLocation(): string {
  return screen.getByTestId("location").textContent ?? "";
}

async function openForm() {
  fireEvent.click(await screen.findByRole("button", { name: ru.pastPeriods.add }));
  return screen.findByLabelText(ru.pastPeriods.hours);
}

function typeInto(label: string, value: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
}

beforeEach(resetDb);

describe("PastPeriodsPage — ввод исторического месяца (раздел 8.7)", () => {
  it("сохраняет закрытый ручной период со снимком итогов и без записей", async () => {
    await seed();
    renderPage();

    await openForm();
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.month), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.year), { target: { value: "2026" } });
    typeInto(ru.pastPeriods.hours, "100");
    typeInto(ru.pastPeriods.amount, "1500.5");
    fireEvent.click(screen.getByRole("button", { name: ru.pastPeriods.save }));

    await waitFor(async () => {
      const period = await db.periods.where("[user_id+year+month]").equals([userId, 2026, 5]).first();
      expect(period).toMatchObject({ is_manual: true, is_closed: true });
      expect(period?.closed_totals).toEqual({ amount: 1500.5, total_hours: 100, norm_hours_covered: 100 });
    });
    expect(await db.entries.count()).toBe(0);
  });

  it("сохранённый месяц виден в списке со своими часами и суммой", async () => {
    await seed({
      periods: [
        makeRow({
          id: "p-manual",
          year: 2026,
          month: 5,
          is_manual: true,
          is_closed: true,
          closed_totals: { amount: 1500.5, total_hours: 100, norm_hours_covered: 100 },
        }),
      ],
    });

    renderPage();

    expect(await screen.findByText(/Май 2026/)).toBeInTheDocument();
    expect(screen.getByText(/100 ч · 1500\.50 PLN/)).toBeInTheDocument();
  });

  it("обычные периоды в списке не показываются", async () => {
    await seed({ periods: [makeRow({ id: "p-normal", year: 2026, month: 7 })] });

    renderPage();

    expect(await screen.findByText(ru.pastPeriods.empty)).toBeInTheDocument();
  });

  it("ноль часов и отрицательная сумма не блокируют сохранение, а предупреждают (инвариант 54)", async () => {
    await seed();
    renderPage();

    await openForm();
    typeInto(ru.pastPeriods.amount, "-500");
    expect(screen.getByText(ru.pastPeriods.hintNegativeAmount)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ru.pastPeriods.save }));

    await waitFor(async () => {
      const rows = await db.periods.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].closed_totals).toEqual({ amount: -500, total_hours: 0, norm_hours_covered: 0 });
    });
  });

  it("предупреждает про замок дня начала периода до первого закрытого месяца (инвариант 4)", async () => {
    await seed();
    renderPage();

    await openForm();
    expect(screen.getByText(ru.pastPeriods.lockWarning).className).not.toContain("invisible");
  });

  it("если закрытый период уже есть, про замок не предупреждает: он давно защёлкнут", async () => {
    await seed({ periods: [makeRow({ id: "p-closed", year: 2026, month: 7, is_closed: true })] });
    renderPage();

    await openForm();
    expect(screen.getByText(ru.pastPeriods.lockWarning).className).toContain("invisible");
  });

  it("предупреждает, что за месяц уже есть период с записями", async () => {
    await seed({ periods: [makeRow({ id: "p-aug", year: 2026, month: 8 })] });
    renderPage();

    await openForm();
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.month), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.year), { target: { value: "2026" } });

    expect((await screen.findByText(ru.pastPeriods.hintExisting)).className).not.toContain("invisible");
  });

  it("записи месяца остаются в базе после превращения его в ручной", async () => {
    await seed({ periods: [makeRow({ id: "p-aug", year: 2026, month: 8 })] });
    await db.day_types.add(makeDayType({ user_id: userId }));
    await db.entries.add(makeEntry({ id: "e-1", user_id: userId, date: "2026-08-10" }));
    renderPage();

    await openForm();
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.month), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.year), { target: { value: "2026" } });
    typeInto(ru.pastPeriods.hours, "10");
    fireEvent.click(screen.getByRole("button", { name: ru.pastPeriods.save }));

    await waitFor(async () => {
      expect((await db.periods.get("p-aug"))?.is_manual).toBe(true);
    });
    expect(await db.entries.get("e-1")).toBeTruthy();
  });
});

describe("PastPeriodsPage — закрытый месяц (инвариант 2)", () => {
  async function seedClosedAugust() {
    await seed({
      periods: [
        makeRow({
          id: "p-aug",
          year: 2026,
          month: 8,
          is_closed: true,
          closed_totals: { amount: 4128.72, total_hours: 168, norm_hours_covered: 168 },
        }),
      ],
    });
  }

  it("объясняет, почему месяц не переписать, вместо молчаливого отказа", async () => {
    await seedClosedAugust();
    renderPage();

    await openForm();
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.month), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.year), { target: { value: "2026" } });

    expect((await screen.findByText(ru.pastPeriods.hintClosed)).className).not.toContain("invisible");
    // Кнопка не делает вид, что сохраняет: она ведёт туда, где период
    // открывают заново (инвариант 3).
    expect(screen.getByRole("button", { name: ru.pastPeriods.openPeriod })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ru.pastPeriods.save })).not.toBeInTheDocument();
  });

  it("ведёт на экран периода, ничего не записав", async () => {
    await seedClosedAugust();
    renderPage();

    await openForm();
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.month), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.year), { target: { value: "2026" } });
    fireEvent.click(await screen.findByRole("button", { name: ru.pastPeriods.openPeriod }));

    expect(currentLocation()).toBe("/period?year=2026&month=8");
    expect((await db.periods.get("p-aug"))?.closed_totals?.amount).toBe(4128.72);
  });
});

describe("PastPeriodsPage — именование периодов", () => {
  it("форма показывает тот же месяц, что и строка списка, при period_start_day > 1", async () => {
    // Период с идентификатором «май» при старте 15-го числа и именовании по
    // месяцу окончания называется июнем.
    await seed({
      settings: { period_start_day: 15, period_naming: "end_month" },
      periods: [
        makeRow({
          id: "p-manual",
          year: 2026,
          month: 5,
          is_manual: true,
          is_closed: true,
          closed_totals: { amount: 1500, total_hours: 100, norm_hours_covered: 100 },
        }),
      ],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: `${ru.pastPeriods.edit}: Июнь 2026` }));

    expect((await screen.findByLabelText(ru.pastPeriods.month)) as HTMLSelectElement).toHaveValue("6");
  });

  it("выбранный в форме месяц сохраняется под правильным идентификатором", async () => {
    await seed({ settings: { period_start_day: 15, period_naming: "end_month" } });
    renderPage();

    await openForm();
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.month), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.year), { target: { value: "2026" } });
    typeInto(ru.pastPeriods.hours, "100");
    fireEvent.click(screen.getByRole("button", { name: ru.pastPeriods.save }));

    // Идентификатор — май, а на экране всё это время июнь.
    await waitFor(async () => {
      const rows = await db.periods.filter((row) => row.is_manual).toArray();
      expect(rows.map((row) => `${row.year}-${row.month}`)).toEqual(["2026-5"]);
    });
    expect(await screen.findByText(/Июнь 2026/)).toBeInTheDocument();
  });
});

describe("PastPeriodsPage — правка и удаление", () => {
  it("тап по строке открывает форму с её числами и правит тот же период", async () => {
    await seed({
      periods: [
        makeRow({
          id: "p-manual",
          year: 2026,
          month: 5,
          is_manual: true,
          is_closed: true,
          closed_totals: { amount: 1500, total_hours: 100, norm_hours_covered: 100 },
        }),
      ],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: `${ru.pastPeriods.edit}: Май 2026` }));

    expect((await screen.findByLabelText(ru.pastPeriods.hours)) as HTMLInputElement).toHaveValue("100");
    typeInto(ru.pastPeriods.amount, "1450.25");
    fireEvent.click(screen.getByRole("button", { name: ru.pastPeriods.save }));

    await waitFor(async () => {
      expect((await db.periods.get("p-manual"))?.closed_totals?.amount).toBe(1450.25);
    });
    expect(await db.periods.count()).toBe(1);
  });

  it("правка существующего месяца не показывает предупреждение «период уже есть»", async () => {
    await seed({
      periods: [
        makeRow({
          id: "p-manual",
          year: 2026,
          month: 5,
          is_manual: true,
          is_closed: true,
          closed_totals: { amount: 1500, total_hours: 100, norm_hours_covered: 100 },
        }),
      ],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: `${ru.pastPeriods.edit}: Май 2026` }));

    expect(await screen.findByLabelText(ru.pastPeriods.hours)).toBeInTheDocument();
    expect(screen.queryByText(ru.pastPeriods.hintExisting)).not.toBeInTheDocument();
  });

  it("смена месяца в форме переносит строку, а не создаёт вторую", async () => {
    await seed({
      periods: [
        makeRow({
          id: "p-manual",
          year: 2026,
          month: 5,
          is_manual: true,
          is_closed: true,
          closed_totals: { amount: 1500, total_hours: 100, norm_hours_covered: 100 },
        }),
      ],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: `${ru.pastPeriods.edit}: Май 2026` }));
    await screen.findByLabelText(ru.pastPeriods.hours);
    fireEvent.change(screen.getByLabelText(ru.pastPeriods.month), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: ru.pastPeriods.save }));

    expect(await screen.findByText(/Июнь 2026/)).toBeInTheDocument();
    await waitFor(async () => {
      const rows = await db.periods.filter((row) => row.is_manual && row.deleted_at === null).toArray();
      expect(rows.map((row) => row.month)).toEqual([6]);
    });
  });

  it("убранный месяц с записями возвращается в обычное состояние, а не теряет свои числа", async () => {
    await seed({
      periods: [
        makeRow({
          id: "p-aug",
          year: 2026,
          month: 8,
          base_rate: 33.3,
          extra_amount: -120.75,
          is_manual: true,
          is_closed: true,
          closed_totals: { amount: 999, total_hours: 10, norm_hours_covered: 10 },
        }),
      ],
    });
    await db.day_types.add(makeDayType({ user_id: userId }));
    await db.entries.add(makeEntry({ id: "e-1", user_id: userId, date: "2026-08-10" }));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: `${ru.pastPeriods.delete}: Август 2026` }));

    expect(await screen.findByText(ru.pastPeriods.empty)).toBeInTheDocument();
    await waitFor(async () => {
      expect(await db.periods.get("p-aug")).toMatchObject({
        deleted_at: null,
        is_manual: false,
        base_rate: 33.3,
        extra_amount: -120.75,
      });
    });
  });

  it("удаление мягкое, с окном отмены", async () => {
    await seed({
      periods: [
        makeRow({
          id: "p-manual",
          year: 2026,
          month: 5,
          is_manual: true,
          is_closed: true,
          closed_totals: { amount: 1500, total_hours: 100, norm_hours_covered: 100 },
        }),
      ],
    });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: `${ru.pastPeriods.delete}: Май 2026` }));

    expect(await screen.findByText(ru.pastPeriods.deleted)).toBeInTheDocument();
    await waitFor(async () => {
      expect((await db.periods.get("p-manual"))?.deleted_at).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: ru.pastPeriods.undo }));

    await waitFor(async () => {
      expect((await db.periods.get("p-manual"))?.deleted_at).toBeNull();
    });
    expect(await screen.findByText(/Май 2026/)).toBeInTheDocument();
  });
});

describe("PastPeriodsPage — навигация", () => {
  it("«назад» возвращает по адресу из return=", async () => {
    await seed();
    renderPage("/settings/past-periods?return=%2Fperiod%3Fyear%3D2026%26month%3D8");

    fireEvent.click(await screen.findByRole("button", { name: ru.pastPeriods.back }));

    expect(currentLocation()).toBe("/period?year=2026&month=8");
  });

  it("«назад» из формы возвращает в список, а не с экрана", async () => {
    await seed();
    renderPage();

    await openForm();
    fireEvent.click(screen.getByRole("button", { name: ru.pastPeriods.back }));

    expect(await screen.findByRole("button", { name: ru.pastPeriods.add })).toBeInTheDocument();
    expect(currentLocation()).toBe("/settings/past-periods");
  });

  it("«назад» возвращается по истории, а не кладёт новую запись поверх неё", async () => {
    await seed();
    renderPage(["/period?year=2026&month=8", "/settings/past-periods?return=%2Fperiod%3Fyear%3D2026%26month%3D8"]);

    fireEvent.click(await screen.findByRole("button", { name: ru.pastPeriods.back }));

    expect(currentLocation()).toBe("/period?year=2026&month=8");
    expect(screen.getByTestId("nav-type").textContent).toBe("POP");
  });

  it("без return= уходит на календарь", async () => {
    await seed();
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.pastPeriods.back }));

    expect(currentLocation()).toBe("/");
  });
});
