import type { DayType, Entry, Holiday, Period, RateSource, WeekendMultipliers } from "@/types/models";
import { calculateEntryAmount, mapRateSource } from "@/lib/calc/entry";
import { resolveMultiplier } from "@/lib/calc/multiplier";

/**
 * Раздел 6.7 ТЗ — правка типа дня. Две категории полей, разделённые строго.
 *
 * КОСМЕТИКА (имя, цвет, значок, заметка, порядок) применяется сразу и везде,
 * включая закрытые периоды: денег она не трогает, спрашивать нечего.
 *
 * ФИНАНСОВЫЕ поля меняют поведение БУДУЩИХ записей. Существующие не
 * пересчитываются автоматически никогда (инвариант 10) — только по явному
 * согласию и только в текущем периоде.
 */
const FINANCIAL_FIELDS = [
  "pay_mode",
  "rate_mode",
  "fixed_amount",
  "default_multiplier",
  "default_rate",
  "default_hours",
  // Раздел 6.7 явно называет "default times" среди финансовых полей. Как и у
  // default_hours, правка этих полей никогда не даёт патчей в
  // planDayTypeChange ниже (часы существующих записей не трогаются вовсе —
  // см. комментарий у ЧАСЫ ниже), поэтому предложение "обновить N записей?"
  // на практике не появляется от одной только правки времён — count всегда 0.
  // Поле остаётся в списке ради консистентности с 6.7 и на случай, если
  // правка совпала с правкой ставки/множителя в одном сохранении формы.
  "default_start",
  "default_end",
  "default_break_minutes",
  "default_break_paid_minutes",
  "counts_as_work",
  "counts_toward_norm",
  "ignore_auto_multipliers",
] as const satisfies readonly (keyof DayType)[];

export function hasFinancialChange(before: DayType, after: DayType): boolean {
  return FINANCIAL_FIELDS.some((field) => before[field] !== after[field]);
}

/** Патч одной записи при обновлении по новым правилам типа дня. */
export interface EntryDayTypePatch {
  id: string;
  multiplier: number;
  rate_per_hour: number;
  rate_is_manual: boolean;
  amount: number;
  rate_source: RateSource;
}

export interface DayTypeChangePlanInput {
  /** Тип дня уже в НОВОМ виде — планировщик считает по нему, а не по старому. */
  dayType: DayType;
  /** Записи выборки. Планировщик сам отсекает чужие периоды и чужие типы дня. */
  entries: Entry[];
  period: Pick<Period, "base_rate">;
  /** Границы текущего периода включительно, YYYY-MM-DD. */
  periodStartISO: string;
  periodEndISO: string;
  holidayByDate: Map<string, Holiday>;
  weekendMultipliers: WeekendMultipliers;
}

/**
 * Раздел 6.7: «Обновить N записей в текущем периоде?». Возвращает патчи, а не
 * применяет их — по CLAUDE.md слой lib/calc не знает ни про Dexie, ни про
 * React; запись делает db/dayTypes.applyDayTypeChange одной транзакцией
 * (инвариант 14).
 *
 * То же число служит и счётчиком в вопросе: список патчей и есть «N записей»,
 * поэтому предложение не может назвать одно количество, а изменить другое.
 *
 * Границы периода — явный фильтр по строкам ISO-дат, как в planRateChange:
 * инвариант 1 и раздел 6.7 («прошлые периоды не включаются никогда») держатся
 * именно на нём. Лексикографическое сравнение YYYY-MM-DD совпадает с
 * хронологическим, и ни один Date здесь не создаётся (инвариант 27).
 *
 * Исключены (инварианты 8 и 9):
 *  - записи с amount_override — сумма задана человеком целиком;
 *  - записи с rate_is_manual — ставку задал человек. Исключение — записи с
 *    rate_source = "type_pinned": флаг им поставил этот же механизм, означает
 *    он «ставка пришла из типа дня», и обновлять их пользователь как раз и
 *    соглашается;
 *  - записи чужих типов дня и удалённые.
 *
 * ЧАСЫ не трогаются вовсе. default_hours — шаблон для новых записей, а часы
 * существующей записи это факт: сколько человек отработал. Подтянуть их под
 * новый шаблон значило бы переписать журнал, а не пересчитать его.
 *
 * Патч не выпускается, если пересчёт дал те же числа (инвариант 13:
 * идемпотентность) — иначе вопрос «обновить 4 записи?» появлялся бы там, где
 * менять нечего.
 */
export function planDayTypeChange(input: DayTypeChangePlanInput): EntryDayTypePatch[] {
  const patches: EntryDayTypePatch[] = [];

  for (const entry of input.entries) {
    if (entry.deleted_at !== null) continue;
    if (entry.day_type_id !== input.dayType.id) continue;
    if (entry.date < input.periodStartISO || entry.date > input.periodEndISO) continue;
    if (entry.amount_override !== null) continue;
    // rate_is_manual исключает запись из пересчёта (инвариант 9), но у
    // pinned-типа этот флаг ставит сам этот механизм: он означает «ставка
    // отвязана от базовой», а не «человек вписал число». Различает их
    // rate_source. Без исключения тип со своей ставкой мог обновить свои
    // записи ровно один раз: следующая правка ставки молча давала ноль
    // записей к обновлению и никакого объяснения.
    if (entry.rate_is_manual && entry.rate_source !== "type_pinned") continue;

    // Дату разбираем вручную: new Date("2026-08-10") — это UTC-полночь, и на
    // положительном смещении она превращается в 10 августа только случайно
    // (инвариант 27).
    const [year, month, day] = entry.date.split("-").map(Number);
    if (!year || !month || !day) continue;
    const date = new Date(year, month - 1, day);

    const multiplierResult = resolveMultiplier(
      date,
      input.dayType,
      input.holidayByDate.get(entry.date),
      input.weekendMultipliers,
    );

    const isPinned = input.dayType.rate_mode === "pinned";
    const rate_is_manual = isPinned;
    const provisionalRate = isPinned ? (input.dayType.default_rate ?? 0) : input.period.base_rate;

    const { amount, rate_per_hour } = calculateEntryAmount(
      {
        amount_override: null,
        hours: entry.hours,
        multiplier: multiplierResult.value,
        rate_per_hour: provisionalRate,
        rate_is_manual,
      },
      input.dayType,
      input.period,
    );

    const rate_source: RateSource = isPinned ? "type_pinned" : mapRateSource(false);

    if (
      amount === entry.amount &&
      rate_per_hour === entry.rate_per_hour &&
      multiplierResult.value === entry.multiplier &&
      rate_is_manual === entry.rate_is_manual &&
      rate_source === entry.rate_source
    ) {
      continue;
    }

    patches.push({ id: entry.id, multiplier: multiplierResult.value, rate_per_hour, rate_is_manual, amount, rate_source });
  }

  return patches;
}
