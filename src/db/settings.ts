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
  preferred_rate_change_mode: null,
};

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
