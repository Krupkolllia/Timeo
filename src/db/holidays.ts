import type { TimeoDB } from "@/db/schema";
import type { Holiday } from "@/types/models";
import { polishHolidaysForYear } from "@/lib/calc/holidays";

function nowISO(): string {
  return new Date().toISOString();
}

const SEED_YEARS_AHEAD = 1;

/**
 * Стабильный ID seeded holiday.
 *
 * Один и тот же user + date + name получает одинаковый UUID на разных
 * устройствах.
 */
async function stableHolidayId(
    userId: string,
    date: string,
    name: string,
): Promise<string> {
  const input = new TextEncoder().encode(
      `timeo:holiday:${userId}:${date}:${name
      .trim()
      .toLowerCase()}`,
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

export async function ensureHolidaysSeeded(
    db: TimeoDB,
    userId: string,
    today = new Date(),
): Promise<number> {
  const currentYear =
      today.getFullYear();

  const wanted: number[] = [];

  for (
      let offset = 0;
      offset <=
      SEED_YEARS_AHEAD;
      offset++
  ) {
    wanted.push(
        currentYear + offset,
    );
  }

  /**
   * Сначала читаем settings и вычисляем всё, что нужно создать.
   *
   * Вся crypto работа находится ВНЕ Dexie transaction.
   */
  const settings =
      await db.settings
      .where("user_id")
      .equals(userId)
      .first();

  if (!settings) {
    return 0;
  }

  const seeded = new Set(
      settings.seeded_holiday_years ??
      [],
  );

  const missing =
      wanted.filter(
          (year) =>
              !seeded.has(year),
      );

  if (
      missing.length === 0
  ) {
    return 0;
  }

  const now = nowISO();

  const rows: Holiday[] = [];

  for (const year of missing) {
    const presets =
        polishHolidaysForYear(
            year,
        );

    for (
        const preset of presets
        ) {
      rows.push({
        id:
            await stableHolidayId(
                userId,
                preset.date,
                preset.name,
            ),
        user_id: userId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        date: preset.date,
        name: preset.name,
        is_custom: false,
      });
    }
  }

  /**
   * Теперь только IndexedDB operations.
   *
   * Никаких crypto/network/других внешних await внутри transaction.
   */
  return db.transaction(
      "rw",
      db.settings,
      db.holidays,
      async () => {
        const freshSettings =
            await db.settings
            .where("user_id")
            .equals(userId)
            .first();

        if (!freshSettings) {
          return 0;
        }

        const freshSeeded =
            new Set(
                freshSettings.seeded_holiday_years ??
                [],
            );

        /**
         * Если параллельный вызов уже успел засеять этот год,
         * ничего повторно не добавляем.
         */
        const stillMissing =
            missing.filter(
                (year) =>
                    !freshSeeded.has(
                        year,
                    ),
            );

        if (
            stillMissing.length === 0
        ) {
          return 0;
        }

        const allowedYears =
            new Set(
                stillMissing,
            );

        const rowsToInsert =
            rows.filter((row) =>
                allowedYears.has(
                    Number(
                        row.date.slice(0, 4),
                    ),
                ),
            );

        if (
            rowsToInsert.length > 0
        ) {
          await db.holidays.bulkAdd(
              rowsToInsert,
          );
        }

        await db.settings.update(
            freshSettings.id,
            {
              seeded_holiday_years: [
                ...new Set([
                  ...(freshSettings.seeded_holiday_years ??
                      []),
                  ...stillMissing,
                ]),
              ].sort(
                  (a, b) => a - b,
              ),
              updated_at: now,
            },
        );

        return rowsToInsert.length;
      },
  );
}

export function listHolidays(
    db: TimeoDB,
    userId: string,
): Promise<Holiday[]> {
  return db.holidays
  .where("user_id")
  .equals(userId)
  .filter(
      (holiday) =>
          holiday.deleted_at === null,
  )
  .toArray()
  .then((rows) =>
      rows.sort((a, b) => {
        if (a.date !== b.date) {
          return a.date < b.date
              ? -1
              : 1;
        }

        if (
            a.created_at !==
            b.created_at
        ) {
          return a.created_at <
          b.created_at
              ? -1
              : 1;
        }

        return a.id < b.id
            ? -1
            : a.id > b.id
                ? 1
                : 0;
      }),
  );
}

export interface HolidayDraft {
  date: string;
  name: string;
}

export async function createHoliday(
    db: TimeoDB,
    userId: string,
    draft: HolidayDraft,
): Promise<Holiday> {
  const now = nowISO();

  const holiday: Holiday = {
    id: crypto.randomUUID(),
    user_id: userId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    date: draft.date,
    name: draft.name,
    is_custom: true,
  };

  await db.holidays.add(
      holiday,
  );

  return holiday;
}

export async function softDeleteHoliday(
    db: TimeoDB,
    id: string,
): Promise<void> {
  const now = nowISO();

  await db.holidays.update(
      id,
      {
        deleted_at: now,
        updated_at: now,
      },
  );
}

export async function restoreHoliday(
    db: TimeoDB,
    id: string,
): Promise<void> {
  await db.holidays.update(
      id,
      {
        deleted_at: null,
        updated_at:
            nowISO(),
      },
  );
}