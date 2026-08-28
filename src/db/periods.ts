import { getAdjacentPeriod } from "@/lib/calc/period";
import type { TimeoDB } from "@/db/schema";
import type { Period, Settings } from "@/types/models";

function findPeriod(db: TimeoDB, userId: string, year: number, month: number) {
  return db.periods.where("[user_id+year+month]").equals([userId, year, month]).first();
}

/**
 * Section 5.2 of the spec — the period isolation mechanism. On first access to a period,
 * the base_rate/norm_hours values are COPIED from the previous period (not referenced),
 * so edits in one period physically cannot affect another. If there is no
 * previous period, default_base_rate/default_norm_hours are taken from settings.
 */
export async function getOrCreatePeriod(
  db: TimeoDB,
  userId: string,
  year: number,
  month: number,
  settings: Pick<Settings, "default_base_rate" | "default_norm_hours">,
): Promise<Period> {
  // Read and create in a single rw transaction: without this, two parallel calls
  // (e.g. a repeated effect invocation in React StrictMode) would both fail to find
  // the period and each would create its own row, duplicating the period for one year+month.
  return db.transaction("rw", db.periods, async () => {
    const existing = await findPeriod(db, userId, year, month);
    if (existing) return existing;

    const previousId = getAdjacentPeriod(year, month, -1);
    const previous = await findPeriod(db, userId, previousId.year, previousId.month);

    const now = new Date().toISOString();
    const period: Period = {
      id: crypto.randomUUID(),
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      year,
      month,
      base_rate: previous ? previous.base_rate : settings.default_base_rate,
      norm_hours: previous ? previous.norm_hours : settings.default_norm_hours,
      extra_amount: 0,
      extra_note: "",
      is_closed: false,
      closed_totals: null,
      is_manual: false,
    };

    await db.periods.add(period);
    return period;
  });
}
