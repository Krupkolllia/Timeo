import { ru } from "@/i18n/ru";
import type { DayType, Entry } from "@/types/models";

/**
 * Подпись «откуда взялась ставка» (раздел 5.4, rate_source). Показывается
 * только там, где число вышло не из базовой ставки периода: для обычной записи
 * «ставка периода» ничего не объясняет.
 */
export function rateNote(entry: Pick<Entry, "amount_override" | "rate_source" | "rate_is_manual">): string | null {
  if (entry.amount_override !== null) return ru.period.amountOverridden;
  if (entry.rate_source === "frozen") return ru.period.rateSourceFrozen;
  // Проверка обязана стоять ДО rate_is_manual: у записи типа с закрытым замком
  // оба поля выставлены разом (rate_is_manual означает «ставка отвязана от
  // базовой»), и «ставка вручную» на числе из шаблона — прямая неправда на том
  // самом экране, который по разделу 9 обязан объяснять числа.
  if (entry.rate_source === "type_pinned") return ru.period.rateSourcePinned;
  if (entry.rate_is_manual) return ru.period.rateSourceManual;
  return null;
}

/**
 * Из чего сложилась сумма строки — для расшифровки периода (раздел 8.3) и для
 * закрытого дня, который показывается только на чтение.
 *
 * Для unpaid и fixed_amount произведение «часы × ставка» к сумме отношения не
 * имеет (раздел 6.4: сумма берётся из типа дня либо равна нулю), и печатать
 * «0ч × 50.00 → 0.00» — прямая ложь на том самом экране, который по разделу 9
 * обязан объяснять числа.
 *
 * Живёт в lib/format, а не в lib/calc: по CLAUDE.md в lib/calc нет ни словаря,
 * ни форматирования.
 */
export function formatEntryDetail(
  entry: Pick<Entry, "hours" | "rate_per_hour" | "multiplier" | "amount_override" | "rate_source" | "rate_is_manual">,
  payMode: DayType["pay_mode"] | undefined,
): string {
  const hours = `${entry.hours}${ru.calendar.hoursShort}`;
  const parts =
    payMode === "unpaid"
      ? [hours, ru.period.payModeUnpaid]
      : payMode === "fixed_amount"
        ? [hours, ru.day.payModeFixedAmount]
        : [`${hours} × ${entry.rate_per_hour.toFixed(2)}`, `×${entry.multiplier}`];

  const note = rateNote(entry);
  if (note) parts.push(note);
  return parts.join(" · ");
}
