import type { TimeoDB } from "@/db/schema";
import { ensureSettings } from "@/db/settings";
import { ensureDayTypesSeeded } from "@/db/dayTypes";
import type { Settings } from "@/types/models";

export async function bootstrapUser(db: TimeoDB, userId: string): Promise<Settings> {
  const settings = await ensureSettings(db, userId);
  await ensureDayTypesSeeded(db, userId);
  return settings;
}
