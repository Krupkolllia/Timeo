import { getAdjacentPeriod } from "@/lib/calc/period";
import type { TimeoDB } from "@/db/schema";
import type { Period, Settings } from "@/types/models";

function findPeriod(db: TimeoDB, userId: string, year: number, month: number) {
  return db.periods.where("[user_id+year+month]").equals([userId, year, month]).first();
}

/**
 * Раздел 5.2 ТЗ — механика изоляции периодов. При первом обращении к периоду
 * значения base_rate/norm_hours КОПИРУЮТСЯ из предыдущего периода (не ссылка),
 * поэтому правки в одном периоде физически не могут задеть другой. Если
 * предыдущего периода нет — берутся default_base_rate/default_norm_hours из настроек.
 */
export async function getOrCreatePeriod(
  db: TimeoDB,
  userId: string,
  year: number,
  month: number,
  settings: Pick<Settings, "default_base_rate" | "default_norm_hours">,
): Promise<Period> {
  // Читаем и создаём в одной rw-транзакции: без этого два параллельных вызова
  // (например, повторный вызов эффекта в React StrictMode) оба не находят
  // период и создают по строке каждый, дублируя period на один year+month.
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
