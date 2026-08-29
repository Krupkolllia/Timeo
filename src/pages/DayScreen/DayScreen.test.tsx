import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/db/db";
import { DayScreen } from "@/pages/DayScreen/DayScreen";
import { ru } from "@/i18n/ru";
import type { DayType, Entry, Period, Settings } from "@/types/models";
import { makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings, resetDb, USER_ID } from "@/test/factories";

const DATE = "2026-08-10"; // понедельник
const SATURDAY = "2026-08-15";
const SUNDAY = "2026-08-16";

const hourly = makeDayType();
const night = makeDayType({ id: "dt-night", name: "Ночная смена", default_multiplier: 1.5, sort_order: 1 });
const unpaid = makeDayType({ id: "dt-unpaid", name: "Отгул", pay_mode: "unpaid", default_hours: 0, sort_order: 2 });
const fixed = makeDayType({
  id: "dt-fixed",
  name: "Дежурство",
  pay_mode: "fixed_amount",
  fixed_amount: 150,
  sort_order: 3,
});
const vacation = makeDayType({
  id: "dt-vacation",
  name: "Отпуск",
  ignore_auto_multipliers: true,
  default_multiplier: 1,
  sort_order: 4,
});

interface Options {
  date?: string;
  dayTypes?: DayType[];
  period?: Partial<Period>;
  settings?: Partial<Settings>;
}

function renderDay({ date = DATE, dayTypes = [hourly, night, unpaid, fixed, vacation], period, settings }: Options = {}) {
  const onClose = vi.fn();
  const onOpenPeriod = vi.fn();
  const onEntryDeleted = vi.fn();
  const onCreateDayType = vi.fn();
  const view = render(
    <DayScreen
      date={date}
      userId={USER_ID}
      dayTypes={dayTypes}
      period={makePeriod(period)}
      settings={makeSettings(settings)}
      onClose={onClose}
      onOpenPeriod={onOpenPeriod}
      onEntryDeleted={onEntryDeleted}
      onCreateDayType={onCreateDayType}
    />,
  );
  return { onClose, onOpenPeriod, onEntryDeleted, onCreateDayType, ...view };
}

function fields() {
  return {
    hours: screen.getByLabelText(ru.day.hours),
    multiplier: screen.getByLabelText(ru.day.multiplier),
    rate: screen.getByLabelText(ru.day.rate),
    amount: screen.getByLabelText(ru.day.amount),
  };
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

async function storedEntries(): Promise<Entry[]> {
  const rows = await db.entries.where("user_id").equals(USER_ID).toArray();
  return rows
    .filter((row) => row.deleted_at === null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** Ждёт, пока в базе окажется ровно одна запись, и отдаёт её. */
async function onlyEntry(): Promise<Entry> {
  let row: Entry | undefined;
  await waitFor(async () => {
    const rows = await storedEntries();
    expect(rows).toHaveLength(1);
    row = rows[0];
  });
  return row!;
}

beforeEach(async () => {
  await resetDb();
});

describe("DayScreen — создание записи", () => {
  it("тап по типу дня создаёт запись с его значениями по умолчанию", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));

    const entry = await onlyEntry();
    expect(entry).toMatchObject({
      day_type_id: "dt-night",
      hours: 8,
      multiplier: 1.5,
      rate_per_hour: 30,
      rate_is_manual: false,
      // Множитель применяется к сумме дня, а не к ставке: 8 × 30 × 1.5.
      amount: 360,
      rate_source: "period_base",
    });
  });

  it("не создаёт вторую строку при быстром двойном тапе по разным типам", async () => {
    // Оба вызова persist видят entry === undefined до того, как первый
    // createEntry успевает вернуться; без замка день задваивался.
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));

    const entry = await onlyEntry();
    expect(entry.day_type_id).toBe("dt-night");
    expect(entry.amount).toBe(360);
  });

  it("показывает подсказку, когда типов дня нет", () => {
    renderDay({ dayTypes: [] });
    expect(screen.getByText(ru.day.noDayTypes)).toBeInTheDocument();
    expect(screen.queryByLabelText(ru.day.hours)).not.toBeInTheDocument();
  });

  it("не предлагает архивные типы дня", () => {
    renderDay({ dayTypes: [hourly, makeDayType({ id: "dt-old", name: "Старый", is_archived: true })] });
    expect(screen.queryByRole("button", { name: "Старый" })).not.toBeInTheDocument();
  });
});

describe("DayScreen — часы, множитель и ставка", () => {
  it("шаг ±0.5 пересчитывает сумму и не уходит ниже нуля", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    fireEvent.click(screen.getByRole("button", { name: "+" }));
    await waitFor(async () => expect((await onlyEntry()).hours).toBe(8.5));
    expect((await onlyEntry()).amount).toBe(255);

    const minus = screen.getByRole("button", { name: "−" });
    for (let i = 0; i < 20; i++) fireEvent.click(minus);
    await waitFor(async () => expect((await onlyEntry()).hours).toBe(0));
    expect((await onlyEntry()).amount).toBe(0);
  });

  it("правка множителя не трогает ставку", async () => {
    // Прежняя связь «ставка = база × множитель» затирала вписанную руками
    // ставку при правке множителя (коммит dbccfb8).
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(fields().rate, "50");
    await waitFor(async () => expect((await onlyEntry()).rate_is_manual).toBe(true));

    type(fields().multiplier, "2");
    await waitFor(async () => expect((await onlyEntry()).multiplier).toBe(2));

    const entry = await onlyEntry();
    expect(entry.rate_per_hour).toBe(50);
    expect(entry.rate_is_manual).toBe(true);
    expect(entry.amount).toBe(800);
  });

  it("правка ставки не выводит множитель и делает ставку ручной", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    await onlyEntry();

    type(fields().rate, "40");

    await waitFor(async () => expect((await onlyEntry()).rate_per_hour).toBe(40));
    const entry = await onlyEntry();
    expect(entry.multiplier).toBe(1.5);
    expect(entry.rate_is_manual).toBe(true);
    expect(entry.rate_source).toBe("manual");
    expect(entry.amount).toBe(480);
  });

  it("множитель работает и на периоде без базовой ставки", async () => {
    // Ради этого случая множитель и отделили от ставки: base_rate × multiplier
    // на нулевой базе всегда ноль.
    renderDay({ period: { base_rate: 0 } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(fields().rate, "50");
    await waitFor(async () => expect((await onlyEntry()).rate_per_hour).toBe(50));
    type(fields().multiplier, "2");

    await waitFor(async () => expect((await onlyEntry()).amount).toBe(800));
  });
});

describe("DayScreen — подпись источника множителя", () => {
  it.each([
    ["выходной день, суббота", SATURDAY, ru.day.multiplierSourceSaturday],
    ["воскресенье", SUNDAY, ru.day.multiplierSourceSunday],
  ])("%s", async (_name, date, label) => {
    renderDay({ date, settings: { weekend_multipliers: { saturday: 1.5, sunday: 2, holiday: 2.5 } } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    expect(await screen.findByText(new RegExp(label))).toBeInTheDocument();
  });

  it("праздник перебивает выходной", async () => {
    // Праздники приезжают из Dexie отдельным запросом, уже после первого
    // черновика: предзаполненный множитель обязан обновиться сам, иначе на
    // праздник экран показывал бы воскресное правило до первого тапа.
    await db.holidays.add(makeHoliday({ date: SUNDAY }));
    renderDay({ date: SUNDAY, settings: { weekend_multipliers: { saturday: 1.5, sunday: 2, holiday: 2.5 } } });

    expect(await screen.findByText(new RegExp(ru.day.multiplierSourceHoliday))).toBeInTheDocument();
    expect(fields().multiplier).toHaveValue("2.5");

    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await waitFor(async () => expect((await onlyEntry()).multiplier).toBe(2.5));
  });

  it("тип дня со своим множителем подписан как тип дня", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    expect(await screen.findByText(new RegExp(ru.day.multiplierSourceDayType))).toBeInTheDocument();
  });

  it("отпуск не получает воскресный множитель", async () => {
    // Раздел 5.3: отпуск в воскресенье не оплачивается вдвойне.
    renderDay({ date: SUNDAY, settings: { weekend_multipliers: { saturday: 1.5, sunday: 2, holiday: 2.5 } } });
    fireEvent.click(screen.getByRole("button", { name: "Отпуск" }));

    await waitFor(async () => expect((await onlyEntry()).multiplier).toBe(1));
    expect(screen.getByText("×1")).toBeInTheDocument();
  });

  it("тип дня, подавляющий авто-правила, но со своим множителем, тоже подписан", async () => {
    // Раздел 5.3: «×1» ничего не объясняет и подписи не получает, а вот
    // собственный множитель такого типа — получает.
    const paidVacation = makeDayType({
      id: "dt-paid-vacation",
      name: "Оплачиваемый отпуск",
      ignore_auto_multipliers: true,
      default_multiplier: 0.8,
      sort_order: 9,
    });
    renderDay({ date: SUNDAY, dayTypes: [hourly, paidVacation] });
    fireEvent.click(screen.getByRole("button", { name: "Оплачиваемый отпуск" }));

    expect(await screen.findByText(new RegExp(ru.day.multiplierSourceDayType))).toBeInTheDocument();
    await waitFor(async () => expect((await onlyEntry()).multiplier).toBe(0.8));
  });

  it("значение, заданное руками, подписано как ручное", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(fields().multiplier, "3");
    expect(await screen.findByText(new RegExp(ru.day.multiplierSourceManual))).toBeInTheDocument();
  });
});

describe("DayScreen — режимы оплаты", () => {
  it("unpaid держит сумму на нуле и объясняет почему", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Отгул" }));

    await waitFor(async () => expect((await onlyEntry()).amount).toBe(0));
    expect(screen.getByText(ru.day.hintUnpaidDayType)).toBeInTheDocument();
    // Раздел 9: поля остаются доступными, а не блокируются.
    expect(fields().rate).not.toBeDisabled();
  });

  it("fixed_amount берёт сумму из типа дня", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Дежурство" }));

    await waitFor(async () => expect((await onlyEntry()).amount).toBe(150));
    expect(screen.getByText(ru.day.payModeFixedAmount)).toBeInTheDocument();
  });

  it("ручная сумма перебивает всё и возвращается к расчёту при выключении", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(async () => expect((await onlyEntry()).amount_override).toBe(240));

    type(fields().amount, "1000");
    await waitFor(async () => expect((await onlyEntry()).amount).toBe(1000));

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(async () => expect((await onlyEntry()).amount_override).toBeNull());
    expect((await onlyEntry()).amount).toBe(240);
  });

  it("отрицательная сумма сохраняется с мягким предупреждением", async () => {
    // Инвариант 24: это законный способ записать удержание.
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(async () => expect((await onlyEntry()).amount_override).toBe(240));
    type(fields().amount, "-500");

    await waitFor(async () => expect((await onlyEntry()).amount).toBe(-500));
    expect(screen.getByText(ru.day.hintNegativeAmount)).toBeInTheDocument();
  });
});

describe("DayScreen — подсказки", () => {
  it("больше 24 часов сохраняется и предупреждает", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(fields().hours, "26");
    await waitFor(async () => expect((await onlyEntry()).hours).toBe(26));
    expect(screen.getByText(ru.day.hintManyHours).className).not.toContain("invisible");
  });

  it("нулевая базовая ставка ведёт на экран периода", async () => {
    const { onOpenPeriod } = renderDay({ period: { base_rate: 0 } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));

    const hint = await screen.findByText(ru.day.hintNoBaseRate);
    fireEvent.click(hint);
    expect(onOpenPeriod).toHaveBeenCalled();
  });

  it("нулевая ставка, вписанная руками, объясняется отдельной строкой", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(fields().rate, "0");
    await waitFor(() => expect(screen.getByText(ru.day.hintZeroRate).className).not.toContain("invisible"));
    // Причина здесь не в базовой ставке периода — вторую подсказку не показываем.
    expect(screen.queryByText(ru.day.hintNoBaseRate)).not.toBeInTheDocument();
  });
});

describe("DayScreen — смена типа дня", () => {
  it("нетронутый экран берёт значения нового типа", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));

    await waitFor(async () => expect((await onlyEntry()).multiplier).toBe(1.5));
  });

  it("уже введённые значения переживают смену типа", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(fields().hours, "10");
    await waitFor(async () => expect((await onlyEntry()).hours).toBe(10));

    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    await waitFor(async () => expect((await onlyEntry()).day_type_id).toBe("dt-night"));

    const entry = await onlyEntry();
    expect(entry.hours).toBe(10);
    expect(entry.multiplier).toBe(1);
    expect(entry.amount).toBe(300);
  });
});

describe("DayScreen — несколько записей на день", () => {
  it("полоска записей появляется только со второй записи", async () => {
    await db.entries.add(makeEntry({ id: "e-1" }));
    renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });
    expect(screen.queryByRole("button", { name: /^1\./ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.day.addEntry }));
    expect(await screen.findByRole("button", { name: /^2\./ })).toBeInTheDocument();
  });

  it("«добавить запись» не затирает первую запись дня", async () => {
    // Гонка: после сброса выбранной записи entry снова становится entries[0],
    // и эффект возвращал её id в entryIdRef, пока createEntry был в полёте.
    await db.entries.bulkAdd([
      makeEntry({ id: "e-1", created_at: "2026-08-01T10:00:00.000Z", hours: 12, amount: 360, note: "первая" }),
      makeEntry({ id: "e-2", created_at: "2026-08-01T11:00:00.000Z", hours: 4, amount: 120, note: "вторая" }),
    ]);
    renderDay();

    fireEvent.click(await screen.findByRole("button", { name: /^2\./ }));
    fireEvent.click(screen.getByRole("button", { name: ru.day.addEntry }));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Отпуск" }));

    await waitFor(async () => expect(await storedEntries()).toHaveLength(3));
    const rows = await storedEntries();
    expect(rows[0]).toMatchObject({ id: "e-1", hours: 12, amount: 360, note: "первая" });
    expect(rows[1]).toMatchObject({ id: "e-2", hours: 4, amount: 120, note: "вторая" });
    expect(rows[2].day_type_id).toBe("dt-vacation");
  });

  it("«добавить запись» во время создания строки не присваивает её id новому черновику", async () => {
    // Первый тап ещё не долетел до Dexie, когда пользователь начинает новую
    // строку: продолжение первого createEntry относится уже к прошлому
    // черновику и не должно направлять в неё дальнейшие правки.
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    fireEvent.click(screen.getByRole("button", { name: ru.day.addEntry }));
    fireEvent.click(screen.getByRole("button", { name: "Отпуск" }));

    await waitFor(async () => expect((await storedEntries()).length).toBeGreaterThanOrEqual(1));
    await new Promise((resolve) => setTimeout(resolve, 60));

    const rows = await storedEntries();
    // Ночная смена сохранилась ровно такой, какой её выбрали.
    expect(rows.some((row) => row.day_type_id === "dt-night" && row.amount === 360)).toBe(true);
    expect(rows.some((row) => row.day_type_id === "dt-vacation")).toBe(true);
  });

  it("правка идёт в выбранную запись, а не в первую", async () => {
    await db.entries.bulkAdd([
      makeEntry({ id: "e-1", created_at: "2026-08-01T10:00:00.000Z", hours: 12, amount: 360 }),
      makeEntry({ id: "e-2", created_at: "2026-08-01T11:00:00.000Z", hours: 4, amount: 120 }),
    ]);
    renderDay();

    fireEvent.click(await screen.findByRole("button", { name: /^2\./ }));
    await waitFor(() => expect(fields().hours).toHaveValue("4"));
    type(fields().hours, "6");

    await waitFor(async () => expect((await db.entries.get("e-2"))?.hours).toBe(6));
    expect((await db.entries.get("e-1"))?.hours).toBe(12);
  });
});

describe("DayScreen — удаление", () => {
  it("удаление последней записи закрывает шторку и отдаёт запись для отмены", async () => {
    await db.entries.add(makeEntry({ id: "e-1" }));
    const { onClose, onEntryDeleted } = renderDay();
    // Ждём саму кнопку: значения по умолчанию для рабочего дня дают ту же
    // сумму 240, и ожидание по числу срабатывало бы до загрузки записи.
    fireEvent.click(await screen.findByRole("button", { name: ru.day.deleteEntry }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onEntryDeleted).toHaveBeenCalledWith(expect.objectContaining({ id: "e-1" }));
    // Мягкое удаление, а не физическое: плашка «отменить» должна иметь что вернуть.
    expect((await db.entries.get("e-1"))?.deleted_at).not.toBeNull();
  });

  it("удаление одной из нескольких записей оставляет шторку открытой", async () => {
    await db.entries.bulkAdd([
      makeEntry({ id: "e-1", created_at: "2026-08-01T10:00:00.000Z" }),
      makeEntry({ id: "e-2", created_at: "2026-08-01T11:00:00.000Z", hours: 4, amount: 120 }),
    ]);
    const { onClose } = renderDay();

    fireEvent.click(await screen.findByRole("button", { name: /^2\./ }));
    fireEvent.click(screen.getByRole("button", { name: ru.day.deleteEntry }));

    await waitFor(async () => expect(await storedEntries()).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("кнопка удаления не показывается, пока записи нет", () => {
    renderDay();
    expect(screen.queryByRole("button", { name: ru.day.deleteEntry })).not.toBeInTheDocument();
  });
});

describe("DayScreen — закрытый период (инвариант 2)", () => {
  it("показывает расшифровку только на чтение и путь к переоткрытию", async () => {
    await db.entries.add(makeEntry({ id: "e-1" }));
    const { onOpenPeriod, onClose } = renderDay({ period: { is_closed: true } });

    expect(screen.getByText(ru.day.closedPeriodNotice)).toBeInTheDocument();
    expect(await screen.findByText("240.00 PLN")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Рабочий день" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.day.closedPeriodAction }));
    expect(onOpenPeriod).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));
    expect(onClose).toHaveBeenCalled();
  });

  it("сообщает, что за день записей нет", async () => {
    renderDay({ period: { is_closed: true } });
    expect(await screen.findByText(ru.day.closedPeriodEmpty)).toBeInTheDocument();
  });

  it("строка записи с неизвестным типом дня не роняет экран", async () => {
    await db.entries.add(makeEntry({ id: "e-1", day_type_id: "dt-gone" }));
    renderDay({ period: { is_closed: true } });
    expect(await screen.findByText("—")).toBeInTheDocument();
  });
});

describe("DayScreen — время смены", () => {
  it("поля времени появляются только по настройке", async () => {
    renderDay();
    expect(screen.queryByLabelText(ru.day.startTime)).not.toBeInTheDocument();
  });

  it("сохраняет начало, конец и перерыв", async () => {
    renderDay({ settings: { show_shift_times: true } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(screen.getByLabelText(ru.day.startTime), "22:00");
    await waitFor(async () => expect((await onlyEntry()).start_time).toBe("22:00"));
    type(screen.getByLabelText(ru.day.endTime), "06:00");
    await waitFor(async () => expect((await onlyEntry()).end_time).toBe("06:00"));
    type(screen.getByLabelText(ru.day.breakMinutes), "30");
    await waitFor(async () => expect((await onlyEntry()).break_minutes).toBe(30));

    type(screen.getByLabelText(ru.day.breakMinutes), "");
    await waitFor(async () => expect((await onlyEntry()).break_minutes).toBeNull());
  });

  it("очищенное время времени пишется как null", async () => {
    renderDay({ settings: { show_shift_times: true } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(screen.getByLabelText(ru.day.startTime), "22:00");
    await waitFor(async () => expect((await onlyEntry()).start_time).toBe("22:00"));
    type(screen.getByLabelText(ru.day.startTime), "");
    await waitFor(async () => expect((await onlyEntry()).start_time).toBeNull());
  });

  it("очищенный конец смены пишется как null", async () => {
    renderDay({ settings: { show_shift_times: true } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(screen.getByLabelText(ru.day.endTime), "06:00");
    await waitFor(async () => expect((await onlyEntry()).end_time).toBe("06:00"));
    type(screen.getByLabelText(ru.day.endTime), "");
    await waitFor(async () => expect((await onlyEntry()).end_time).toBeNull());
  });

  it("недописанный перерыв не уезжает в базу как NaN", async () => {
    renderDay({ settings: { show_shift_times: true } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    type(screen.getByLabelText(ru.day.breakMinutes), "-");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await onlyEntry()).break_minutes).toBeNull();

    type(screen.getByLabelText(ru.day.breakMinutes), " ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await onlyEntry()).break_minutes).not.toBeNaN();
  });
});

describe("DayScreen — заметка и закрытие", () => {
  it("сохраняет заметку", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await onlyEntry();

    fireEvent.change(screen.getByPlaceholderText(ru.day.notePlaceholder), { target: { value: "переработка" } });
    await waitFor(async () => expect((await onlyEntry()).note).toBe("переработка"));
  });

  it("закрывает шторку", () => {
    const { onClose } = renderDay();
    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));
    expect(onClose).toHaveBeenCalled();
  });

  it("показывает уже сохранённую запись при открытии дня", async () => {
    await db.entries.add(makeEntry({ id: "e-1", hours: 6, multiplier: 2, rate_per_hour: 45, amount: 540 }));
    renderDay();

    await waitFor(() => expect(fields().hours).toHaveValue("6"));
    const current = fields();
    expect(current.multiplier).toHaveValue("2");
    expect(current.rate).toHaveValue("45");
    expect(current.amount).toHaveValue("540");
  });
});

describe("DayScreen — период закрывают во время правки", () => {
  it("отказ слоя данных не создаёт запись", async () => {
    // Экран мог быть отрисован до закрытия периода (в том числе с другого
    // устройства): createEntry возвращает null, и строки появиться не должно.
    await db.settings.add(makeSettings());
    await db.periods.add(makePeriod({ is_closed: true }));

    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await storedEntries()).toHaveLength(0);
  });

  it("отказ слоя данных не меняет уже сохранённую запись", async () => {
    await db.settings.add(makeSettings());
    await db.periods.add(makePeriod({ is_closed: true }));
    await db.entries.add(makeEntry({ id: "e-1" }));

    renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });
    type(fields().hours, "12");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await db.entries.get("e-1"))?.hours).toBe(8);
  });
});

describe("DayScreen — список записей закрытого дня", () => {
  it("печатает разбор строки для каждого режима оплаты", async () => {
    await db.entries.bulkAdd([
      makeEntry({ id: "e-1", created_at: "2026-08-01T10:00:00.000Z" }),
      makeEntry({ id: "e-2", created_at: "2026-08-01T11:00:00.000Z", day_type_id: "dt-unpaid", hours: 0, amount: 0 }),
      makeEntry({
        id: "e-3",
        created_at: "2026-08-01T12:00:00.000Z",
        day_type_id: "dt-fixed",
        hours: 8,
        amount: 150,
      }),
    ]);
    renderDay({ period: { is_closed: true } });

    const list = await screen.findByRole("list");
    expect(within(list).getByText(/8ч × 30.00/)).toBeInTheDocument();
    expect(within(list).getByText(new RegExp(ru.period.payModeUnpaid))).toBeInTheDocument();
    expect(within(list).getByText(new RegExp(ru.day.payModeFixedAmount))).toBeInTheDocument();
  });
});

describe("DayScreen — ряд типов дня (раздел 8.2)", () => {
  it("рисует значок каждого типа, а плюс уводит в создание типа дня", async () => {
    const { onCreateDayType } = renderDay();

    // Кружок окрашен цветом типа и несёт его значок — по нему тип и узнаётся
    // на ячейке календаря.
    const button = await screen.findByRole("button", { name: night.name });
    expect(button).toHaveTextContent(night.label);

    fireEvent.click(screen.getByRole("button", { name: ru.day.createDayType }));
    expect(onCreateDayType).toHaveBeenCalledTimes(1);
  });

  it("не показывает в выборе ни архивные, ни удалённые типы (инварианты 11 и 38)", async () => {
    const archived = makeDayType({ id: "dt-arch", name: "Архивный", is_archived: true, sort_order: 5 });
    const deleted = makeDayType({
      id: "dt-del",
      name: "Удалённый",
      deleted_at: "2026-08-01T00:00:00.000Z",
      sort_order: 6,
    });

    renderDay({ dayTypes: [hourly, archived, deleted] });

    await screen.findByRole("button", { name: hourly.name });
    expect(screen.queryByRole("button", { name: "Архивный" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалённый" })).toBeNull();
  });

  it("тип со своей ставкой не получает воскресный множитель и объясняет почему", async () => {
    // Раздел 6.2: у pinned-типа множителя нет вовсе. До блока 4 ветка была
    // недостижима, и такой тип получал 8 × 55 × 2 = 880 за воскресенье.
    const pinned = makeDayType({
      id: "dt-pinned",
      name: "Своя ставка",
      rate_mode: "pinned",
      default_rate: 55,
      default_multiplier: 2,
      sort_order: 7,
    });

    renderDay({
      date: SUNDAY,
      dayTypes: [pinned],
      settings: { weekend_multipliers: { saturday: 1.5, sunday: 2, holiday: 2.5 } },
    });

    fireEvent.click(await screen.findByRole("button", { name: pinned.name }));

    await waitFor(() => expect(fields().multiplier).toHaveValue("1"));
    expect(fields().rate).toHaveValue("55");
    expect(fields().amount).toHaveValue("440"); // 8 × 55, без ×2
    expect(screen.getByText(new RegExp(ru.day.multiplierSourcePinned))).toBeInTheDocument();
  });
});
