import type { TimeoDB } from "@/db/schema";
import type { BaseRecord, Settings } from "@/types/models";

// Раздел 5.1 ТЗ.
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
  preferred_rate_change_mode: null,
};

export async function ensureSettings(db: TimeoDB, userId: string): Promise<Settings> {
  // rw-транзакция делает check-then-insert атомарным: без неё два параллельных
  // вызова (например, двойной вызов эффекта в React StrictMode) оба не находят
  // строку и создают по дубликату настроек на одного user_id.
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
