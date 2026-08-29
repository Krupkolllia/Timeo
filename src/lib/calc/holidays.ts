import type { Holiday } from "@/types/models";
import { easterSunday } from "@/lib/calc/easter";
import { toISODate } from "@/lib/calc/calendarGrid";

export interface HolidayPreset {
  /** Локальная календарная дата YYYY-MM-DD (инвариант 27). */
  date: string;
  name: string;
}

/** Девять неподвижных польских государственных праздников (раздел 5.5). */
const FIXED: ReadonlyArray<{ month: number; day: number; name: string }> = [
  { month: 1, day: 1, name: "Новый год" },
  { month: 1, day: 6, name: "Богоявление" },
  { month: 5, day: 1, name: "Праздник труда" },
  { month: 5, day: 3, name: "День Конституции 3 мая" },
  { month: 8, day: 15, name: "Успение Пресвятой Богородицы" },
  { month: 11, day: 1, name: "День всех святых" },
  { month: 11, day: 11, name: "День независимости" },
  { month: 12, day: 25, name: "Рождество" },
  { month: 12, day: 26, name: "Второй день Рождества" },
];

/** Четыре подвижных праздника — смещения в днях от пасхального воскресенья. */
const MOVABLE: ReadonlyArray<{ offset: number; name: string }> = [
  { offset: 0, name: "Пасха" },
  { offset: 1, name: "Пасхальный понедельник" },
  { offset: 49, name: "Пятидесятница" },
  { offset: 60, name: "Праздник Тела Христова" },
];

function isoFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Все польские государственные праздники года, отсортированные по дате.
 *
 * Дни к Пасхе прибавляются локальным Date и тут же разбираются обратно
 * методами getFullYear/getMonth/getDate: ни одно значение не проходит через
 * UTC (инвариант 27). Високосный год отдельной обработки не требует —
 * setDate/конструктор Date считают его сами (инвариант 34).
 */
export function polishHolidaysForYear(year: number): HolidayPreset[] {
  const easter = easterSunday(year);

  const movable = MOVABLE.map(({ offset, name }) => {
    const date = new Date(year, easter.month - 1, easter.day + offset);
    return { date: toISODate(date), name };
  });

  const fixed = FIXED.map(({ month, day, name }) => ({ date: isoFromParts(year, month, day), name }));

  return [...fixed, ...movable].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Инвариант 53 (в редакции блока 5): на одну дату допускается несколько
 * праздников, множитель и имя даёт самый ранний по created_at, при равенстве —
 * по id.
 *
 * Порядок обязан быть детерминированным на уровне данных, а не на уровне
 * запроса: Dexie не гарантирует порядок строк внутри одного значения индекса
 * date, и до этой функции два места отвечали на один и тот же вопрос
 * по-разному — экран дня брал .first(), а планировщик раздела 6.7 строил Map,
 * где побеждала ПОСЛЕДНЯЯ строка. Множитель у всех праздников один и тот же
 * (weekend_multipliers.holiday), поэтому расходились они не в деньгах, а в
 * показанном имени — но расходились молча.
 */
export function compareHolidays(a: Holiday, b: Holiday): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Какой из праздников одной даты определяет множитель и подпись. */
export function pickHoliday(holidays: readonly Holiday[]): Holiday | undefined {
  let best: Holiday | undefined;
  for (const holiday of holidays) {
    if (!best || compareHolidays(holiday, best) < 0) best = holiday;
  }
  return best;
}

/**
 * Дата → праздник, определяющий её множитель. Внутри одной даты побеждает тот
 * же, кого выбрал бы pickHoliday, — это и есть общий ответ для всех вызывающих.
 */
export function buildHolidayByDate(holidays: readonly Holiday[]): Map<string, Holiday> {
  const byDate = new Map<string, Holiday>();
  for (const holiday of holidays) {
    const current = byDate.get(holiday.date);
    if (!current || compareHolidays(holiday, current) < 0) byDate.set(holiday.date, holiday);
  }
  return byDate;
}
