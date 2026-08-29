import type { TimeoDB } from "@/db/schema";
import type { Period, Settings } from "@/types/models";

export interface ManualPeriodDraft {
  year: number;
  month: number;
  /** Отработанные часы за месяц — человек вписывает их, а не выводит из записей. */
  hours: number;
  amount: number;
}

/**
 * Раздел 8.7: исторические месяцы, введённые руками. Записей у такого периода
 * нет вовсе, поэтому итоги берутся из closed_totals (инвариант 5,
 * calculatePeriodTotals это уже умеет).
 *
 * Период сохраняется закрытым — иначе его итог считался бы по записям, которых
 * нет, и месяц показывал бы ноль. Отсюда же следствие, о котором экран обязан
 * предупредить: по инварианту 4 день начала периода нельзя менять, пока
 * существует хоть один закрытый период.
 */
export async function saveManualPeriod(
  db: TimeoDB,
  userId: string,
  draft: ManualPeriodDraft,
  settings: Pick<Settings, "default_base_rate" | "default_norm_hours">,
): Promise<Period> {
  const now = new Date().toISOString();
  const closed_totals = {
    amount: draft.amount,
    total_hours: draft.hours,
    // Часы исторического месяца считаются и отработанными, и идущими в норму:
    // раздельно их вводить негде, а два поля вместо одного на экране, где
    // человек переносит цифру из старой платёжки, — это вопрос, на который у
    // него нет ответа.
    norm_hours_covered: draft.hours,
  };

  return db.transaction("rw", db.periods, async () => {
    // Мягко удалённые строки не в счёт (инвариант 38): иначе повторное
    // сохранение месяца, удалённого час назад, правило бы удалённую строку, и
    // на экране это выглядело бы как «кнопка «сохранить» ничего не делает».
    const existing = await db.periods
      .where("[user_id+year+month]")
      .equals([userId, draft.year, draft.month])
      .filter((period) => period.deleted_at === null)
      .first();

    if (existing) {
      // Правка ручного периода идёт сюда же (иначе опечатку в историческом
      // итоге нельзя было бы исправить никогда). Записи месяца, если они вдруг
      // есть, не трогаются: они остаются в базе и вернутся в расчёт, как только
      // ручной период будет удалён.
      await db.periods.update(existing.id, {
        is_manual: true,
        is_closed: true,
        closed_totals,
        updated_at: now,
      });
      return { ...existing, is_manual: true, is_closed: true, closed_totals, updated_at: now };
    }

    const period: Period = {
      id: crypto.randomUUID(),
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      year: draft.year,
      month: draft.month,
      // Ставка и норма берутся из настроек, а не из соседнего периода: у
      // исторического месяца своей ставки не существует, человек вводил итог.
      // На расчёт они не влияют вовсе (итоги идут из closed_totals) и нужны
      // лишь для того, чтобы поля периода не были пустыми.
      base_rate: settings.default_base_rate,
      norm_hours: settings.default_norm_hours,
      extra_amount: 0,
      extra_note: "",
      is_closed: true,
      closed_totals,
      is_manual: true,
    };
    await db.periods.add(period);
    return period;
  });
}

/** Ручные периоды, новые сверху: список читается как история, а не как календарь. */
export async function listManualPeriods(db: TimeoDB, userId: string): Promise<Period[]> {
  const rows = await db.periods
    .where("user_id")
    .equals(userId)
    .filter((period) => period.is_manual && period.deleted_at === null)
    .toArray();
  return rows.sort((a, b) => b.year - a.year || b.month - a.month);
}

/**
 * Мягкое удаление с окном отмены на экране (CLAUDE.md: необратимо не удаляем
 * ничего). Побочный эффект намеренный и полезный: hasClosedPeriods не считает
 * удалённые строки, поэтому удаление последнего ручного периода снова
 * разблокирует день начала периода (инвариант 4).
 */
export async function softDeleteManualPeriod(db: TimeoDB, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.periods.update(id, { deleted_at: now, updated_at: now });
}

/**
 * Отмена удаления. Пока действовало окно отмены, месяц для всех запросов не
 * существовал, и календарь мог создать для него обычный период (раздел 5.2).
 * Просто снять deleted_at в этом случае нельзя: на один year+month стало бы две
 * живые строки, а выборка периода берёт .first() — месяц раздвоился бы
 * навсегда, и какая из двух строк выиграет, зависело бы от порядка ключей.
 *
 * Поэтому: если живая строка месяца уже появилась, ручные итоги переносятся в
 * неё, а удалённая остаётся удалённой.
 */
export async function restoreManualPeriod(db: TimeoDB, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction("rw", db.periods, async () => {
    const deleted = await db.periods.get(id);
    if (!deleted) return;

    const live = await db.periods
      .where("[user_id+year+month]")
      .equals([deleted.user_id, deleted.year, deleted.month])
      .filter((period) => period.deleted_at === null)
      .first();

    if (live) {
      await db.periods.update(live.id, {
        is_manual: true,
        is_closed: true,
        closed_totals: deleted.closed_totals,
        updated_at: now,
      });
      return;
    }

    await db.periods.update(id, { deleted_at: null, updated_at: now });
  });
}
