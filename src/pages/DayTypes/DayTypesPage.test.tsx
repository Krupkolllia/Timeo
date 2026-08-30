import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { db } from "@/db/db";
import { DayTypesPage } from "@/pages/DayTypes/DayTypesPage";
import { getLocalUserId } from "@/db/localUser";
import { ru } from "@/i18n/ru";
import { makeEntry, makePeriod, makeSettings, resetDb } from "@/test/factories";
import type { DayType, Entry, Period } from "@/types/models";

// Экран читает singleton-базу под локальным user_id, а не под USER_ID фикстур.
const userId = getLocalUserId();

// Период считается от СЕГОДНЯШНЕГО дня (раздел 6.7 — «текущий период»),
// поэтому и период, и записи сеются на сегодня, а не на фиксированную дату.
const today = new Date();
const YEAR = today.getFullYear();
const MONTH = today.getMonth() + 1;
// Будний день внутри текущего периода: суббота и воскресенье подменяют
// множитель типа дня правилом выходного (раздел 6.2), и тест про пересчёт
// множителя проверял бы не то, что собирался — на выходном пересчёт не даёт
// изменений вовсе.
const WEEKDAY_ISO = (() => {
  for (let day = 1; day <= 28; day += 1) {
    const weekday = new Date(YEAR, MONTH - 1, day).getDay();
    if (weekday !== 0 && weekday !== 6) {
      return `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  /* v8 ignore next -- в месяце не бывает 28 подряд выходных */
  throw new Error("нет будних дней");
})();

function makeType(overrides: Partial<DayType> = {}): DayType {
  return {
    id: "dt-1",
    user_id: userId,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    name: "Рабочий день",
    color: "#38bdf8",
    label: "Р",
    note: "",
    pay_mode: "hourly",
    rate_mode: "multiplier",
    fixed_amount: null,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 0,
    is_archived: false,
    ...overrides,
  };
}

async function seed({
  dayTypes = [makeType()],
  entries = [],
  period = {},
}: { dayTypes?: DayType[]; entries?: Entry[]; period?: Partial<Period> } = {}) {
  await db.settings.add(makeSettings({ user_id: userId, id: "s-local" }));
  await db.periods.add(makePeriod({ user_id: userId, id: "p-current", year: YEAR, month: MONTH, ...period }));
  await db.day_types.bulkAdd(dayTypes);
  if (entries.length > 0) await db.entries.bulkAdd(entries);
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderPage(initialEntry = "/settings/day-types") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/settings/day-types" element={<DayTypesPage />} />
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

describe("DayTypesPage — список (раздел 8.5)", () => {
  it("показывает ставку в контексте текущего периода вместе с множителем", async () => {
    await seed({
      dayTypes: [makeType({ name: "Ночная смена", default_multiplier: 1.5 })],
      period: { base_rate: 30 },
    });

    renderPage();

    // «45.00 потому что ×1.5 от тридцати» — без контекста периода абсолютное
    // число внутри глобального объекта ничего не значит (раздел 5.3.1).
    expect(await screen.findByText(/×1\.5 · 45\.00/)).toBeInTheDocument();
  });

  it("отличает свою ставку замком (раздел 8.5)", async () => {
    await seed({
      dayTypes: [makeType({ name: "Своя ставка", rate_mode: "pinned", default_rate: 60 })],
      period: { base_rate: 30 },
    });

    renderPage();

    expect(await screen.findByText(/🔒 60\.00/)).toBeInTheDocument();
  });

  it("архивирует и возвращает обратно (инварианты 11 и 12)", async () => {
    await seed({ dayTypes: [makeType({ name: "Ночная смена" })] });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.dayTypes.archive }));
    await waitFor(async () => expect((await db.day_types.get("dt-1"))?.is_archived).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.dayTypes.archiveSection) }));
    fireEvent.click(await screen.findByRole("button", { name: ru.dayTypes.unarchive }));
    await waitFor(async () => expect((await db.day_types.get("dt-1"))?.is_archived).toBe(false));
  });

  it("отказывает в удалении типа, на который ссылается запись, и объясняет почему (инвариант 11)", async () => {
    await seed({
      entries: [makeEntry({ user_id: userId, id: "e-1", date: WEEKDAY_ISO, day_type_id: "dt-1" })],
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.dayTypes.delete }));

    expect(await screen.findByText(ru.dayTypes.deleteBlocked)).toBeInTheDocument();
    expect((await db.day_types.get("dt-1"))?.deleted_at).toBeNull();
  });

  it("удаляет неиспользуемый тип мягко и даёт отменить (раздел 9)", async () => {
    await seed();

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: ru.dayTypes.delete }));
    await waitFor(async () => expect((await db.day_types.get("dt-1"))?.deleted_at).not.toBeNull());

    fireEvent.click(await screen.findByRole("button", { name: ru.dayTypes.undo }));
    await waitFor(async () => expect((await db.day_types.get("dt-1"))?.deleted_at).toBeNull());
  });

  it("переставляет типы кнопками порядка", async () => {
    await seed({
      dayTypes: [makeType({ id: "dt-a", name: "A", sort_order: 0 }), makeType({ id: "dt-b", name: "B", sort_order: 1 })],
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: `${ru.dayTypes.moveUp}: B` }));

    await waitFor(async () => {
      const rows = await db.day_types.orderBy("sort_order").toArray();
      expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
    });
  });

  it("возвращает по «назад» туда, откуда пришли", async () => {
    await seed();

    renderPage(`/settings/day-types?return=${encodeURIComponent("/?day=2026-08-10")}`);

    fireEvent.click(await screen.findByRole("button", { name: ru.dayTypes.back }));
    expect(currentLocation()).toBe("/?day=2026-08-10");
  });
});

describe("DayTypesPage — форма", () => {
  it("создаёт тип с введёнными значениями и выводит значок из имени", async () => {
    await seed({ dayTypes: [] });

    renderPage("/settings/day-types?new=1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.name), { target: { value: "Ночная смена" } });
    // Значок не введён руками — следует за именем, чтобы кружок на календаре
    // не остался пустым (инвариант 54 запрещает требовать заполнения).
    expect(screen.getByLabelText(ru.dayTypes.label)).toHaveValue("Н");

    fireEvent.change(screen.getByLabelText(ru.dayTypes.multiplier), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    await waitFor(async () => {
      const rows = await db.day_types.where("user_id").equals(userId).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("Ночная смена");
      expect(rows[0].label).toBe("Н");
      expect(rows[0].default_multiplier).toBe(1.5);
    });
  });

  it("раздел 5.3: сохраняет времена смены по умолчанию и оплачиваемый перерыв", async () => {
    await seed({ dayTypes: [] });

    renderPage("/settings/day-types?new=1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.defaultStartTime), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText(ru.dayTypes.defaultEndTime), { target: { value: "17:00" } });
    fireEvent.change(screen.getByLabelText(ru.dayTypes.defaultBreakMinutes), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText(ru.dayTypes.defaultBreakPaidMinutes), { target: { value: "15" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    await waitFor(async () => {
      const rows = await db.day_types.where("user_id").equals(userId).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].default_start).toBe("09:00");
      expect(rows[0].default_end).toBe("17:00");
      expect(rows[0].default_break_minutes).toBe(30);
      expect(rows[0].default_break_paid_minutes).toBe(15);
    });
  });

  it("сохраняет пустое имя, нулевой множитель и отрицательную ставку (инвариант 54)", async () => {
    await seed({ dayTypes: [] });

    renderPage("/settings/day-types?new=1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.multiplier), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("switch", { name: ru.dayTypes.rateLockToggle }));
    fireEvent.change(screen.getByLabelText(ru.dayTypes.rate), { target: { value: "-10" } });
    // Раздел 9: предупреждение, а не запрет — кнопка сохранения работает.
    expect(screen.getByText(ru.dayTypes.hintNegativeRate)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    await waitFor(async () => {
      const rows = await db.day_types.where("user_id").equals(userId).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("");
      expect(rows[0].default_rate).toBe(-10);
      // Значок всё равно не пустой: пустой кружок на календаре — регрессия.
      expect(rows[0].label).toBe("•");
    });
  });

  it("не сохраняет пустой значок, если поле очистили вручную", async () => {
    // Очистка backspace'ом ставит labelTouched=true при пустом draft.label —
    // ветка вывода значка из имени в этот момент уже не работает, и пустой
    // кружок уезжал бы в базу.
    await seed({ dayTypes: [] });

    renderPage("/settings/day-types?new=1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.name), { target: { value: "Ночная смена" } });
    fireEvent.change(screen.getByLabelText(ru.dayTypes.label), { target: { value: "НС" } });
    fireEvent.change(screen.getByLabelText(ru.dayTypes.label), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    await waitFor(async () => {
      const rows = await db.day_types.where("user_id").equals(userId).toArray();
      expect(rows[0].label).toBe("Н");
    });
  });

  it("отличает pinned-тип без ставки от типа с нулевой ставкой", async () => {
    await seed({
      dayTypes: [
        makeType({ id: "dt-unset", name: "Без ставки", rate_mode: "pinned", default_rate: null }),
        makeType({ id: "dt-zero", name: "Нулевая", rate_mode: "pinned", default_rate: 0, sort_order: 1 }),
      ],
    });

    renderPage();

    expect(await screen.findByText(`🔒 ${ru.dayTypes.noPinnedRateShort}`)).toBeInTheDocument();
    expect(screen.getByText(/🔒 0\.00/)).toBeInTheDocument();
  });

  it("показывает предпросмотр ставки, а не пересчитывает поля друг из друга (раздел 5.3.1)", async () => {
    await seed({ dayTypes: [], period: { base_rate: 30 } });

    renderPage("/settings/day-types?new=1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.multiplier), { target: { value: "1.5" } });

    // Множитель показывает, во что он выльется, но поле ставки не трогает:
    // хранение производного значения — это ровно тот баг, который чинила
    // миграция version(5) (8 × 50 × 1.667 вместо 8 × 50).
    expect(screen.getByText(/при базе 30\.00 PLN это 45\.00 PLN за час/)).toBeInTheDocument();
    expect(screen.getByLabelText(ru.dayTypes.rate)).toHaveValue("0");
  });

  it("не показывает подсказку об отсутствии базовой ставки, пока период ещё читается", async () => {
    // useLiveQuery отдаёт undefined и пока читает, и когда строки нет. Без
    // различения форма на кадр показывала подсказку инварианта 22, а потом
    // подменяла её предпросмотром — скачок вёрстки на самом читаемом месте.
    await seed({ dayTypes: [], period: { base_rate: 30 } });

    renderPage("/settings/day-types?new=1");

    expect(screen.queryByText(ru.dayTypes.hintNoBaseRate)).toBeNull();
    await screen.findByLabelText(ru.dayTypes.multiplier);
    expect(screen.queryByText(ru.dayTypes.hintNoBaseRate)).toBeNull();
  });

  it("замок закрывается только переключателем, а не вводом в поле ставки (раздел 5.3.1)", async () => {
    await seed({ dayTypes: [], period: { base_rate: 30 } });

    renderPage("/settings/day-types?new=1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.rate), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    await waitFor(async () => {
      const rows = await db.day_types.where("user_id").equals(userId).toArray();
      // Число сохранено, но тип остался привязанным к базовой ставке периода —
      // люди часто вписывают ставку, которую знают наизусть, не собираясь
      // отвязывать тип от базы.
      expect(rows[0].rate_mode).toBe("multiplier");
      expect(rows[0].default_rate).toBe(50);
    });
  });

  it("объясняет, почему у типа со своей ставкой не работает множитель", async () => {
    await seed({ dayTypes: [], period: { base_rate: 30 } });

    renderPage("/settings/day-types?new=1");

    fireEvent.click(await screen.findByRole("switch", { name: ru.dayTypes.rateLockToggle }));
    fireEvent.change(screen.getByLabelText(ru.dayTypes.rate), { target: { value: "50" } });

    expect(screen.getByText(ru.dayTypes.hintPinnedNoMultiplier)).toBeInTheDocument();
  });

  it("называет причину, когда у периода нет базовой ставки (инвариант 22)", async () => {
    await seed({ dayTypes: [], period: { base_rate: 0 } });

    renderPage("/settings/day-types?new=1");

    expect(await screen.findByText(ru.dayTypes.hintNoBaseRate)).toBeInTheDocument();
    // Ставка периода правится на экране периода (раздел 8.4), поэтому подсказка
    // ведёт туда, а не предлагает поле здесь.
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.dayTypes.hintNoBaseRateAction) }));
    expect(currentLocation()).toContain("/period?year=");
  });
});

describe("DayTypesPage — правка типа дня (раздел 6.7)", () => {
  it("косметическая правка применяется молча и ничего не спрашивает", async () => {
    await seed({
      entries: [makeEntry({ user_id: userId, id: "e-1", date: WEEKDAY_ISO, day_type_id: "dt-1", amount: 240 })],
    });

    renderPage("/settings/day-types?edit=dt-1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.name), { target: { value: "Новое имя" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    await waitFor(async () => expect((await db.day_types.get("dt-1"))?.name).toBe("Новое имя"));
    expect(screen.queryByText(ru.dayTypes.offerTitle)).toBeNull();
    // Инвариант 10: запись не изменилась.
    expect((await db.entries.get("e-1"))?.amount).toBe(240);
  });

  it("после финансовой правки предлагает обновить записи, оставляя всё как есть по умолчанию", async () => {
    await seed({
      entries: [makeEntry({ user_id: userId, id: "e-1", date: WEEKDAY_ISO, day_type_id: "dt-1", amount: 240 })],
      period: { base_rate: 30 },
    });

    renderPage("/settings/day-types?edit=dt-1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.multiplier), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    expect(await screen.findByText(ru.dayTypes.offerTitle)).toBeInTheDocument();
    // Инвариант 10: до ответа не изменена ни одна запись.
    expect((await db.entries.get("e-1"))?.amount).toBe(240);

    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.offerKeep }));
    expect((await db.entries.get("e-1"))?.amount).toBe(240);
    // Сам тип дня при этом сохранён: отказ обновлять записи — не отказ от правки.
    expect((await db.day_types.get("dt-1"))?.default_multiplier).toBe(1.5);
  });

  it("по согласию обновляет записи текущего периода", async () => {
    await seed({
      entries: [makeEntry({ user_id: userId, id: "e-1", date: WEEKDAY_ISO, day_type_id: "dt-1", amount: 240 })],
      period: { base_rate: 30 },
    });

    renderPage("/settings/day-types?edit=dt-1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.multiplier), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));
    fireEvent.click(await screen.findByRole("button", { name: ru.dayTypes.offerUpdate }));

    await waitFor(async () => expect((await db.entries.get("e-1"))?.amount).toBe(360));
  });

  it("не предлагает ничего, когда обновлять нечего", async () => {
    // Запись с ручной ставкой исключена (инвариант 9), поэтому предложения нет
    // вовсе — вопрос «обновить 0 записей?» был бы шумом.
    await seed({
      entries: [
        makeEntry({
          user_id: userId,
          id: "e-1",
          date: WEEKDAY_ISO,
          day_type_id: "dt-1",
          rate_is_manual: true,
          rate_per_hour: 50,
          amount: 400,
        }),
      ],
    });

    renderPage("/settings/day-types?edit=dt-1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.multiplier), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    await waitFor(async () => expect((await db.day_types.get("dt-1"))?.default_multiplier).toBe(1.5));
    expect(screen.queryByText(ru.dayTypes.offerTitle)).toBeNull();
    expect((await db.entries.get("e-1"))?.amount).toBe(400);
  });

  it("не предлагает обновление в закрытом периоде (инвариант 2)", async () => {
    await seed({
      entries: [makeEntry({ user_id: userId, id: "e-1", date: WEEKDAY_ISO, day_type_id: "dt-1", amount: 240 })],
      period: { is_closed: true, closed_totals: { amount: 240, total_hours: 8, norm_hours_covered: 8 } },
    });

    renderPage("/settings/day-types?edit=dt-1");

    fireEvent.change(await screen.findByLabelText(ru.dayTypes.multiplier), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: ru.dayTypes.save }));

    await waitFor(async () => expect((await db.day_types.get("dt-1"))?.default_multiplier).toBe(1.5));
    expect(screen.queryByText(ru.dayTypes.offerTitle)).toBeNull();
    expect((await db.entries.get("e-1"))?.amount).toBe(240);
  });
});
