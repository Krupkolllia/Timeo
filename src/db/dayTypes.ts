import type { TimeoDB } from "@/db/schema";
import type {
  BaseRecord,
  DayType,
  Entry,
  Holiday,
  Settings,
} from "@/types/models";
import { getPeriodDateRange } from "@/lib/calc/period";
import { toISODate } from "@/lib/calc/calendarGrid";
import { planDayTypeChange } from "@/lib/calc/dayTypeChange";
import { buildHolidayByDate } from "@/lib/calc/holidays";

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
    | "default_start"
    | "default_end"
    | "default_break_minutes"
    | "default_break_paid_minutes"
    | "default_multiplier"
    | "default_rate"
    | "ignore_auto_multipliers"
    | "sort_order"
>;

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
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
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
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
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
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
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
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
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
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
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
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: 5,
  },
];

/**
 * Стабильный ID для seed-объекта.
 *
 * Один и тот же user + один и тот же preset получают одинаковый UUID
 * на разных устройствах.
 */
async function stableSeedId(
    userId: string,
    key: string,
): Promise<string> {
  const input = new TextEncoder().encode(
      `timeo:day-type:${userId}:${key}`,
  );

  const hash = await crypto.subtle.digest(
      "SHA-256",
      input,
  );

  const bytes = new Uint8Array(hash);

  bytes[6] =
      (bytes[6] & 0x0f) | 0x40;

  bytes[8] =
      (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) =>
      byte.toString(16).padStart(2, "0"),
  );

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

export async function ensureDayTypesSeeded(
    db: TimeoDB,
    userId: string,
): Promise<void> {
  /**
   * ВАЖНО:
   *
   * Все async вычисления делаем ДО Dexie transaction.
   *
   * crypto.subtle.digest() может уступить event loop, поэтому await внутри
   * rw transaction здесь запрещён.
   */
  const now = new Date().toISOString();

  const rows = await Promise.all(
      PRESET_DAY_TYPES.map(
          async (preset, index) => ({
            ...preset,
            id: await stableSeedId(
                userId,
                `preset-${index}`,
            ),
            user_id: userId,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            is_archived: false,
          }),
      ),
  );

  /**
   * После этого внутри transaction остаются только операции IndexedDB.
   */
  await db.transaction(
      "rw",
      db.day_types,
      async () => {
        const existing =
            await db.day_types
            .where("user_id")
            .equals(userId)
            .count();

        if (existing > 0) {
          return;
        }

        await db.day_types.bulkAdd(rows);
      },
  );
}

/** Поля типа дня, которые задаёт пользователь. Служебные добавляет этот слой. */
export type DayTypeDraft = Omit<
    DayType,
    keyof BaseRecord | "sort_order" | "is_archived"
>;

function nowISO(): string {
  return new Date().toISOString();
}

export function listDayTypes(
    db: TimeoDB,
    userId: string,
): Promise<DayType[]> {
  return db.day_types
  .where("user_id")
  .equals(userId)
  .filter(
      (dayType) =>
          dayType.deleted_at === null,
  )
  .sortBy("sort_order");
}

export async function createDayType(
    db: TimeoDB,
    userId: string,
    draft: DayTypeDraft,
): Promise<DayType> {
  return db.transaction(
      "rw",
      db.day_types,
      async () => {
        const existing =
            await db.day_types
            .where("user_id")
            .equals(userId)
            .toArray();

        const maxOrder =
            existing.reduce(
                (max, row) =>
                    Math.max(
                        max,
                        row.sort_order,
                    ),
                -1,
            );

        const now = nowISO();

        const dayType: DayType = {
          ...draft,
          id: crypto.randomUUID(),
          user_id: userId,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          sort_order:
              maxOrder + 1,
          is_archived: false,
        };

        await db.day_types.add(
            dayType,
        );

        return dayType;
      },
  );
}

export async function updateDayType(
    db: TimeoDB,
    id: string,
    patch: Partial<DayTypeDraft>,
): Promise<void> {
  await db.day_types.update(id, {
    ...patch,
    updated_at: nowISO(),
  });
}

export async function setDayTypeArchived(
    db: TimeoDB,
    id: string,
    isArchived: boolean,
): Promise<void> {
  await db.day_types.update(id, {
    is_archived: isArchived,
    updated_at: nowISO(),
  });
}

export interface DeleteDayTypeResult {
  deleted: boolean;
  referencingEntries: number;
}

export async function deleteDayType(
    db: TimeoDB,
    id: string,
): Promise<DeleteDayTypeResult> {
  return db.transaction(
      "rw",
      db.day_types,
      db.entries,
      async () => {
        const dayType =
            await db.day_types.get(id);

        if (!dayType) {
          return {
            deleted: false,
            referencingEntries: 0,
          };
        }

        const referencingEntries =
            await db.entries
            .where("day_type_id")
            .equals(id)
            .filter(
                (entry) =>
                    entry.user_id ===
                    dayType.user_id,
            )
            .count();

        if (
            referencingEntries > 0
        ) {
          return {
            deleted: false,
            referencingEntries,
          };
        }

        const now = nowISO();

        await db.day_types.update(
            id,
            {
              deleted_at: now,
              updated_at: now,
            },
        );

        return {
          deleted: true,
          referencingEntries: 0,
        };
      },
  );
}

export async function restoreDayType(
    db: TimeoDB,
    id: string,
): Promise<void> {
  await db.day_types.update(id, {
    deleted_at: null,
    updated_at: nowISO(),
  });
}

export async function reorderDayTypes(
    db: TimeoDB,
    userId: string,
    orderedIds: string[],
): Promise<void> {
  await db.transaction(
      "rw",
      db.day_types,
      async () => {
        const rest =
            (
                await db.day_types
                .where("user_id")
                .equals(userId)
                .toArray()
            )
            .filter(
                (dayType) =>
                    !orderedIds.includes(
                        dayType.id,
                    ),
            )
            .sort(
                (a, b) =>
                    a.sort_order -
                    b.sort_order,
            );

        const now = nowISO();

        for (
            const [
              index,
              id,
            ] of [
          ...orderedIds,
          ...rest.map(
              (dayType) =>
                  dayType.id,
          ),
        ].entries()
            ) {
          await db.day_types.update(
              id,
              {
                sort_order: index,
                updated_at: now,
              },
          );
        }
      },
  );
}

export interface DayTypeChangeScope {
  dayTypeId: string;
  year: number;
  month: number;
  periodStartDay: number;
  weekendMultipliers:
      Settings["weekend_multipliers"];
}

async function planForPeriod(
    db: TimeoDB,
    userId: string,
    scope: DayTypeChangeScope,
): Promise<
    ReturnType<typeof planDayTypeChange>
> {
  const dayType =
      await db.day_types.get(
          scope.dayTypeId,
      );

  if (
      !dayType ||
      dayType.deleted_at !== null
  ) {
    return [];
  }

  const period =
      await db.periods
      .where(
          "[user_id+year+month]",
      )
      .equals([
        userId,
        scope.year,
        scope.month,
      ])
      .first();

  if (
      !period ||
      period.is_closed
  ) {
    return [];
  }

  const {
    start,
    end,
  } = getPeriodDateRange(
      scope.year,
      scope.month,
      scope.periodStartDay,
  );

  const startISO =
      toISODate(start);

  const endISO =
      toISODate(end);

  const entries =
      await db.entries
      .where("date")
      .between(
          startISO,
          endISO,
          true,
          true,
      )
      .filter(
          (entry: Entry) =>
              entry.user_id ===
              userId &&
              entry.deleted_at === null,
      )
      .toArray();

  const holidays =
      await db.holidays
      .where("date")
      .between(
          startISO,
          endISO,
          true,
          true,
      )
      .filter(
          (holiday: Holiday) =>
              holiday.user_id ===
              userId &&
              holiday.deleted_at === null,
      )
      .toArray();

  return planDayTypeChange({
    dayType,
    entries,
    period,
    periodStartISO: startISO,
    periodEndISO: endISO,
    holidayByDate:
        buildHolidayByDate(
            holidays,
        ),
    weekendMultipliers:
    scope.weekendMultipliers,
  });
}

export async function countDayTypeChangeTargets(
    db: TimeoDB,
    userId: string,
    scope: DayTypeChangeScope,
): Promise<number> {
  const patches =
      await db.transaction(
          "r",
          db.day_types,
          db.periods,
          db.entries,
          db.holidays,
          () =>
              planForPeriod(
                  db,
                  userId,
                  scope,
              ),
      );

  return patches.length;
}

export async function applyDayTypeChange(
    db: TimeoDB,
    userId: string,
    scope: DayTypeChangeScope,
): Promise<number> {
  return db.transaction(
      "rw",
      db.day_types,
      db.periods,
      db.entries,
      db.holidays,
      async () => {
        const patches =
            await planForPeriod(
                db,
                userId,
                scope,
            );

        const now = nowISO();

        for (const patch of patches) {
          const {
            id,
            ...fields
          } = patch;

          await db.entries.update(
              id,
              {
                ...fields,
                updated_at: now,
              },
          );
        }

        return patches.length;
      },
  );
}