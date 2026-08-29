import { getPeriodDateRange } from "@/lib/calc/period";
import { toISODate } from "@/lib/calc/calendarGrid";
import type { TimeoDB } from "@/db/schema";
import type { Period, Settings } from "@/types/models";

export interface ManualPeriodDraft {
  year: number;
  month: number;
  /** Отработанные часы за месяц — человек вписывает их, а не выводит из записей. */
  hours: number;
  amount: number;
  /**
   * Идентификатор правящегося месяца. Нужен ровно для одного случая: человек
   * открыл май и поменял в форме месяц на июнь. Без него сохранение заводило бы
   * ИЮНЬ и оставляло май на месте — один и тот же исторический итог оказывался
   * бы посчитан дважды, в двух месяцах.
   */
  replacingId?: string | null;
}

export type ManualPeriodSettings = Pick<
  Settings,
  "default_base_rate" | "default_norm_hours" | "period_start_day"
>;

export type SaveManualPeriodResult =
  | { status: "saved"; period: Period }
  /**
   * Инвариант 2: месяц закрыт и не является ручным — его итоги зафиксированы,
   * и переписать их отсюда нельзя. Не «тихо ничего не делаем»: экран обязан
   * сказать, почему, и увести туда, где период открывают заново (инвариант 3 —
   * это осознанное действие с подтверждением, и оно живёт на экране периода).
   */
  | { status: "closed_period"; period: Period };

function nowISO(): string {
  return new Date().toISOString();
}

function findLive(db: TimeoDB, userId: string, year: number, month: number) {
  return db.periods
    .where("[user_id+year+month]")
    .equals([userId, year, month])
    .filter((period) => period.deleted_at === null)
    .first();
}

/**
 * Есть ли у месяца собственные записи. От этого зависит, что значит «убрать
 * исторический месяц»: строку периода, заведённую только ради ввода итогов,
 * можно мягко удалить целиком, а месяц с записями пришёл из обычной работы
 * приложения и несёт свою базовую ставку, норму и прочие начисления —
 * удалить его строку значило бы потерять их молча.
 */
async function monthHasEntries(
  db: TimeoDB,
  userId: string,
  year: number,
  month: number,
  periodStartDay: number,
): Promise<boolean> {
  const { start, end } = getPeriodDateRange(year, month, periodStartDay);
  const count = await db.entries
    .where("date")
    .between(toISODate(start), toISODate(end), true, true)
    .filter((entry) => entry.user_id === userId && entry.deleted_at === null)
    .count();
  return count > 0;
}

/**
 * Снять с месяца признак ручного, ничего не потеряв.
 *
 * Месяц с записями возвращается в обычное состояние прямо на месте: ставка,
 * норма и прочие начисления остаются, итоги снова считаются по записям.
 * Месяц без записей — строка, существовавшая только ради введённых итогов, —
 * удаляется мягко (CLAUDE.md: необратимо не удаляем ничего). Заодно это
 * снимает замок инварианта 4: hasClosedPeriods не считает удалённые строки.
 */
async function releaseManualPeriod(
  db: TimeoDB,
  userId: string,
  period: Period,
  periodStartDay: number,
): Promise<void> {
  const now = nowISO();
  if (await monthHasEntries(db, userId, period.year, period.month, periodStartDay)) {
    await db.periods.update(period.id, {
      is_manual: false,
      is_closed: false,
      closed_totals: null,
      updated_at: now,
    });
    return;
  }
  await db.periods.update(period.id, { deleted_at: now, updated_at: now });
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
  settings: ManualPeriodSettings,
): Promise<SaveManualPeriodResult> {
  const now = nowISO();
  const closed_totals = {
    amount: draft.amount,
    total_hours: draft.hours,
    // Часы исторического месяца считаются и отработанными, и идущими в норму:
    // раздельно их вводить негде, а два поля вместо одного на экране, где
    // человек переносит цифру из старой платёжки, — это вопрос, на который у
    // него нет ответа.
    norm_hours_covered: draft.hours,
  };

  return db.transaction("rw", db.periods, db.entries, async () => {
    // Мягко удалённые строки не в счёт (инвариант 38): иначе повторное
    // сохранение месяца, удалённого час назад, правило бы удалённую строку, и
    // на экране это выглядело бы как «кнопка «сохранить» ничего не делает».
    const existing = await findLive(db, userId, draft.year, draft.month);

    // Закрытый обычный месяц не переписывается: в его closed_totals лежит
    // снимок, снятый при закрытии, и заменить его введёнными числами значило бы
    // потерять зафиксированный итог без всякого подтверждения.
    if (existing && existing.is_closed && !existing.is_manual) {
      return { status: "closed_period", period: existing };
    }

    const replaced =
      draft.replacingId && draft.replacingId !== existing?.id
        ? await db.periods.get(draft.replacingId)
        : undefined;

    // Переносить можно только строку, заведённую ради самих итогов. У месяца с
    // записями есть собственные ставка, норма и прочие начисления — унеся
    // строку в другой месяц, мы оставили бы прежний вовсе без периода, и
    // календарь завёл бы его заново по умолчаниям, потеряв всё это молча.
    const movable =
      replaced !== undefined &&
      replaced.deleted_at === null &&
      !(await monthHasEntries(db, userId, replaced.year, replaced.month, settings.period_start_day));

    // Месяц в форме сменили, а в новом месяце строки ещё нет — переносим ту же
    // строку, а не заводим вторую.
    if (!existing && movable && replaced) {
      const moved: Period = {
        ...replaced,
        year: draft.year,
        month: draft.month,
        is_manual: true,
        is_closed: true,
        closed_totals,
        updated_at: now,
      };
      await db.periods.put(moved);
      return { status: "saved", period: moved };
    }

    // Месяц сменили, и в новом месяце строка уже есть: итоги уезжают в неё, а
    // прежняя перестаёт быть ручной (с сохранением всего, что в ней было).
    if (replaced && replaced.deleted_at === null) {
      await releaseManualPeriod(db, userId, replaced, settings.period_start_day);
    }

    if (existing) {
      // Правка ручного периода идёт сюда же (иначе опечатку в историческом
      // итоге нельзя было бы исправить никогда). Записи месяца, если они вдруг
      // есть, не трогаются: они остаются в базе и вернутся в расчёт, как только
      // ручной период будет убран.
      const updated: Period = { ...existing, is_manual: true, is_closed: true, closed_totals, updated_at: now };
      await db.periods.put(updated);
      return { status: "saved", period: updated };
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
    return { status: "saved", period };
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
 * «Удалить» исторический месяц: снять с него ручные итоги. Строка исчезает
 * из списка в обоих случаях, но месяц с записями при этом остаётся в базе
 * целым — см. releaseManualPeriod.
 */
export async function removeManualPeriod(
  db: TimeoDB,
  userId: string,
  period: Period,
  periodStartDay: number,
): Promise<void> {
  await db.transaction("rw", db.periods, db.entries, async () => {
    const current = await db.periods.get(period.id);
    if (!current || current.deleted_at !== null) return;
    await releaseManualPeriod(db, userId, current, periodStartDay);
  });
}

/**
 * Отмена удаления. Возвращаем именно тот снимок итогов, который был на экране:
 * строку могли не удалять вовсе, а вернуть в обычное состояние (месяц с
 * записями), и её собственный closed_totals уже пуст.
 *
 * Пока действовало окно отмены, месяц для всех запросов не существовал, и
 * календарь мог создать для него обычный период (раздел 5.2). Просто снять
 * deleted_at в этом случае нельзя: на один year+month стало бы две живые
 * строки, а выборка периода берёт .first() — месяц раздвоился бы навсегда, и
 * какая из двух строк выиграет, зависело бы от порядка ключей. Поэтому итоги
 * переносятся в уже появившуюся строку.
 */
export async function restoreManualPeriod(db: TimeoDB, userId: string, period: Period): Promise<void> {
  const now = nowISO();
  await db.transaction("rw", db.periods, async () => {
    const live = await findLive(db, userId, period.year, period.month);

    if (live) {
      await db.periods.update(live.id, {
        is_manual: true,
        is_closed: true,
        closed_totals: period.closed_totals,
        updated_at: now,
      });
      return;
    }

    const deleted = await db.periods.get(period.id);
    if (!deleted) return;
    await db.periods.update(period.id, {
      deleted_at: null,
      is_manual: true,
      is_closed: true,
      closed_totals: period.closed_totals,
      updated_at: now,
    });
  });
}
