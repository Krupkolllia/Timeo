import type { DayType, Entry, RateChangeMode, RateSource } from "@/types/models";
import { calculateEntryAmount } from "@/lib/calc/entry";

/**
 * Патч одной записи при смене базовой ставки периода. Возвращается, а не
 * применяется: по CLAUDE.md слой lib/calc не знает ни про Dexie, ни про React —
 * запись в базу делает db/periods.applyBaseRateChange одной транзакцией
 * (инвариант 14: пересчёт атомарен целиком или не происходит вовсе).
 */
export interface EntryRatePatch {
  id: string;
  rate_per_hour: number;
  amount: number;
  rate_is_manual: boolean;
  rate_source: RateSource;
}

export interface RateChangePlanInput {
  mode: RateChangeMode;
  newBaseRate: number;
  /** Все записи пользователя, которые попали в выборку. Планировщик сам отсекает чужие периоды. */
  entries: Entry[];
  dayTypeById: Map<string, Pick<DayType, "pay_mode" | "fixed_amount">>;
  /** Границы редактируемого периода включительно, YYYY-MM-DD. */
  periodStartISO: string;
  periodEndISO: string;
  /** Дата, начиная с которой действует новая ставка (режим apply_from_date). */
  fromDateISO: string | null;
}

/**
 * Раздел 6.6 ТЗ — три режима смены базовой ставки периода.
 *
 * Инвариант 1 (изоляция периодов) держится здесь на явном фильтре по
 * [periodStartISO, periodEndISO]: это платёжный журнал, и промах диапазона
 * молча переписывает историю соседнего месяца. Сравнение строк ISO-дат
 * лексикографическое — для формата YYYY-MM-DD оно совпадает с хронологическим,
 * и никакой Date здесь не создаётся (инвариант 27: через UTC ничего не гоняем).
 *
 * Из пересчёта исключены (инварианты 8 и 9):
 *  - записи с amount_override — их сумма задана человеком целиком;
 *  - записи с rate_is_manual — ставка отвязана от базовой;
 *  - записи неизвестного типа дня — считать их не по чему, трогать нельзя.
 *
 * Патч не выпускается, если пересчёт дал те же числа: это и есть
 * идемпотентность (инвариант 13) — второй прогон подряд не пишет ничего.
 */
export function planRateChange(input: RateChangePlanInput): EntryRatePatch[] {
  // Ставка со следующего периода: ни одна запись текущего не трогается вовсе.
  if (input.mode === "apply_next_period") return [];

  const patches: EntryRatePatch[] = [];

  for (const entry of input.entries) {
    if (entry.deleted_at !== null) continue;
    if (entry.date < input.periodStartISO || entry.date > input.periodEndISO) continue;
    if (entry.amount_override !== null) continue;
    if (entry.rate_is_manual) continue;

    const dayType = input.dayTypeById.get(entry.day_type_id);
    if (!dayType) continue;

    // Режим «с даты» без даты вырождается в пересчёт всего периода: это ровно
    // то, что означает «новая ставка действует с начала периода».
    const freeze =
      input.mode === "apply_from_date" && input.fromDateISO !== null && entry.date < input.fromDateISO;

    if (freeze) {
      // Заморозка осмысленна только там, где ставка вообще участвует в сумме.
      // Для unpaid/fixed_amount она ничего не защищает, а rate_is_manual=true
      // на такой записи потом молча исключил бы её из честного пересчёта.
      if (dayType.pay_mode !== "hourly") continue;
      patches.push({
        id: entry.id,
        rate_per_hour: entry.rate_per_hour,
        amount: entry.amount,
        rate_is_manual: true,
        rate_source: "frozen",
      });
      continue;
    }

    const { amount, rate_per_hour } = calculateEntryAmount(entry, dayType, { base_rate: input.newBaseRate });
    // rate_source после пересчёта всегда "period_base": ставка этой записи
    // только что выведена из базовой ставки периода, и инвариант 15 требует,
    // чтобы поле описывало, как число реально получилось. На записях,
    // созданных до отделения множителя от ставки, здесь лежат "weekend_rule" /
    // "holiday_rule" / "day_type_default" — они объясняли ставку в старой
    // модели и после пересчёта становятся прямой неправдой.
    const rate_source: RateSource = "period_base";
    if (amount === entry.amount && rate_per_hour === entry.rate_per_hour && rate_source === entry.rate_source)
      continue;

    patches.push({
      id: entry.id,
      rate_per_hour,
      amount,
      rate_is_manual: false,
      rate_source,
    });
  }

  return patches;
}
