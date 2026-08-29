import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { db } from "@/db/db";
import { CalendarPage } from "@/pages/Calendar/CalendarPage";
import { PRESET_DAY_TYPES } from "@/db/dayTypes";
import { ru } from "@/i18n/ru";
import { makeDayType, makeEntry, makePeriod, makeSettings, resetDb, USER_ID } from "@/test/factories";

vi.mock("@/db/localUser", () => ({ getLocalUserId: () => "user-test" }));

const hourly = makeDayType();

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderCalendar(initialEntry = "/") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<CalendarPage />} />
        <Route path="/period" element={<p>итоги периода</p>} />
        <Route path="/settings/day-types" element={<p>типы дней</p>} />
        <Route path="/settings/holidays" element={<p>праздники</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

import { formatDayTitle } from "@/lib/format/date";

/** Ячейка дня — по читаемой дате: в сетке два «31», из разных месяцев. */
function dayCell(iso: string): HTMLElement {
  return screen.getByRole("button", { name: formatDayTitle(iso), hidden: true });
}

async function ready() {
  await waitFor(() => expect(screen.queryByText(ru.calendar.loading)).not.toBeInTheDocument());
}

beforeEach(async () => {
  await resetDb();
  // shouldAdvanceTime: реальное время продолжает идти, поэтому waitFor не
  // повисает, а окно отмены всё равно можно промотать вручную.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 10));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CalendarPage — первый запуск", () => {
  it("создаёт настройки, типы дня и период текущего месяца", async () => {
    renderCalendar();
    await ready();

    expect(screen.getByText("Август 2026")).toBeInTheDocument();
    await waitFor(async () => {
      expect(await db.settings.where("user_id").equals(USER_ID).count()).toBe(1);
      expect(await db.day_types.where("user_id").equals(USER_ID).count()).toBe(PRESET_DAY_TYPES.length);
      expect(await db.periods.where("[user_id+year+month]").equals([USER_ID, 2026, 8]).first()).toBeDefined();
    });
  });

  it("показывает загрузку, пока настройки не прочитаны", () => {
    renderCalendar();
    expect(screen.getByText(ru.calendar.loading)).toBeInTheDocument();
  });
});

describe("CalendarPage — сетка", () => {
  beforeEach(async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
  });

  it("рисует полные недели и гасит дни соседних периодов", async () => {
    renderCalendar();
    await ready();

    // 1 августа 2026 — суббота, поэтому неделя начинается с 27 июля.
    expect(dayCell("2026-07-27")).toBeDisabled();
    expect(dayCell("2026-08-01")).toBeEnabled();
    expect(dayCell("2026-08-31")).toBeEnabled();
  });

  it("показывает часы и цветную точку на дне с записью", async () => {
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-10", hours: 8 }));
    renderCalendar();
    await ready();

    await waitFor(() => expect(within(dayCell("2026-08-10")).getByText(/8/)).toBeInTheDocument());
    expect(dayCell("2026-08-10").querySelector("span[style]")).toBeTruthy();
  });

  it("складывает часы нескольких записей одного дня", async () => {
    await db.entries.bulkAdd([
      makeEntry({ id: "e-1", date: "2026-08-10", hours: 8 }),
      makeEntry({ id: "e-2", date: "2026-08-10", hours: 4 }),
    ]);
    renderCalendar();
    await ready();

    await waitFor(() => expect(within(dayCell("2026-08-10")).getByText(/12/)).toBeInTheDocument());
  });

  it("не рисует больше трёх точек в ячейке", async () => {
    await db.entries.bulkAdd(
      [1, 2, 3, 4, 5].map((n) => makeEntry({ id: `e-${n}`, date: "2026-08-10", hours: 1 })),
    );
    renderCalendar();
    await ready();

    await waitFor(() => expect(dayCell("2026-08-10").querySelectorAll("span[style]")).toHaveLength(3));
  });

  it("показывает версию сборки", async () => {
    renderCalendar();
    await ready();
    expect(screen.getByText(/^v\d+\.\d+\.\d+/)).toBeInTheDocument();
  });
});

describe("CalendarPage — навигация по периодам", () => {
  beforeEach(async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
  });

  it("листает назад и вперёд", async () => {
    renderCalendar();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: ru.calendar.prevPeriod }));
    expect(await screen.findByText("Июль 2026")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.calendar.nextPeriod }));
    expect(await screen.findByText("Август 2026")).toBeInTheDocument();
  });

  it("перелистывание через год не ломает подпись", async () => {
    renderCalendar();
    await ready();
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: ru.calendar.prevPeriod }));
    expect(await screen.findByText("Март 2026")).toBeInTheDocument();
  });

  it("выбирает месяц и год через пикер", async () => {
    renderCalendar();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: "Август 2026" }));
    fireEvent.click(screen.getByRole("button", { name: ru.calendar.prevYear }));
    fireEvent.click(screen.getByRole("button", { name: "Мар" }));

    expect(await screen.findByText("Март 2025")).toBeInTheDocument();
  });

  it("пикер закрывается без выбора", async () => {
    renderCalendar();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: "Август 2026" }));
    expect(screen.getByRole("button", { name: "Янв" })).toBeInTheDocument();
    fireEvent.click(document.querySelector(".fixed.inset-0")!);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Янв" })).not.toBeInTheDocument());
  });

  it("прыжок через пикер не создаёт промежуточные периоды (инвариант 7)", async () => {
    // Октябрь копирует ставку у последнего СУЩЕСТВУЮЩЕГО раннего периода —
    // августа, а не у несуществующего сентября с нулевой ставкой.
    renderCalendar();
    await ready();

    fireEvent.click(screen.getByRole("button", { name: "Август 2026" }));
    fireEvent.click(screen.getByRole("button", { name: "Дек" }));
    expect(await screen.findByText("Декабрь 2026")).toBeInTheDocument();

    await waitFor(async () => {
      const december = await db.periods.where("[user_id+year+month]").equals([USER_ID, 2026, 12]).first();
      expect(december?.base_rate).toBe(30);
    });
    expect(await db.periods.where("[user_id+year+month]").equals([USER_ID, 2026, 9]).first()).toBeUndefined();
    expect(await db.periods.where("[user_id+year+month]").equals([USER_ID, 2026, 11]).first()).toBeUndefined();
  });
});

describe("CalendarPage — панель итогов", () => {
  beforeEach(async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
  });

  it("показывает сумму, часы и остаток до нормы", async () => {
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-10", hours: 8, amount: 240 }));
    renderCalendar();
    await ready();

    expect(await screen.findByText("240.00 PLN")).toBeInTheDocument();
    expect(screen.getByText("8 ч")).toBeInTheDocument();
    expect(screen.getByText(`${ru.calendar.remainingToNorm}: 152 ч`)).toBeInTheDocument();
  });

  it("не показывает сравнение, пока предыдущего периода нет", async () => {
    renderCalendar();
    await ready();
    await waitFor(() => expect(screen.getByText("0.00 PLN")).toBeInTheDocument());
    expect(screen.queryByText(/^[+−]/)).not.toBeInTheDocument();
  });

  it("сравнивает с предыдущим периодом, когда он есть", async () => {
    await db.periods.add(makePeriod({ id: "p-2026-07", year: 2026, month: 7 }));
    await db.entries.bulkAdd([
      makeEntry({ id: "now", date: "2026-08-10", amount: 500 }),
      makeEntry({ id: "before", date: "2026-07-10", amount: 200 }),
    ]);
    renderCalendar();
    await ready();

    expect(await screen.findByText("+300.00 PLN")).toBeInTheDocument();
  });

  it("показывает отрицательную разницу со знаком минус", async () => {
    await db.periods.add(makePeriod({ id: "p-2026-07", year: 2026, month: 7 }));
    await db.entries.bulkAdd([
      makeEntry({ id: "now", date: "2026-08-10", amount: 100 }),
      makeEntry({ id: "before", date: "2026-07-10", amount: 400 }),
    ]);
    renderCalendar();
    await ready();

    expect(await screen.findByText("−300.00 PLN")).toBeInTheDocument();
  });

  it("ведёт на расшифровку периода, который сейчас на экране", async () => {
    renderCalendar();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: ru.calendar.prevPeriod }));
    await screen.findByText("Июль 2026");

    fireEvent.click(screen.getByRole("button", { name: ru.period.openSummary }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/period?year=2026&month=7"));
  });
});

describe("CalendarPage — шторка дня", () => {
  beforeEach(async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
  });

  it("открывается по тапу и закрывается по фону", async () => {
    renderCalendar();
    await ready();

    fireEvent.click(dayCell("2026-08-10"));
    expect(await screen.findByText("10 августа, Пн")).toBeInTheDocument();

    fireEvent.click(document.querySelector(".day-sheet-overlay")!);
    await waitFor(() => expect(screen.queryByText("10 августа, Пн")).not.toBeInTheDocument());
  });

  it("тап по самой шторке её не закрывает", async () => {
    renderCalendar();
    await ready();

    fireEvent.click(dayCell("2026-08-10"));
    await screen.findByText("10 августа, Пн");
    fireEvent.click(document.querySelector(".day-sheet")!);
    expect(screen.getByText("10 августа, Пн")).toBeInTheDocument();
  });

  it("уводит на экран периода из шторки", async () => {
    await db.periods.update("p-2026-08", { base_rate: 0 });
    renderCalendar();
    await ready();

    fireEvent.click(dayCell("2026-08-10"));
    fireEvent.click(await screen.findByRole("button", { name: "Рабочий день" }));
    fireEvent.click(await screen.findByText(ru.day.hintNoBaseRate));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/period?year=2026&month=8"));
  });
});

describe("CalendarPage — отмена удаления (раздел 9)", () => {
  beforeEach(async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
    await db.entries.add(makeEntry({ id: "e-1", date: "2026-08-10", amount: 240 }));
  });

  it("плашка переживает закрытие шторки и возвращает запись", async () => {
    // Удаление закрывает экран дня сразу, поэтому окно отмены живёт на уровне
    // календаря, а не внутри шторки.
    renderCalendar();
    await ready();

    fireEvent.click(dayCell("2026-08-10"));
    fireEvent.click(await screen.findByRole("button", { name: ru.day.deleteEntry }));

    expect(await screen.findByText(ru.day.deletedNotice)).toBeInTheDocument();
    expect(screen.queryByText("10 августа, Пн")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("0.00 PLN")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: ru.day.undo }));

    await waitFor(async () => expect((await db.entries.get("e-1"))?.deleted_at).toBeNull());
    expect(await screen.findByText("240.00 PLN")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(ru.day.deletedNotice)).not.toBeInTheDocument());
  });

  it("второе удаление подряд перезапускает окно отмены", async () => {
    await db.entries.add(makeEntry({ id: "e-2", date: "2026-08-11", amount: 120 }));
    renderCalendar();
    await ready();

    fireEvent.click(dayCell("2026-08-10"));
    fireEvent.click(await screen.findByRole("button", { name: ru.day.deleteEntry }));
    await screen.findByText(ru.day.deletedNotice);

    await vi.advanceTimersByTimeAsync(3000);
    fireEvent.click(dayCell("2026-08-11"));
    fireEvent.click(await screen.findByRole("button", { name: ru.day.deleteEntry }));
    await screen.findByText(ru.day.deletedNotice);

    // Таймер первой плашки сброшен: через 3 секунды после второго удаления
    // окно отмены обязано быть ещё открыто.
    await vi.advanceTimersByTimeAsync(3000);
    expect(screen.getByText(ru.day.deletedNotice)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.day.undo }));
    await waitFor(async () => expect((await db.entries.get("e-2"))?.deleted_at).toBeNull());
    expect((await db.entries.get("e-1"))?.deleted_at).not.toBeNull();
  });

  it("плашка пропадает сама через несколько секунд", async () => {
    renderCalendar();
    await ready();

    fireEvent.click(dayCell("2026-08-10"));
    fireEvent.click(await screen.findByRole("button", { name: ru.day.deleteEntry }));
    await screen.findByText(ru.day.deletedNotice);

    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => expect(screen.queryByText(ru.day.deletedNotice)).not.toBeInTheDocument());
    expect((await db.entries.get("e-1"))?.deleted_at).not.toBeNull();
  });
});

describe("CalendarPage — вход в создание типа дня (раздел 8.2)", () => {
  it("плюс в ряду типов уводит в создание и запоминает день, куда вернуться", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
    renderCalendar();
    await ready();

    fireEvent.click(dayCell("2026-08-10"));
    fireEvent.click(await screen.findByRole("button", { name: ru.day.createDayType }));

    // return= несёт сам день: без него возврат высаживал бы пользователя на
    // пустой календарь вместо дня, ради которого он уходил за типом.
    expect(screen.getByTestId("location").textContent).toBe(
      `/settings/day-types?new=1&return=${encodeURIComponent("/?day=2026-08-10")}`,
    );
  });

  it("открывает шторку сразу, когда адрес несёт ?day=", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());

    renderCalendar("/?day=2026-08-10");
    await ready();

    expect(await screen.findByRole("button", { name: ru.day.close })).toBeInTheDocument();
  });

  it("игнорирует ?day= неизвестного вида: адрес приходит извне", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());

    renderCalendar("/?day=не-дата");
    await ready();

    expect(screen.queryByRole("button", { name: ru.day.close })).toBeNull();
  });
});

describe("CalendarPage — ?day= в чужом периоде (инвариант 1)", () => {
  it("показывает период открытого дня, а не сегодняшний", async () => {
    // Сценарий раздела 8.2: пролистали календарь в июль, открыли 15 июля,
    // тапнули «+» в ряду типов, создали тип и вернулись на /?day=2026-07-15.
    // viewed при этом монтируется заново и без этой связи встаёт на сегодня.
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.bulkAdd([
      makePeriod({ id: "p-july", year: 2026, month: 7, base_rate: 25 }),
      makePeriod({ id: "p-august", year: 2026, month: 8, base_rate: 30 }),
    ]);

    renderCalendar("/?day=2026-07-15");
    await ready();

    expect(screen.getByText("Июль 2026")).toBeInTheDocument();
  });

  it("пишет запись по ставке ЕЁ периода, а не того, что открыт в календаре", async () => {
    // Инвариант 1: одна операция правит записи не более чем одного периода.
    // Июльская запись, посчитанная по августовской базовой ставке, — это
    // молчаливое нарушение изоляции периодов ровно на том пути, ради которого
    // вход через «+» и добавлен.
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.bulkAdd([
      makePeriod({ id: "p-july", year: 2026, month: 7, base_rate: 25 }),
      makePeriod({ id: "p-august", year: 2026, month: 8, base_rate: 30 }),
    ]);

    renderCalendar("/?day=2026-07-15");
    await ready();

    fireEvent.click(await screen.findByRole("button", { name: hourly.name }));

    await waitFor(async () => {
      const rows = await db.entries.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe("2026-07-15");
      expect(rows[0].rate_per_hour).toBe(25);
      expect(rows[0].amount).toBe(200); // 8 × 25, а не 8 × 30
    });
  });

  it("уводит на экран периода открытого дня, а не сегодняшнего", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.bulkAdd([
      makePeriod({ id: "p-july", year: 2026, month: 7, base_rate: 0 }),
      makePeriod({ id: "p-august", year: 2026, month: 8, base_rate: 30 }),
    ]);

    renderCalendar("/?day=2026-07-15");
    await ready();

    fireEvent.click(await screen.findByRole("button", { name: hourly.name }));
    // Базовая ставка июля равна нулю — в шторке появляется путь к её правке.
    fireEvent.click(await screen.findByText(ru.day.hintNoBaseRateAction));

    expect(screen.getByTestId("location").textContent).toBe("/period?year=2026&month=7");
  });
});

describe("CalendarPage — праздники (раздел 8.1)", () => {
  it("первый запуск засевает праздники, и они видны на сетке", async () => {
    renderCalendar();
    await ready();

    // 15 августа — Успение Пресвятой Богородицы, польский государственный
    // праздник. До блока 5 таблица holidays была пуста всегда.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `${formatDayTitle("2026-08-15")}, Успение Пресвятой Богородицы`,
          hidden: true,
        }),
      ).toBeInTheDocument(),
    );
  });

  it("праздник отличается цветом и от будня, и от выходного", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
    await db.holidays.add({
      id: "h-1",
      user_id: USER_ID,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted_at: null,
      // Понедельник: будень, чтобы цвет нельзя было спутать с правилом выходного.
      date: "2026-08-10",
      name: "День фирмы",
      is_custom: true,
    });

    renderCalendar();
    await ready();

    const holidayCell = await screen.findByRole("button", {
      name: `${formatDayTitle("2026-08-10")}, День фирмы`,
      hidden: true,
    });
    expect(holidayCell.className).toContain("text-app-holiday");
    // Суббота остаётся жёлтой, будень — белым: три состояния различимы.
    // 22-е, а не 15-е: 15 августа — засеянный праздник, и его подпись другая.
    expect(dayCell("2026-08-22").className).toContain("text-app-accent");
    expect(dayCell("2026-08-11").className).toContain("text-white");
  });

  it("мягко удалённый праздник не красит ячейку (инвариант 38)", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
    await db.holidays.add({
      id: "h-gone",
      user_id: USER_ID,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      deleted_at: "2026-02-01T00:00:00.000Z",
      date: "2026-08-10",
      name: "Удалённый",
      is_custom: true,
    });

    renderCalendar();
    await ready();

    expect(dayCell("2026-08-10").className).not.toContain("text-app-holiday");
  });

  it("инвариант 53: из двух праздников на дате ячейка называет самый ранний", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());
    await db.holidays.bulkAdd([
      {
        id: "a-late",
        user_id: USER_ID,
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
        deleted_at: null,
        date: "2026-08-10",
        name: "День фирмы",
        is_custom: true,
      },
      {
        id: "z-early",
        user_id: USER_ID,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null,
        date: "2026-08-10",
        name: "Успение",
        is_custom: false,
      },
    ]);

    renderCalendar();
    await ready();

    expect(
      await screen.findByRole("button", { name: `${formatDayTitle("2026-08-10")}, Успение`, hidden: true }),
    ).toBeInTheDocument();
  });

  it("шторка дня уводит в праздники и возвращает обратно в тот же день", async () => {
    await db.settings.add(makeSettings());
    await db.day_types.add(hourly);
    await db.periods.add(makePeriod());

    renderCalendar();
    await ready();

    fireEvent.click(dayCell("2026-08-10"));
    fireEvent.click(await screen.findByText(ru.day.holidayRowNone));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        `/settings/holidays?add=2026-08-10&return=${encodeURIComponent("/?day=2026-08-10")}`,
      ),
    );
  });
});
