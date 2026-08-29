import type { TimeoDB } from "@/db/schema";
import type { BaseRecord, DayType, Entry, Holiday, Settings } from "@/types/models";
import { getPeriodDateRange } from "@/lib/calc/period";
import { toISODate } from "@/lib/calc/calendarGrid";
import { planDayTypeChange } from "@/lib/calc/dayTypeChange";

type PresetDayType = Pick<
  DayType,
  | "name"
  | "color"
  | "label"
  | "note"
  | "pay_mode"
  | "rate_mode"
  | "fixed_amount"
  | "counts_as_work"
  | "counts_toward_norm"
  | "default_hours"
  | "default_multiplier"
  | "default_rate"
  | "ignore_auto_multipliers"
  | "sort_order"
>;

// Section 5.3 of the spec. ignore_auto_multipliers=true for vacation/sick leave/day off —
// otherwise a day-off that falls on vacation would suddenly get paid at the day-off multiplier.
export const PRESET_DAY_TYPES: PresetDayType[] = [
  {
    name: "Рабочий день",
    color: "#38bdf8",
    label: "Р",
    note: "Обычная смена по базовой ставке периода",
    rate_mode: "multiplier",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 0,
  },
  {
    name: "Ночная смена",
    color: "#818cf8",
    label: "Н",
    note: "Смена с повышенным множителем",
    rate_mode: "multiplier",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1.5,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 1,
  },
  {
    name: "Отпуск",
    color: "#4ade80",
    label: "Отп",
    note: "Оплачивается, но не считается рабочими часами",
    rate_mode: "multiplier",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: false,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: true,
    sort_order: 2,
  },
  {
    name: "Больничный",
    color: "#fb923c",
    label: "Б",
    note: "Оплачивается, но не считается рабочими часами",
    rate_mode: "multiplier",
    pay_mode: "hourly",
    fixed_amount: null,
    counts_as_work: false,
    counts_toward_norm: true,
    default_hours: 8,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: true,
    sort_order: 3,
  },
  {
    name: "Отгул",
    color: "#a3a3a3",
    label: "Отг",
    note: "День без оплаты и без учёта в норме",
    rate_mode: "multiplier",
    pay_mode: "unpaid",
    fixed_amount: null,
    counts_as_work: false,
    counts_toward_norm: false,
    default_hours: 0,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: true,
    sort_order: 4,
  },
  {
    name: "Выходной",
    color: "#f87171",
    label: "В",
    note: "День без оплаты и без учёта в норме",
    rate_mode: "multiplier",
    pay_mode: "unpaid",
    fixed_amount: null,
    counts_as_work: false,
    counts_toward_norm: false,
    default_hours: 0,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 5,
  },
];

export async function ensureDayTypesSeeded(db: TimeoDB, userId: string): Promise<void> {
  // The rw transaction makes check-then-insert atomic: without it, two parallel
  // calls (e.g. a double effect invocation in React StrictMode) would both see
  // an empty table and each would seed its own set of presets — duplicates.
  return db.transaction("rw", db.day_types, async () => {
    const existing = await db.day_types.where("user_id").equals(userId).count();
    if (existing > 0) return;

    const now = new Date().toISOString();
    await db.day_types.bulkAdd(
      PRESET_DAY_TYPES.map((preset) => ({
        ...preset,
        id: crypto.randomUUID(),
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        is_archived: false,
      })),
    );
  });
}


/** Поля типа дня, которые задаёт пользователь. Служебные добавляет этот слой. */
export type DayTypeDraft = Omit<DayType, keyof BaseRecord | "sort_order" | "is_archived">;

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Все типы дня пользователя, кроме удалённых (инвариант 38: мягко удалённые
 * строки не участвуют ни в одной выборке). Архивные остаются: они не видны в
 * выборе типа на экране дня, но обязаны рисоваться на старых записях
 * (инвариант 11) и попадают в раздел «Архив» списка (раздел 8.5).
 */
export function listDayTypes(db: TimeoDB, userId: string): Promise<DayType[]> {
  return db.day_types
    .where("user_id")
    .equals(userId)
    .filter((dayType) => dayType.deleted_at === null)
    .sortBy("sort_order");
}

export async function createDayType(db: TimeoDB, userId: string, draft: DayTypeDraft): Promise<DayType> {
  // Чтение максимального sort_order и вставка — одной транзакцией: два
  // параллельных создания иначе получили бы один и тот же порядковый номер, и
  // список показал бы их в произвольном порядке.
  return db.transaction("rw", db.day_types, async () => {
    const existing = await db.day_types.where("user_id").equals(userId).toArray();
    const maxOrder = existing.reduce((max, row) => Math.max(max, row.sort_order), -1);

    const now = nowISO();
    const dayType: DayType = {
      ...draft,
      id: crypto.randomUUID(),
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      sort_order: maxOrder + 1,
      is_archived: false,
    };
    await db.day_types.add(dayType);
    return dayType;
  });
}

/**
 * Правка типа дня. Ни одной записи здесь не меняется — инвариант 10: «правка
 * типа дня не изменяет ни одной существующей записи». Пересчёт существующих
 * записей живёт отдельно, в applyDayTypeChange, и происходит только по явному
 * согласию пользователя.
 */
export async function updateDayType(db: TimeoDB, id: string, patch: Partial<DayTypeDraft>): Promise<void> {
  await db.day_types.update(id, { ...patch, updated_at: nowISO() });
}

/**
 * Инвариант 12: архивный тип дня можно вернуть в любой момент. Архивация —
 * это не удаление: тип исчезает из выбора на экране дня, но продолжает
 * рисоваться на старых записях.
 */
export async function setDayTypeArchived(db: TimeoDB, id: string, isArchived: boolean): Promise<void> {
  await db.day_types.update(id, { is_archived: isArchived, updated_at: nowISO() });
}

export interface DeleteDayTypeResult {
  deleted: boolean;
  /** Сколько записей ссылается на тип. Больше нуля — удаление отклонено. */
  referencingEntries: number;
}

/**
 * Инвариант 11 и 35: тип дня нельзя удалить, пока на него ссылается хоть одна
 * запись — «каждая запись ссылается на существующий тип дня». Вместо удаления
 * экран предлагает архивацию.
 *
 * Считаются и мягко удалённые записи тоже. Такая запись не исчезла: её держит
 * окно отмены (раздел 9) и, до блока 8, ещё не прошедшая синхронизация
 * (инвариант 38). Убрать из-под неё тип дня значило бы сделать отмену
 * удаления невозможной.
 *
 * Само удаление — мягкое (CLAUDE.md: необратимо не удаляем ничего), поэтому у
 * экрана есть окно отмены, а строка остаётся до распространения удаления.
 *
 * Проверка и запись — одной транзакцией: между отдельным подсчётом и
 * отдельным удалением успевает создаться запись с этим типом дня, и в базе
 * осталась бы запись со ссылкой в никуда.
 */
export async function deleteDayType(db: TimeoDB, id: string): Promise<DeleteDayTypeResult> {
  return db.transaction("rw", db.day_types, db.entries, async () => {
    const dayType = await db.day_types.get(id);
    if (!dayType) return { deleted: false, referencingEntries: 0 };

    // Фильтр по user_id, а не просто счёт по индексу day_type_id: после
    // миграции локальных данных при первом входе (блок 8) в базе окажутся
    // строки под двумя разными user_id, и чужая запись отказывала бы в
    // удалении без всякого объяснения.
    const referencingEntries = await db.entries
      .where("day_type_id")
      .equals(id)
      .filter((entry) => entry.user_id === dayType.user_id)
      .count();
    if (referencingEntries > 0) return { deleted: false, referencingEntries };

    const now = nowISO();
    await db.day_types.update(id, { deleted_at: now, updated_at: now });
    return { deleted: true, referencingEntries: 0 };
  });
}

export async function restoreDayType(db: TimeoDB, id: string): Promise<void> {
  await db.day_types.update(id, { deleted_at: null, updated_at: nowISO() });
}

/**
 * Порядок типов дня (раздел 8.5 — список переупорядочивается). Пишется одной
 * транзакцией: половина применённого порядка — это список, в котором два типа
 * делят один номер.
 */
export async function reorderDayTypes(db: TimeoDB, userId: string, orderedIds: string[]): Promise<void> {
  await db.transaction("rw", db.day_types, async () => {
    // Нумеруются ВСЕ типы пользователя, включая мягко удалённые: экран их не
    // видит и в orderedIds не присылает, а их прежние номера остаются в базе.
    // Отмена удаления в пятисекундном окне возвращала бы тип с номером, уже
    // занятым другим типом, и порядок двух строк становился бы случайным.
    const rest = (await db.day_types.where("user_id").equals(userId).toArray())
      .filter((dayType) => !orderedIds.includes(dayType.id))
      .sort((a, b) => a.sort_order - b.sort_order);

    const now = nowISO();
    for (const [index, id] of [...orderedIds, ...rest.map((dayType) => dayType.id)].entries()) {
      await db.day_types.update(id, { sort_order: index, updated_at: now });
    }
  });
}

export interface DayTypeChangeScope {
  dayTypeId: string;
  year: number;
  month: number;
  periodStartDay: number;
  weekendMultipliers: Settings["weekend_multipliers"];
}

/**
 * Раздел 6.7: сколько записей ТЕКУЩЕГО периода изменилось бы, если применить
 * новые правила типа дня. Ровно это число называет предложение «Обновить N
 * записей?», и ровно эти записи применяются при согласии — план строится
 * одной и той же чистой функцией.
 *
 * Закрытый период не считается и не обновляется (инвариант 2): его итоги
 * зафиксированы, и предлагать правку в нём нечего.
 */
async function planForPeriod(
  db: TimeoDB,
  userId: string,
  scope: DayTypeChangeScope,
): Promise<ReturnType<typeof planDayTypeChange>> {
  const dayType = await db.day_types.get(scope.dayTypeId);
  if (!dayType || dayType.deleted_at !== null) return [];

  const period = await db.periods
    .where("[user_id+year+month]")
    .equals([userId, scope.year, scope.month])
    .first();
  if (!period || period.is_closed) return [];

  const { start, end } = getPeriodDateRange(scope.year, scope.month, scope.periodStartDay);
  const startISO = toISODate(start);
  const endISO = toISODate(end);

  const entries = await db.entries
    .where("date")
    .between(startISO, endISO, true, true)
    .filter((entry: Entry) => entry.user_id === userId && entry.deleted_at === null)
    .toArray();

  const holidays = await db.holidays
    .where("date")
    .between(startISO, endISO, true, true)
    .filter((holiday: Holiday) => holiday.user_id === userId && holiday.deleted_at === null)
    .toArray();

  return planDayTypeChange({
    dayType,
    entries,
    period,
    periodStartISO: startISO,
    periodEndISO: endISO,
    holidayByDate: new Map(holidays.map((holiday) => [holiday.date, holiday])),
    weekendMultipliers: scope.weekendMultipliers,
  });
}

export async function countDayTypeChangeTargets(
  db: TimeoDB,
  userId: string,
  scope: DayTypeChangeScope,
): Promise<number> {
  const patches = await db.transaction("r", db.day_types, db.periods, db.entries, db.holidays, () =>
    planForPeriod(db, userId, scope),
  );
  return patches.length;
}

/**
 * Согласие получено — применяем. Чтение, планирование и запись внутри одной
 * rw-транзакции (инвариант 14: либо все затронутые записи обновлены, либо ни
 * одна), и план строится заново здесь, а не приходит с экрана: между вопросом
 * и ответом пользователь успевает изменить запись в другой вкладке, и в базу
 * лёг бы пересчёт по устаревшему состоянию.
 */
export async function applyDayTypeChange(
  db: TimeoDB,
  userId: string,
  scope: DayTypeChangeScope,
): Promise<number> {
  return db.transaction("rw", db.day_types, db.periods, db.entries, db.holidays, async () => {
    const patches = await planForPeriod(db, userId, scope);
    const now = nowISO();
    for (const patch of patches) {
      const { id, ...fields } = patch;
      await db.entries.update(id, { ...fields, updated_at: now });
    }
    return patches.length;
  });
}
