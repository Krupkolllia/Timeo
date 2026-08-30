import type { TimeoDB } from "@/db/schema";
import type { BaseRecord, Settings } from "@/types/models";

// Section 5.1 of the spec.
export const DEFAULT_SETTINGS: Omit<Settings, keyof BaseRecord> = {
  currency: "PLN",
  period_start_day: 1,
  period_naming: "end_month",
  default_hours: 8,
  theme: "system",
  show_shift_times: false,
  reminder_enabled: false,
  reminder_time: null,
  week_starts_on: "monday",
  weekend_multipliers: { saturday: 1, sunday: 1, holiday: 1 },
  default_base_rate: 0,
  default_norm_hours: 160,
  default_base_rate_from_period: null,
  preferred_rate_change_mode: null,
  seeded_holiday_years: [],
  total_hours_paid_only: true,
};

/**
 * Правка одного поля настроек с экрана-заглушки настроек (блок 7 ещё не
 * построен, но и там правка настроек не должна открывать ничего, кроме
 * settings — этому полю тоже нечего пересчитывать: раздел 6.5 читает его при
 * следующем построении итогов, а не пересчитывает существующие).
 */
export async function updateSettings(db: TimeoDB, id: string, patch: Partial<Settings>): Promise<void> {
  await db.settings.update(id, { ...patch, updated_at: new Date().toISOString() });
}

export async function ensureSettings(db: TimeoDB, userId: string): Promise<Settings> {
  // The rw transaction makes check-then-insert atomic: without it, two parallel
  // calls (e.g. a double effect invocation in React StrictMode) would both fail to find
  // the row and each would create a duplicate settings record for the same user_id.
  return db.transaction("rw", db.settings, async () => {
    const existing = await db.settings.where("user_id").equals(userId).first();
    if (existing) return existing;

    const now = new Date().toISOString();
    const settings: Settings = {
      id: crypto.randomUUID(),
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      ...DEFAULT_SETTINGS,
    };
    await db.settings.add(settings);
    return settings;
  });
}

/**
 * Раздел 8.4: множители выходных и праздника. Экран настроек — блок 7, а без
 * этих трёх полей праздник не значит ничего (множитель по умолчанию 1), поэтому
 * блок 5 показывает их на экране праздников (раздел 8.6).
 *
 * Инвариант 51: пересчёта здесь нет и быть не может — таблица entries не
 * открывается вовсе. Множитель влияет только на то, что ПРЕДЛАГАЕТСЯ новым
 * записям.
 */
export async function updateWeekendMultipliers(
  db: TimeoDB,
  id: string,
  patch: Partial<Settings["weekend_multipliers"]>,
): Promise<void> {
  // Читаем и пишем одной транзакцией, а не подставляем объект целиком с
  // экрана: useLiveQuery отдаёт компоненту снимок, и правка второго поля
  // раньше, чем приедет обновлённая строка, унесла бы в базу прежнее значение
  // первого. Пользователь увидел бы, как только что заданный субботний
  // множитель молча вернулся к единице.
  await db.transaction("rw", db.settings, async () => {
    const settings = await db.settings.get(id);
    if (!settings) return;
    await db.settings.update(id, {
      weekend_multipliers: { ...settings.weekend_multipliers, ...patch },
      updated_at: new Date().toISOString(),
    });
  });
}
