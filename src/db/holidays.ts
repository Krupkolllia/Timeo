import type { TimeoDB } from "@/db/schema";
import type { Holiday } from "@/types/models";
import { polishHolidaysForYear } from "@/lib/calc/holidays";

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Сколько лет вперёд засеваются праздники при каждом запуске. Два года —
 * текущий и следующий: одного мало (в январе следующий год оказался бы пустым
 * ровно тогда, когда праздников больше всего), а широкий диапазон — это сотни
 * строк, которых пользователь не просил и через которые ему листать.
 *
 * Прошлые годы не засеваются намеренно. По инварианту 51 праздник, добавленный
 * над существующей записью, не меняет в ней ни числа, поэтому засев назад дал
 * бы только длину списка. Нужную дату задним числом всегда можно добавить
 * руками.
 */
const SEED_YEARS_AHEAD = 1;

/**
 * Раздел 5.5: польские государственные праздники засеваются и полностью
 * редактируются.
 *
 * Единица посева — ГОД, отмеченный в settings.seeded_holiday_years. Отсюда два
 * свойства, ради которых всё и сделано:
 *
 *  - идемпотентность: повторный вызов не находит незасеянных лет и не пишет
 *    ничего;
 *  - удалённое остаётся удалённым: год из списка не засевается никогда больше,
 *    поэтому стёртый пользователем праздник не воскресает при следующем
 *    запуске (CLAUDE.md — удаление только мягкое, и отменять его должен
 *    человек, а не приложение).
 *
 * Транзакция rw делает «прочитать список лет → вставить → отметить»
 * атомарным: без неё двойной вызов эффекта в React StrictMode увидел бы
 * одинаковый список лет дважды и задвоил бы каждую строку — ровно та причина,
 * по которой транзакция стоит в ensureDayTypesSeeded.
 */
export async function ensureHolidaysSeeded(db: TimeoDB, userId: string, today = new Date()): Promise<number> {
  const currentYear = today.getFullYear();
  const wanted: number[] = [];
  for (let offset = 0; offset <= SEED_YEARS_AHEAD; offset++) wanted.push(currentYear + offset);

  return db.transaction("rw", db.settings, db.holidays, async () => {
    const settings = await db.settings.where("user_id").equals(userId).first();
    // Настроек ещё нет — отметить посев негде, а посеять без отметки значит
    // засеять ещё раз при следующем запуске. bootstrapUser вызывает
    // ensureSettings раньше, так что до сюда это не доходит.
    if (!settings) return 0;

    const seeded = new Set(settings.seeded_holiday_years ?? []);
    const missing = wanted.filter((year) => !seeded.has(year));
    if (missing.length === 0) return 0;

    const now = nowISO();
    const rows: Holiday[] = missing.flatMap((year) =>
      polishHolidaysForYear(year).map((preset) => ({
        id: crypto.randomUUID(),
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        date: preset.date,
        name: preset.name,
        is_custom: false,
      })),
    );

    await db.holidays.bulkAdd(rows);
    await db.settings.update(settings.id, {
      seeded_holiday_years: [...(settings.seeded_holiday_years ?? []), ...missing].sort((a, b) => a - b),
      updated_at: now,
    });
    return rows.length;
  });
}

/**
 * Праздники пользователя, кроме мягко удалённых (инвариант 38). Порядок — по
 * дате, внутри одной даты по инварианту 53 (самый ранний по created_at, при
 * равенстве по id): экран группирует список по годам, и две строки одного дня
 * не должны меняться местами между перечитываниями.
 */
export function listHolidays(db: TimeoDB, userId: string): Promise<Holiday[]> {
  return db.holidays
    .where("user_id")
    .equals(userId)
    .filter((holiday) => holiday.deleted_at === null)
    .toArray()
    .then((rows) =>
      rows.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }),
    );
}

export interface HolidayDraft {
  date: string;
  name: string;
}

/**
 * Раздел 9 и инвариант 56: ввод ничем не блокируется. Пустое имя, дата в
 * прошлом, второй праздник на ту же дату — всё сохраняется как есть.
 */
export async function createHoliday(db: TimeoDB, userId: string, draft: HolidayDraft): Promise<Holiday> {
  const now = nowISO();
  const holiday: Holiday = {
    id: crypto.randomUUID(),
    user_id: userId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    date: draft.date,
    name: draft.name,
    // Всё, что создано на экране, — пользовательское: посев ставит false сам.
    is_custom: true,
  };
  await db.holidays.add(holiday);
  return holiday;
}

/**
 * Мягкое удаление (CLAUDE.md: необратимо не удаляем ничего) плюс окно отмены на
 * экране. Ни одна существующая запись при этом не пересчитывается — инвариант
 * 51: правка списка праздников влияет только на множитель, ПРЕДЛАГАЕМЫЙ новым
 * записям. Здесь не открывается даже таблица entries.
 */
export async function softDeleteHoliday(db: TimeoDB, id: string): Promise<void> {
  const now = nowISO();
  await db.holidays.update(id, { deleted_at: now, updated_at: now });
}

export async function restoreHoliday(db: TimeoDB, id: string): Promise<void> {
  await db.holidays.update(id, { deleted_at: null, updated_at: nowISO() });
}
