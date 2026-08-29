import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/db/db";
import { DayScreen } from "@/pages/DayScreen/DayScreen";
import { ru } from "@/i18n/ru";
import type { DayType, Entry, Period, Settings } from "@/types/models";
import { makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings, resetDb, USER_ID } from "@/test/factories";
import { calculatePeriodTotals, periodForDate } from "@/lib/calc/period";

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
  const onOpenHolidays = vi.fn();
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
      onOpenHolidays={onOpenHolidays}
    />,
  );
  return { onClose, onOpenPeriod, onEntryDeleted, onCreateDayType, onOpenHolidays, ...view };
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

/**
 * Нажимает «Сохранить» и дожидается, пока экран скажет, что сохранять больше
 * нечего. Раздел 8.2: запись уходит в базу только по кнопке, поэтому каждая
 * проверка сохранённой строки начинается отсюда.
 *
 * Сначала ждём ЭКРАН, и только потом читаем Dexie: обратный порядок в этом
 * репозитории уже дважды давал падения, которые видно лишь под нагрузкой.
 * Внутрь waitFor эту функцию звать нельзя — она сама ждёт.
 */
async function save() {
  const button = screen.queryByRole("button", { name: ru.day.save });
  if (!button) return;
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByRole("button", { name: ru.day.save })).not.toBeInTheDocument());
}

/** Ждёт, пока в базе окажется ровно одна запись, и отдаёт её. Ничего не сохраняет. */
async function onlyEntry(): Promise<Entry> {
  let row: Entry | undefined;
  await waitFor(async () => {
    const rows = await storedEntries();
    expect(rows).toHaveLength(1);
    row = rows[0];
  });
  return row!;
}

/** Сохранить и прочитать единственную запись — самая частая пара. */
async function savedEntry(): Promise<Entry> {
  await save();
  return onlyEntry();
}

beforeEach(async () => {
  await resetDb();
});

describe("DayScreen — создание записи", () => {
  it("тап по типу дня создаёт запись с его значениями по умолчанию", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));

    const entry = await savedEntry();
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

    const entry = await savedEntry();
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
    await savedEntry();

    fireEvent.click(screen.getByRole("button", { name: "+" }));
    expect((await savedEntry()).hours).toBe(8.5);
    expect((await savedEntry()).amount).toBe(255);

    const minus = screen.getByRole("button", { name: "−" });
    for (let i = 0; i < 20; i++) fireEvent.click(minus);
    expect((await savedEntry()).hours).toBe(0);
    expect((await savedEntry()).amount).toBe(0);
  });

  it("правка множителя не трогает ставку", async () => {
    // Прежняя связь «ставка = база × множитель» затирала вписанную руками
    // ставку при правке множителя (коммит dbccfb8).
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    type(fields().rate, "50");
    expect((await savedEntry()).rate_is_manual).toBe(true);

    type(fields().multiplier, "2");
    expect((await savedEntry()).multiplier).toBe(2);

    const entry = await savedEntry();
    expect(entry.rate_per_hour).toBe(50);
    expect(entry.rate_is_manual).toBe(true);
    expect(entry.amount).toBe(800);
  });

  it("правка ставки не выводит множитель и делает ставку ручной", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    await savedEntry();

    type(fields().rate, "40");

    expect((await savedEntry()).rate_per_hour).toBe(40);
    const entry = await savedEntry();
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
    await savedEntry();

    type(fields().rate, "50");
    expect((await savedEntry()).rate_per_hour).toBe(50);
    type(fields().multiplier, "2");

    expect((await savedEntry()).amount).toBe(800);
  });
});

describe("DayScreen — подпись источника множителя", () => {
  it.each([
    ["выходной день, суббота", SATURDAY, ru.day.multiplierSourceSaturday],
    ["воскресенье", SUNDAY, ru.day.multiplierSourceSunday],
  ])("%s", async (_name, date, label) => {
    renderDay({ date, settings: { weekend_multipliers: { saturday: 1.5, sunday: 2, holiday: 2.5 } } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    expect(await screen.findByText(new RegExp(`${label}, ×`))).toBeInTheDocument();
  });

  it("праздник перебивает выходной", async () => {
    // Праздники приезжают из Dexie отдельным запросом, уже после первого
    // черновика: предзаполненный множитель обязан обновиться сам, иначе на
    // праздник экран показывал бы воскресное правило до первого тапа.
    await db.holidays.add(makeHoliday({ date: SUNDAY }));
    renderDay({ date: SUNDAY, settings: { weekend_multipliers: { saturday: 1.5, sunday: 2, holiday: 2.5 } } });

    expect(await screen.findByText(new RegExp(`${ru.day.multiplierSourceHoliday}, ×`))).toBeInTheDocument();
    expect(fields().multiplier).toHaveValue("2.5");

    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    expect((await savedEntry()).multiplier).toBe(2.5);
  });

  it("тип дня со своим множителем подписан как тип дня", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    expect(await screen.findByText(new RegExp(`${ru.day.multiplierSourceDayType}, ×`))).toBeInTheDocument();
  });

  it("отпуск не получает воскресный множитель", async () => {
    // Раздел 5.3: отпуск в воскресенье не оплачивается вдвойне.
    renderDay({ date: SUNDAY, settings: { weekend_multipliers: { saturday: 1.5, sunday: 2, holiday: 2.5 } } });
    fireEvent.click(screen.getByRole("button", { name: "Отпуск" }));

    expect((await savedEntry()).multiplier).toBe(1);
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

    expect(await screen.findByText(new RegExp(`${ru.day.multiplierSourceDayType}, ×`))).toBeInTheDocument();
    expect((await savedEntry()).multiplier).toBe(0.8);
  });

  it("значение, заданное руками, подписано как ручное", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    type(fields().multiplier, "3");
    expect(await screen.findByText(new RegExp(`${ru.day.multiplierSourceManual}, ×`))).toBeInTheDocument();
  });
});

describe("DayScreen — режимы оплаты", () => {
  it("unpaid держит сумму на нуле и объясняет почему", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Отгул" }));

    expect((await savedEntry()).amount).toBe(0);
    expect(screen.getByText(ru.day.hintUnpaidDayType)).toBeInTheDocument();
    // Раздел 9: поля остаются доступными, а не блокируются.
    expect(fields().rate).not.toBeDisabled();
  });

  it("fixed_amount берёт сумму из типа дня", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Дежурство" }));

    expect((await savedEntry()).amount).toBe(150);
    expect(screen.getByText(ru.day.payModeFixedAmount)).toBeInTheDocument();
  });

  it("ручная сумма перебивает всё и возвращается к расчёту при выключении", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    fireEvent.click(screen.getByRole("switch"));
    expect((await savedEntry()).amount_override).toBe(240);

    type(fields().amount, "1000");
    expect((await savedEntry()).amount).toBe(1000);

    fireEvent.click(screen.getByRole("switch"));
    expect((await savedEntry()).amount_override).toBeNull();
    expect((await savedEntry()).amount).toBe(240);
  });

  it("отрицательная сумма сохраняется с мягким предупреждением", async () => {
    // Инвариант 24: это законный способ записать удержание.
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    fireEvent.click(screen.getByRole("switch"));
    expect((await savedEntry()).amount_override).toBe(240);
    type(fields().amount, "-500");

    expect((await savedEntry()).amount).toBe(-500);
    expect(screen.getByText(ru.day.hintNegativeAmount)).toBeInTheDocument();
  });
});

describe("DayScreen — подсказки", () => {
  it("больше 24 часов сохраняется и предупреждает", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    type(fields().hours, "26");
    expect((await savedEntry()).hours).toBe(26);
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
    await savedEntry();

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
    await savedEntry();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));

    expect((await savedEntry()).multiplier).toBe(1.5);
  });

  it("уже введённые значения переживают смену типа", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    type(fields().hours, "10");
    expect((await savedEntry()).hours).toBe(10);

    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    expect((await savedEntry()).day_type_id).toBe("dt-night");

    const entry = await savedEntry();
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
    // Раздел 8.2: пока не нажата кнопка, второй строки в базе нет — и полоски
    // тоже, показывать в ней нечего.
    expect(screen.queryByRole("button", { name: /^2\./ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ru.day.save }));
    expect(await screen.findByRole("button", { name: /^2\./ })).toBeInTheDocument();
  });

  it("сохранение сразу после сохранения правит ту же строку, а не заводит вторую", async () => {
    // Своя только что созданная запись приезжает из useLiveQuery с задержкой,
    // и всё это время экран не видит её в entries. Без привязки черновика к
    // созданному id второе сохранение создавало вторую запись за день.
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await save();

    type(fields().hours, "6");
    await save();

    const rows = await storedEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0].hours).toBe(6);
  });

  it("«добавить запись» не затирает первую запись дня", async () => {
    await db.entries.bulkAdd([
      makeEntry({ id: "e-1", created_at: "2026-08-01T10:00:00.000Z", hours: 12, amount: 360, note: "первая" }),
      makeEntry({ id: "e-2", created_at: "2026-08-01T11:00:00.000Z", hours: 4, amount: 120, note: "вторая" }),
    ]);
    renderDay();

    fireEvent.click(await screen.findByRole("button", { name: /^2\./ }));
    fireEvent.click(screen.getByRole("button", { name: ru.day.addEntry }));
    fireEvent.click(screen.getByRole("button", { name: "Отпуск" }));
    fireEvent.click(screen.getByRole("button", { name: ru.day.save }));

    await waitFor(async () => expect(await storedEntries()).toHaveLength(3));
    const rows = await storedEntries();
    expect(rows[0]).toMatchObject({ id: "e-1", hours: 12, amount: 360, note: "первая" });
    expect(rows[1]).toMatchObject({ id: "e-2", hours: 4, amount: 120, note: "вторая" });
    expect(rows[2].day_type_id).toBe("dt-vacation");
  });

  it("двойное нажатие «Сохранить» не создаёт две строки", async () => {
    // Пока запись уходила в Dexie, кнопка оставалась на месте: второй тап
    // успевал вызвать создание ещё раз, и день получал дубль. Тот же замок,
    // что на экранах праздников и прошлых периодов.
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    const button = screen.getByRole("button", { name: ru.day.save });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(async () => expect(await storedEntries()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await storedEntries()).toHaveLength(1);
  });

  it("«добавить запись» с несохранёнными правками сначала спрашивает", async () => {
    await db.entries.add(makeEntry({ id: "e-1", hours: 12, amount: 360 }));
    renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });

    type(fields().hours, "6");
    fireEvent.click(screen.getByRole("button", { name: ru.day.addEntry }));

    expect(await screen.findByText(ru.day.unsavedTitle)).toBeInTheDocument();
    // Новая строка не начата, пока человек не ответил.
    expect(await db.entries.count()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: ru.day.unsavedSave }));
    await waitFor(async () => expect((await db.entries.get("e-1"))?.hours).toBe(6));
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
    fireEvent.click(screen.getByRole("button", { name: ru.day.save }));

    await waitFor(async () => expect((await db.entries.get("e-2"))?.hours).toBe(6));
    expect((await db.entries.get("e-1"))?.hours).toBe(12);
  });

  it("переключение на другую запись с несохранёнными правками спрашивает", async () => {
    await db.entries.bulkAdd([
      makeEntry({ id: "e-1", created_at: "2026-08-01T10:00:00.000Z", hours: 12, amount: 360 }),
      makeEntry({ id: "e-2", created_at: "2026-08-01T11:00:00.000Z", hours: 4, amount: 120 }),
    ]);
    renderDay();

    await screen.findByRole("button", { name: /^1\./ });
    type(fields().hours, "9");
    fireEvent.click(screen.getByRole("button", { name: /^2\./ }));

    expect(await screen.findByText(ru.day.unsavedTitle)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ru.day.unsavedDiscard }));

    // Брошенные девять часов не должны уехать во вторую запись.
    await waitFor(() => expect(fields().hours).toHaveValue("4"));
    expect((await db.entries.get("e-1"))?.hours).toBe(12);
    expect((await db.entries.get("e-2"))?.hours).toBe(4);
  });
});

describe("DayScreen — сохранение по кнопке (раздел 8.2)", () => {
  it("правки не уходят в базу, пока кнопку не нажали", async () => {
    await db.entries.add(makeEntry({ id: "e-1", hours: 8, amount: 240 }));
    renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });

    type(fields().hours, "6");
    type(fields().rate, "50");

    // Экран уже показывает пересчитанную сумму, а база — прежнюю.
    expect(fields().amount).toHaveValue("300");
    const stored = await db.entries.get("e-1");
    expect(stored).toMatchObject({ hours: 8, amount: 240, rate_per_hour: 30 });
  });

  it("кнопка неактивна, пока сохранять нечего", async () => {
    await db.entries.add(makeEntry({ id: "e-1" }));
    renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });

    // «Сохранено» — это состояние, а не молчаливое бездействие: человек видит,
    // что всё записано.
    expect(screen.getByRole("button", { name: ru.day.saved })).toBeDisabled();

    type(fields().hours, "6");
    expect(screen.getByRole("button", { name: ru.day.save })).toBeEnabled();
  });

  it("открыть день и закрыть, ничего не тронув, — ни вопроса, ни записи", async () => {
    const { onClose } = renderDay();

    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText(ru.day.unsavedTitle)).not.toBeInTheDocument();
    expect(await db.entries.count()).toBe(0);
  });

  it("закрытие с несохранёнными правками спрашивает и не закрывает само", async () => {
    await db.entries.add(makeEntry({ id: "e-1", hours: 8 }));
    const { onClose } = renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });

    type(fields().hours, "6");
    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));

    expect(await screen.findByText(ru.day.unsavedTitle)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("«не сохранять» закрывает и оставляет базу нетронутой", async () => {
    await db.entries.add(makeEntry({ id: "e-1", hours: 8, amount: 240 }));
    const { onClose } = renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });

    type(fields().hours, "6");
    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));
    fireEvent.click(await screen.findByRole("button", { name: ru.day.unsavedDiscard }));

    expect(onClose).toHaveBeenCalled();
    expect((await db.entries.get("e-1"))?.hours).toBe(8);
  });

  it("«сохранить изменения» записывает и только потом закрывает", async () => {
    await db.entries.add(makeEntry({ id: "e-1", hours: 8, amount: 240 }));
    const { onClose } = renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });

    type(fields().hours, "6");
    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));
    fireEvent.click(await screen.findByRole("button", { name: ru.day.unsavedSave }));

    await waitFor(async () => expect((await db.entries.get("e-1"))?.hours).toBe(6));
    expect(onClose).toHaveBeenCalled();
  });

  it("«сохранить» и сразу «закрыть» не теряет закрытие", async () => {
    // Пока запись шла в Dexie, второй вызов упирался в замок и отвечал
    // отказом: человек отвечал на вопрос «сохранить изменения», а шторка
    // молча оставалась на месте.
    await db.entries.add(makeEntry({ id: "e-1", hours: 8, amount: 240 }));
    const { onClose } = renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });

    type(fields().hours, "6");
    fireEvent.click(screen.getByRole("button", { name: ru.day.save }));
    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));

    const dialogSave = screen.queryByRole("button", { name: ru.day.unsavedSave });
    if (dialogSave) fireEvent.click(dialogSave);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await waitFor(async () => expect((await db.entries.get("e-1"))?.hours).toBe(6));
    expect(await storedEntries()).toHaveLength(1);
  });

  it("тап мимо окна оставляет человека в дне, ничего не выбрасывая", async () => {
    await db.entries.add(makeEntry({ id: "e-1", hours: 8 }));
    const { onClose } = renderDay();
    await screen.findByRole("button", { name: ru.day.deleteEntry });

    type(fields().hours, "6");
    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));
    fireEvent.click(await screen.findByText(ru.day.unsavedBody), undefined);
    // Клик по самому окну ничего не закрывает; закрывает клик по фону.
    expect(screen.getByText(ru.day.unsavedTitle)).toBeInTheDocument();

    fireEvent.click(document.querySelector(".day-sheet-overlay")!);

    await waitFor(() => expect(screen.queryByText(ru.day.unsavedTitle)).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    // Набранное осталось на экране: случайный тап мимо не стоит смены.
    expect(fields().hours).toHaveValue("6");
  });

  it("новая запись не создаётся, если её бросить", async () => {
    const { onClose } = renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));

    fireEvent.click(screen.getByRole("button", { name: ru.day.close }));
    fireEvent.click(await screen.findByRole("button", { name: ru.day.unsavedDiscard }));

    expect(onClose).toHaveBeenCalled();
    expect(await db.entries.count()).toBe(0);
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
    await savedEntry();

    type(screen.getByLabelText(ru.day.startTime), "22:00");
    expect((await savedEntry()).start_time).toBe("22:00");
    type(screen.getByLabelText(ru.day.endTime), "06:00");
    expect((await savedEntry()).end_time).toBe("06:00");
    type(screen.getByLabelText(ru.day.breakMinutes), "30");
    expect((await savedEntry()).break_minutes).toBe(30);

    type(screen.getByLabelText(ru.day.breakMinutes), "");
    expect((await savedEntry()).break_minutes).toBeNull();
  });

  it("очищенное время времени пишется как null", async () => {
    renderDay({ settings: { show_shift_times: true } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    type(screen.getByLabelText(ru.day.startTime), "22:00");
    expect((await savedEntry()).start_time).toBe("22:00");
    type(screen.getByLabelText(ru.day.startTime), "");
    expect((await savedEntry()).start_time).toBeNull();
  });

  it("очищенный конец смены пишется как null", async () => {
    renderDay({ settings: { show_shift_times: true } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    type(screen.getByLabelText(ru.day.endTime), "06:00");
    expect((await savedEntry()).end_time).toBe("06:00");
    type(screen.getByLabelText(ru.day.endTime), "");
    expect((await savedEntry()).end_time).toBeNull();
  });

  it("недописанный перерыв не уезжает в базу как NaN", async () => {
    renderDay({ settings: { show_shift_times: true } });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    type(screen.getByLabelText(ru.day.breakMinutes), "-");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await savedEntry()).break_minutes).toBeNull();

    type(screen.getByLabelText(ru.day.breakMinutes), " ");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await savedEntry()).break_minutes).not.toBeNaN();
  });
});

describe("DayScreen — длительность из времён (раздел 6.1)", () => {
  /** Раскрывает блок времени смены — до блока 7 это единственный путь к нему. */
  function openShiftTimes() {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.day.shiftTimesShow) }));
  }

  it("блок времени раскрывается из самой шторки, без настройки", async () => {
    // settings.show_shift_times = false по умолчанию, и включить его до блока 7
    // не может никто. Без этой кнопки раздел 6.1 был бы невидим на телефоне.
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    expect(screen.queryByLabelText(ru.day.startTime)).not.toBeInTheDocument();

    openShiftTimes();
    expect(screen.getByLabelText(ru.day.startTime)).toBeInTheDocument();
  });

  it("начало и конец задают часы и сумму", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();

    // 8.5 часа, а не 8: значение по умолчанию типа дня равно восьми, и на нём
    // тест прошёл бы даже без вывода длительности вовсе.
    type(screen.getByLabelText(ru.day.startTime), "09:00");
    type(screen.getByLabelText(ru.day.endTime), "17:30");

    const entry = await savedEntry();
    expect(entry.hours).toBe(8.5);
    expect(entry.amount).toBe(255);
    expect(entry.duration_is_manual).toBe(false);
  });

  it("перерыв вычитается из смены", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();

    type(screen.getByLabelText(ru.day.startTime), "08:00");
    type(screen.getByLabelText(ru.day.endTime), "16:00");
    type(screen.getByLabelText(ru.day.breakMinutes), "30");

    const entry = await savedEntry();
    expect(entry.hours).toBe(7.5);
    expect(entry.amount).toBe(225);
  });

  it("инвариант 28: смена через полночь — восемь часов, а не минус шестнадцать", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();

    // Девять часов, а не восемь: на восьми тест совпал бы со значением по
    // умолчанию типа дня и прошёл бы без всякого перехода через полночь.
    type(screen.getByLabelText(ru.day.startTime), "22:00");
    type(screen.getByLabelText(ru.day.endTime), "07:00");

    const entry = await savedEntry();
    expect(entry.hours).toBe(9);
    expect(entry.amount).toBe(270);
  });

  it("инвариант 28: одинаковые времена дают полные сутки", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();

    type(screen.getByLabelText(ru.day.startTime), "08:00");
    type(screen.getByLabelText(ru.day.endTime), "08:00");

    const entry = await savedEntry();
    expect(entry.hours).toBe(24);
    expect(entry.amount).toBe(720);
  });

  it("7ч20м сохраняются суммой до гроша, а в поле показываются как 7.33", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();

    type(screen.getByLabelText(ru.day.startTime), "08:00");
    type(screen.getByLabelText(ru.day.endTime), "15:20");

    // Сначала экран: округлённое число видно человеку, но в базу не уходит
    // (инвариант 20).
    expect(fields().hours).toHaveValue("7.33");

    const entry = await savedEntry();
    expect(entry.hours).toBe(440 / 60);
    // 7.33 × 30 дало бы 219.90 — те самые десять грошей.
    expect(entry.amount).toBe(220);
  });

  it("инвариант 30: перерыв длиннее смены даёт ноль часов, предупреждает и сохраняется", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();

    type(screen.getByLabelText(ru.day.startTime), "08:00");
    type(screen.getByLabelText(ru.day.endTime), "16:00");
    type(screen.getByLabelText(ru.day.breakMinutes), "600");

    expect(screen.getByText(ru.day.hintBreakExceedsShift)).toBeVisible();

    const entry = await savedEntry();
    expect(entry.hours).toBe(0);
    expect(entry.amount).toBe(0);
  });

  it("инвариант 32: смена длиннее суток сохраняется с мягким предупреждением", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();

    type(screen.getByLabelText(ru.day.startTime), "08:00");
    type(screen.getByLabelText(ru.day.endTime), "08:00");
    type(screen.getByLabelText(ru.day.breakMinutes), "-120");

    expect(screen.getByText(ru.day.hintManyHours)).toBeVisible();

    const entry = await savedEntry();
    expect(entry.hours).toBe(26);
  });

  it("очищенный конец смены возвращает часы к значению по умолчанию типа дня", async () => {
    // Раздел 6.1, ветка «иначе»: без пары времён выводить не из чего.
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();

    type(screen.getByLabelText(ru.day.startTime), "08:00");
    type(screen.getByLabelText(ru.day.endTime), "16:30");
    expect(fields().hours).toHaveValue("8.5");

    type(screen.getByLabelText(ru.day.endTime), "");
    expect(fields().hours).toHaveValue("8");

    const entry = await savedEntry();
    expect(entry.hours).toBe(8);
    expect(entry.end_time).toBeNull();
  });
});

describe("DayScreen — связь длительности с временами (раздел 8.2)", () => {
  function openShiftTimes() {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.day.shiftTimesShow) }));
  }

  async function withTimes() {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();
    // 8.5 часа: отличается от default_hours типа дня (8), иначе «связь живая»
    // нельзя отличить от «связи нет вовсе».
    type(screen.getByLabelText(ru.day.startTime), "09:00");
    type(screen.getByLabelText(ru.day.endTime), "17:30");
    await waitFor(() => expect(fields().hours).toHaveValue("8.5"));
  }

  it("правка часов руками рвёт связь, и времена больше её не двигают", async () => {
    await withTimes();
    expect(screen.getByText(ru.day.durationDerived)).toBeVisible();

    // Пока связь жива, перерыв двигает часы — иначе следующая половина теста
    // не отличала бы разрыв связи от отсутствия вывода вовсе.
    type(screen.getByLabelText(ru.day.breakMinutes), "30");
    expect(fields().hours).toHaveValue("8");
    type(screen.getByLabelText(ru.day.breakMinutes), "");

    type(fields().hours, "5");
    expect(screen.getByText(ru.day.durationManual)).toBeVisible();

    // Время меняется, часы — нет: связь разорвана.
    type(screen.getByLabelText(ru.day.breakMinutes), "30");
    expect(fields().hours).toHaveValue("5");

    const entry = await savedEntry();
    expect(entry.duration_is_manual).toBe(true);
    expect(entry.hours).toBe(5);
    expect(entry.break_minutes).toBe(30);
    expect(entry.amount).toBe(150);
  });

  it("кнопка «считать по времени» возвращает связь и пересчитывает сумму", async () => {
    await withTimes();
    type(fields().hours, "5");
    type(screen.getByLabelText(ru.day.breakMinutes), "30");
    expect(fields().hours).toHaveValue("5");

    fireEvent.click(screen.getByRole("button", { name: ru.day.durationRestoreLink }));
    expect(fields().hours).toHaveValue("8");

    const entry = await savedEntry();
    expect(entry.duration_is_manual).toBe(false);
    expect(entry.hours).toBe(8);
    expect(entry.amount).toBe(240);
  });

  it("без времён кнопки восстановления нет — восстанавливать нечего", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    openShiftTimes();
    type(fields().hours, "5");

    expect(screen.queryByRole("button", { name: ru.day.durationRestoreLink })).not.toBeInTheDocument();
    expect(screen.queryByText(ru.day.durationManual)).not.toBeInTheDocument();
  });

  it("запись с разорванной связью не пересчитывается при открытии дня", async () => {
    // Ровно то, что делает миграция version(8) со всеми существующими днями:
    // времена заполнены, часы вписаны руками, и открытие дня не двигает деньги.
    await db.entries.add(
      makeEntry({
        hours: 8,
        amount: 240,
        start_time: "08:00",
        end_time: "16:00",
        break_minutes: 30,
        duration_is_manual: true,
      }),
    );
    renderDay();

    // Блок времени раскрывается сам: спрятанное начало смены объясняло бы часы
    // молча (инвариант 55).
    expect(await screen.findByLabelText(ru.day.startTime)).toHaveValue("08:00");
    expect(fields().hours).toHaveValue("8");
    expect(screen.getByText(ru.day.durationManual)).toBeVisible();

    const entry = await onlyEntry();
    expect(entry.hours).toBe(8);
    expect(entry.amount).toBe(240);
  });

  it("смена типа дня не рвёт живую связь и сохраняет разорванную", async () => {
    await withTimes();
    // Живая связь: часы остаются выведенными из времён, а не откатываются к
    // default_hours нового типа.
    fireEvent.click(screen.getByRole("button", { name: "Ночная смена" }));
    expect(fields().hours).toHaveValue("8.5");
    expect(screen.getByText(ru.day.durationDerived)).toBeVisible();

    // Разорванная связь переживает смену типа: вписанные 5 часов не заменяются
    // ни выводом из времён, ни значением по умолчанию типа (8).
    type(fields().hours, "5");
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    expect(fields().hours).toHaveValue("5");

    const entry = await savedEntry();
    expect(entry.hours).toBe(5);
    expect(entry.duration_is_manual).toBe(true);
  });

  it("смена типа до первой правки берёт часы нового типа и оставляет связь живой", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Отгул" }));
    expect(fields().hours).toHaveValue("0");

    const entry = await savedEntry();
    expect(entry.hours).toBe(0);
    expect(entry.duration_is_manual).toBe(false);
  });
});

describe("DayScreen — ночная смена на границе периодов (инвариант 29)", () => {
  it("смена с 31 августа 22:00 по 1 сентября 06:00 целиком принадлежит августу", async () => {
    // Инвариант 29: часы и деньги никогда не делятся между периодами. Период
    // записи решает её поле date, а вывод длительности (раздел 6.1) дат не
    // касается вовсе.
    const SEPTEMBER_ENTRY = makeEntry({
      id: "e-september",
      date: "2026-09-01",
      hours: 8,
      amount: 240,
      duration_is_manual: true,
    });
    await db.entries.add(SEPTEMBER_ENTRY);

    const september = makePeriod({ id: "p-2026-09", year: 2026, month: 9 });
    const totalsFor = async (year: number, month: number) => {
      const rows = (await db.entries.where("user_id").equals(USER_ID).toArray()).filter(
        (row) =>
          row.deleted_at === null &&
          periodForDate(
            new Date(Number(row.date.slice(0, 4)), Number(row.date.slice(5, 7)) - 1, Number(row.date.slice(8, 10))),
            1,
          ).year === year &&
          periodForDate(
            new Date(Number(row.date.slice(0, 4)), Number(row.date.slice(5, 7)) - 1, Number(row.date.slice(8, 10))),
            1,
          ).month === month,
      );
      return calculatePeriodTotals(september, rows, new Map([["dt-hourly", hourly]]));
    };

    const septemberBefore = await totalsFor(2026, 9);
    expect(septemberBefore.amount).toBe(240);
    expect(septemberBefore.total_hours).toBe(8);

    renderDay({ date: "2026-08-31" });
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.day.shiftTimesShow) }));
    type(screen.getByLabelText(ru.day.startTime), "22:00");
    type(screen.getByLabelText(ru.day.endTime), "07:00");
    await save();

    // Смена целиком в августе: дата записи не сдвинулась ни на день.
    await waitFor(async () => {
      const august = (await db.entries.where("date").equals("2026-08-31").toArray()).filter(
        (row) => row.deleted_at === null,
      );
      expect(august).toHaveLength(1);
      expect(august[0].hours).toBe(9);
      expect(august[0].amount).toBe(270);
    });

    // Сентябрь не изменился ни на грош и ни на час.
    const septemberAfter = await totalsFor(2026, 9);
    expect(septemberAfter).toEqual(septemberBefore);
    expect(await db.entries.where("date").equals("2026-09-01").count()).toBe(1);
    expect((await db.entries.get("e-september"))).toEqual(SEPTEMBER_ENTRY);
  });
});

describe("DayScreen — вывод длительности и снимки (инварианты 8 и 9)", () => {
  function openShiftTimes() {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(ru.day.shiftTimesShow) }));
  }

  it("инвариант 8: ручная сумма не двигается от вывода длительности", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    fireEvent.click(screen.getByRole("switch"));
    type(fields().amount, "500");

    openShiftTimes();
    type(screen.getByLabelText(ru.day.startTime), "08:00");
    type(screen.getByLabelText(ru.day.endTime), "12:00");

    // Часы — это факт о смене, и они меняются. Деньги — нет.
    expect(fields().hours).toHaveValue("4");

    const entry = await savedEntry();
    expect(entry.hours).toBe(4);
    expect(entry.amount_override).toBe(500);
    expect(entry.amount).toBe(500);
  });

  it("инвариант 9: ручная ставка переживает вывод длительности", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    type(fields().rate, "50");

    openShiftTimes();
    type(screen.getByLabelText(ru.day.startTime), "08:00");
    type(screen.getByLabelText(ru.day.endTime), "14:00");

    const entry = await savedEntry();
    expect(entry.rate_per_hour).toBe(50);
    expect(entry.rate_is_manual).toBe(true);
    expect(entry.rate_source).toBe("manual");
    expect(entry.hours).toBe(6);
    expect(entry.amount).toBe(300);
  });
});

describe("DayScreen — заметка и закрытие", () => {
  it("сохраняет заметку", async () => {
    renderDay();
    fireEvent.click(screen.getByRole("button", { name: "Рабочий день" }));
    await savedEntry();

    fireEvent.change(screen.getByPlaceholderText(ru.day.notePlaceholder), { target: { value: "переработка" } });
    expect((await savedEntry()).note).toBe("переработка");
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

  it("показывает заметку выбранного типа: title на телефоне не существует (раздел 5.3)", async () => {
    const described = makeDayType({ id: "dt-note", name: "С заметкой", note: "Смена у второго клиента", sort_order: 9 });

    renderDay({ dayTypes: [hourly, described] });

    fireEvent.click(await screen.findByRole("button", { name: described.name }));

    expect(await screen.findByText("Смена у второго клиента")).toBeInTheDocument();
  });

  it("переход на тип со своей ставкой после правки берёт его ставку, а не прежние деньги", async () => {
    // Ветка «пользователь уже вводил значения» переносит введённое на новый
    // тип. Для замка это неверно в обе стороны: он не пользовательский ввод, а
    // правило типа дня (раздел 5.3.1). Без исключения тап по «своей ставке»
    // после правки часов давал 6 × 30 × 2 = 360 вместо 6 × 55 = 330.
    const pinned = makeDayType({
      id: "dt-pinned",
      name: "Своя ставка",
      rate_mode: "pinned",
      default_rate: 55,
      sort_order: 8,
    });

    renderDay({
      date: SUNDAY,
      dayTypes: [hourly, pinned],
      settings: { weekend_multipliers: { saturday: 1.5, sunday: 2, holiday: 2.5 } },
    });

    // Правим часы — это и включает ветку переноса значений.
    type(fields().hours, "6");
    await waitFor(() => expect(fields().hours).toHaveValue("6"));

    fireEvent.click(screen.getByRole("button", { name: pinned.name }));

    await waitFor(() => expect(fields().rate).toHaveValue("55"));
    expect(fields().multiplier).toHaveValue("1");
    expect(fields().amount).toHaveValue("330"); // 6 × 55
    expect(fields().hours).toHaveValue("6"); // введённое пользователем сохранено
  });

  it("переход С типа со своей ставкой возвращает запись к базовой ставке периода", async () => {
    const pinned = makeDayType({
      id: "dt-pinned",
      name: "Своя ставка",
      rate_mode: "pinned",
      default_rate: 55,
      sort_order: 8,
    });

    renderDay({ dayTypes: [pinned, hourly] });

    fireEvent.click(await screen.findByRole("button", { name: pinned.name }));
    await waitFor(() => expect(fields().rate).toHaveValue("55"));

    type(fields().hours, "6");
    await waitFor(() => expect(fields().hours).toHaveValue("6"));

    fireEvent.click(screen.getByRole("button", { name: hourly.name }));

    // 55 zł/h принадлежала прежнему типу дня. Остаться она не может: как
    // ручная ставка она пережила бы даже смену базовой ставки периода.
    //
    // Ждём именно базу, а не поле: persist() вызывает setDraft синхронно, ДО
    // записи в Dexie, поэтому поле показывает 30 в тот момент, когда в строке
    // ещё лежат прежние деньги. Проверка поля с последующим чтением базы
    // проходила бы на быстрой машине и падала под нагрузкой.
    await waitFor(async () => {
      const stored = await savedEntry();
      expect(stored.rate_is_manual).toBe(false);
      expect(stored.rate_source).toBe("period_base");
      expect(stored.amount).toBe(180); // 6 × 30
      expect(stored.rate_per_hour).toBe(30);
    });
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

describe("DayScreen — вход в экран праздников (раздел 8.6)", () => {
  it("на непраздничном дне предлагает отметить праздником и передаёт дату", async () => {
    const { onOpenHolidays } = renderDay();

    const row = await screen.findByText(ru.day.holidayRowNone);
    fireEvent.click(row);
    expect(onOpenHolidays).toHaveBeenCalledWith({ addDate: DATE });
  });

  it("на празднике показывает его название и ведёт в список без даты", async () => {
    await db.holidays.add(makeHoliday({ date: DATE, name: "Успение Пресвятой Богородицы" }));
    const { onOpenHolidays } = renderDay();

    const row = await screen.findByText(/Успение Пресвятой Богородицы/);
    fireEvent.click(row);
    expect(onOpenHolidays).toHaveBeenCalledWith({});
  });

  it("инвариант 53: из двух праздников на дате подписывает самый ранний по created_at", async () => {
    // Идентификаторы намеренно идут против created_at: раньше экран брал
    // .first() по индексу date, то есть строку с меньшим id, и на этой паре
    // назвал бы «День фирмы».
    await db.holidays.bulkAdd([
      makeHoliday({ id: "a-late", date: DATE, name: "День фирмы", created_at: "2026-03-01T00:00:00.000Z" }),
      makeHoliday({ id: "z-early", date: DATE, name: "Успение", created_at: "2026-01-01T00:00:00.000Z" }),
    ]);
    renderDay();

    expect(await screen.findByText(/Успение/)).toBeInTheDocument();
    expect(screen.queryByText(/День фирмы/)).not.toBeInTheDocument();
  });
});
