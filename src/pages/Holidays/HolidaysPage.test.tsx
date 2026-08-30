import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { db } from "@/db/db";
import { HolidaysPage } from "@/pages/Holidays/HolidaysPage";
import { getLocalUserId } from "@/db/localUser";
import { ru } from "@/i18n/ru";
import { makeEntry, makePeriod, makeSettings, resetDb } from "@/test/factories";
import type { Holiday, Settings } from "@/types/models";

// Экран читает singleton-базу под локальным user_id, а не под USER_ID фикстур.
const userId = getLocalUserId();

function makeRow(overrides: Partial<Holiday> = {}): Holiday {
  return {
    id: "h-1",
    user_id: userId,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    date: "2026-05-01",
    name: "Праздник труда",
    is_custom: false,
    ...overrides,
  };
}

async function seed({ holidays = [], settings = {} }: { holidays?: Holiday[]; settings?: Partial<Settings> } = {}) {
  await db.settings.add(makeSettings({ user_id: userId, id: "s-local", ...settings }));
  if (holidays.length > 0) await db.holidays.bulkAdd(holidays);
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderPage(initialEntry = "/settings/holidays") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/settings/holidays" element={<HolidaysPage />} />
        <Route path="*" element={<span data-testid="elsewhere" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function currentLocation(): string {
  return screen.getByTestId("location").textContent ?? "";
}

beforeEach(async () => {
  await resetDb();
});

describe("HolidaysPage — список (раздел 8.6)", () => {
  it("группирует праздники по годам", async () => {
    await seed({
      holidays: [
        makeRow({ id: "a", date: "2026-05-01", name: "Праздник труда" }),
        makeRow({ id: "b", date: "2027-01-01", name: "Новый год" }),
      ],
    });

    renderPage();

    expect(await screen.findByRole("heading", { name: "2026" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2027" })).toBeInTheDocument();
    expect(screen.getByText("Праздник труда")).toBeInTheDocument();
    expect(screen.getByText("Новый год")).toBeInTheDocument();
  });

  it("не показывает мягко удалённые строки (инвариант 38)", async () => {
    await seed({
      holidays: [makeRow({ id: "gone", deleted_at: "2026-02-01T00:00:00.000Z", name: "Удалённый" })],
    });

    renderPage();

    expect(await screen.findByText(ru.holidays.empty)).toBeInTheDocument();
    expect(screen.queryByText("Удалённый")).not.toBeInTheDocument();
  });

  it("удаление мягкое, с окном отмены, и возвращает строку по отмене", async () => {
    await seed({ holidays: [makeRow()] });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: `${ru.holidays.delete}: Праздник труда` }));

    await waitFor(async () => expect((await db.holidays.get("h-1"))?.deleted_at).not.toBeNull());
    expect(await screen.findByText(ru.holidays.deleted)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.holidays.undo }));
    await waitFor(async () => expect((await db.holidays.get("h-1"))?.deleted_at).toBeNull());
    expect(await screen.findByText("Праздник труда")).toBeInTheDocument();
  });

  it("«назад» возвращает по адресу из return=", async () => {
    await seed();
    renderPage("/settings/holidays?return=%2F%3Fday%3D2026-08-10");

    fireEvent.click(await screen.findByRole("button", { name: ru.holidays.back }));
    expect(currentLocation()).toBe("/?day=2026-08-10");
  });
});

describe("HolidaysPage — добавление (инвариант 56, раздел 9)", () => {
  it("сохраняет праздник с пустым именем: ввод ничем не блокируется", async () => {
    await seed();
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.holidays.add }));
    fireEvent.change(screen.getByLabelText(ru.holidays.date), { target: { value: "2026-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.save }));

    await waitFor(async () => {
      const rows = await db.holidays.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].date).toBe("2026-12-31");
      expect(rows[0].name).toBe("");
      // Всё, что создано на экране, — пользовательское (раздел 5.5).
      expect(rows[0].is_custom).toBe(true);
    });
  });

  it("предупреждает о второй записи на ту же дату, но сохраняет её", async () => {
    await seed({ holidays: [makeRow({ date: "2026-05-01" })] });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.holidays.add }));
    fireEvent.change(screen.getByLabelText(ru.holidays.date), { target: { value: "2026-05-01" } });
    fireEvent.change(screen.getByLabelText(ru.holidays.name), { target: { value: "День фирмы" } });

    // Предупреждение, а не запрет: кнопка сохранения работает.
    expect(screen.getByText(ru.holidays.duplicateWarning)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.save }));

    await waitFor(async () => expect(await db.holidays.where("date").equals("2026-05-01").count()).toBe(2));
  });

  it("?add= открывает форму с подставленной датой и возвращает в день после сохранения", async () => {
    await seed();
    renderPage("/settings/holidays?add=2026-08-10&return=%2F%3Fday%3D2026-08-10");

    expect(await screen.findByLabelText(ru.holidays.date)).toHaveValue("2026-08-10");
    fireEvent.change(screen.getByLabelText(ru.holidays.name), { target: { value: "День фирмы" } });
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.save }));

    await waitFor(() => expect(currentLocation()).toBe("/?day=2026-08-10"));
    expect((await db.holidays.toArray())[0].date).toBe("2026-08-10");
  });

  it("мусор в ?add= не попадает ни в поле, ни в запись", async () => {
    await seed();
    renderPage("/settings/holidays?add=не-дата");

    // Форма не открывается вовсе: подставлять в поле даты произвольную строку
    // из адреса нечего.
    expect(await screen.findByRole("heading", { name: ru.holidays.multipliersTitle })).toBeInTheDocument();
  });
});

describe("HolidaysPage — множители (раздел 8.4 на этом экране)", () => {
  it("сохраняет множитель праздника в настройки", async () => {
    await seed();
    renderPage();

    fireEvent.change(await screen.findByLabelText(ru.holidays.multiplierHoliday), { target: { value: "2" } });

    await waitFor(async () =>
      expect((await db.settings.get("s-local"))?.weekend_multipliers).toEqual({
        saturday: 1,
        sunday: 1,
        holiday: 2,
      }),
    );
  });

  it("правит субботу и воскресенье независимо друг от друга", async () => {
    await seed({ settings: { weekend_multipliers: { saturday: 1, sunday: 1, holiday: 2 } } });
    renderPage();

    fireEvent.change(await screen.findByLabelText(ru.holidays.multiplierSaturday), { target: { value: "1.5" } });
    await waitFor(async () =>
      expect((await db.settings.get("s-local"))?.weekend_multipliers.saturday).toBe(1.5),
    );

    fireEvent.change(screen.getByLabelText(ru.holidays.multiplierSunday), { target: { value: "2" } });
    await waitFor(async () =>
      expect((await db.settings.get("s-local"))?.weekend_multipliers).toEqual({
        saturday: 1.5,
        sunday: 2,
        holiday: 2,
      }),
    );
  });

  it("инвариант 51: смена множителя не пересчитывает сохранённые записи", async () => {
    await seed({ holidays: [makeRow({ date: "2026-05-01" })] });
    await db.periods.add(makePeriod({ user_id: userId, id: "p", year: 2026, month: 5 }));
    await db.entries.add(makeEntry({ user_id: userId, id: "e-1", date: "2026-05-01", amount: 240, multiplier: 1 }));

    renderPage();
    fireEvent.change(await screen.findByLabelText(ru.holidays.multiplierHoliday), { target: { value: "2" } });
    await waitFor(async () => expect((await db.settings.get("s-local"))?.weekend_multipliers.holiday).toBe(2));

    const entry = await db.entries.get("e-1");
    expect(entry?.amount).toBe(240);
    expect(entry?.multiplier).toBe(1);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("инвариант 51 и 52: добавление праздника не меняет сумм, в том числе в закрытом периоде", async () => {
    await seed();
    await db.periods.add(
      makePeriod({
        user_id: userId,
        id: "p-closed",
        year: 2026,
        month: 5,
        is_closed: true,
        closed_totals: { amount: 240, total_hours: 8, norm_hours_covered: 8 },
      }),
    );
    await db.entries.add(makeEntry({ user_id: userId, id: "e-1", date: "2026-05-01", amount: 240 }));

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: ru.holidays.add }));
    fireEvent.change(screen.getByLabelText(ru.holidays.date), { target: { value: "2026-05-01" } });
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.save }));

    await waitFor(async () => expect(await db.holidays.count()).toBe(1));
    const entry = await db.entries.get("e-1");
    expect(entry?.amount).toBe(240);
    expect(entry?.updated_at).toBe("2026-08-01T00:00:00.000Z");
    expect((await db.periods.get("p-closed"))?.closed_totals?.amount).toBe(240);
  });
});

describe("HolidaysPage — возврат после ?add=", () => {
  it("«назад» из формы, открытой сразу через ?add=, уводит по return=, а не в список", async () => {
    await seed();
    renderPage("/settings/holidays?add=2026-08-10&return=%2F%3Fday%3D2026-08-10");

    // Список в этом заходе не открывали ни разу — экран целиком пришёл из
    // шторки дня, и «назад» обязана вести туда же, а не в список, которого
    // пользователь не видел.
    await screen.findByLabelText(ru.holidays.date);
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.back }));
    expect(currentLocation()).toBe("/?day=2026-08-10");
  });

  it("«назад» из формы, открытой кнопкой «+» внутри списка, отменяет форму и остаётся в списке", async () => {
    await seed();
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.holidays.add }));
    fireEvent.change(screen.getByLabelText(ru.holidays.name), { target: { value: "День фирмы" } });
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.back }));

    expect(await screen.findByRole("heading", { name: ru.holidays.multipliersTitle })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.holidays.add }));
    fireEvent.change(screen.getByLabelText(ru.holidays.name), { target: { value: "День фирмы" } });
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.save }));

    await waitFor(async () => expect(await db.holidays.count()).toBe(1));
    expect(await screen.findByText("День фирмы")).toBeInTheDocument();
  });
});

describe("HolidaysPage — незаконченный ввод даты", () => {
  it("пустая дата не сохраняется как пустая строка и объясняется на экране", async () => {
    await seed();
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.holidays.add }));
    fireEvent.change(screen.getByLabelText(ru.holidays.date), { target: { value: "2026-12-31" } });
    // Нативный выбор даты умеет быть пустым и отдаёт "" на середине правки.
    fireEvent.change(screen.getByLabelText(ru.holidays.date), { target: { value: "" } });

    expect(screen.getByText(new RegExp(ru.holidays.emptyDateWarning))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.save }));

    await waitFor(async () => {
      const rows = await db.holidays.toArray();
      expect(rows).toHaveLength(1);
      // Сохраняется последняя полная дата, а не "" — иначе строка не совпала бы
      // ни с одним днём календаря и рисовалась бы как «undefined undefined».
      expect(rows[0].date).toBe("2026-12-31");
    });
  });

  it("сохранение сразу после открытия формы берёт дату, с которой она открылась", async () => {
    await seed();
    renderPage("/settings/holidays?add=2026-08-10&return=%2F");

    fireEvent.change(await screen.findByLabelText(ru.holidays.date), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: ru.holidays.save }));

    await waitFor(async () => expect((await db.holidays.toArray())[0].date).toBe("2026-08-10"));
  });
});

describe("HolidaysPage — двойной тап по «Сохранить»", () => {
  it("создаёт одну запись, а не две", async () => {
    await seed();
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.holidays.add }));
    fireEvent.change(screen.getByLabelText(ru.holidays.date), { target: { value: "2026-09-09" } });
    fireEvent.change(screen.getByLabelText(ru.holidays.name), { target: { value: "Двойной тап" } });

    // Форма закрывается только после записи, поэтому до тех пор кнопка на
    // месте и успевает получить второй тап.
    const save = screen.getByRole("button", { name: ru.holidays.save });
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(async () => expect(await db.holidays.count()).toBe(1));
    // Ждём закрытия формы, чтобы вторая запись не появилась уже после проверки.
    expect(await screen.findByRole("heading", { name: ru.holidays.multipliersTitle })).toBeInTheDocument();
    expect(await db.holidays.count()).toBe(1);
  });
});
