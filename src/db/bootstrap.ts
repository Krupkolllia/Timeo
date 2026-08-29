import type { TimeoDB } from "@/db/schema";
import { ensureSettings } from "@/db/settings";
import { ensureDayTypesSeeded } from "@/db/dayTypes";
import { ensureHolidaysSeeded } from "@/db/holidays";
import type { Settings } from "@/types/models";

export async function bootstrapUser(db: TimeoDB, userId: string): Promise<Settings> {
  const settings = await ensureSettings(db, userId);
  await ensureDayTypesSeeded(db, userId);
  // После ensureSettings: посев отмечается в settings.seeded_holiday_years, и
  // без готовой строки настроек отмечать его негде.
  await ensureHolidaysSeeded(db, userId);
  return settings;
}
