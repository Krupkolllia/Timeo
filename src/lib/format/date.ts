import { ru } from "@/i18n/ru";

/**
 * «28 августа, Пт» — заголовок шторки дня. ISO-дату пользователю не
 * показываем: конечный пользователь не разработчик (раздел 1 ТЗ).
 *
 * Лежит в lib/format, а не в lib/calc: по CLAUDE.md в lib/calc только чистый
 * расчёт без словаря и форматирования.
 */
export function formatDayTitle(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  // Неделя начинается с понедельника (раздел 5.1, week_starts_on), а getDay()
  // считает от воскресенья.
  const weekdayIndex = (new Date(year, month - 1, day).getDay() + 6) % 7;
  return `${day} ${ru.calendar.monthNamesGenitive[month - 1]}, ${ru.calendar.weekdayNamesShort[weekdayIndex]}`;
}

/** «28 авг, Пт» — строка расшифровки периода (раздел 8.3), где места вдвое меньше. */
export function formatDayShort(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const weekdayIndex = (new Date(year, month - 1, day).getDay() + 6) % 7;
  return `${day} ${ru.calendar.monthNamesShort[month - 1]}, ${ru.calendar.weekdayNamesShort[weekdayIndex]}`;
}
