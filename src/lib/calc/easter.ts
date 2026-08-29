/**
 * Пасха по григорианскому календарю — «анонимный» алгоритм Гаусса—Мея.
 * Чистая арифметика над числами, никаких Date: раздел 5.5 требует четыре
 * подвижных праздника в году, а всё остальное в блоке 5 отсчитывается от этой
 * даты.
 *
 * Возвращает год, месяц (1–12) и день, а не Date и не строку: месяц у Пасхи
 * бывает и мартовский (2024 — 31 марта), и апрельский, и складывать к ней
 * дни удобнее уже на уровне календаря.
 */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export function easterSunday(year: number): CalendarDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}
