/**
 * Значок типа дня (раздел 5.3) — 1–3 символа. Функция нужна в двух местах:
 * при миграции version(6), где значок выводится из имени для уже существующих
 * типов, и в форме, где он подставляется по мере набора имени, пока
 * пользователь не задал свой.
 *
 * Пустая строка запрещена: раздел 8.2 рисует значок цветным кружком на ячейке
 * календаря, и пустой кружок — это регрессия, а не «нейтральное значение».
 */
export const DAY_TYPE_LABEL_MAX = 3;
const FALLBACK_LABEL = "•";

export function deriveDayTypeLabel(name: string): string {
  // Array.from, а не name[0]: имя может начинаться с эмодзи, и взятие одного
  // элемента строки разрезало бы суррогатную пару пополам.
  const first = Array.from(name.trim())[0];
  if (first === undefined) return FALLBACK_LABEL;
  // toLocaleUpperCase("ru"): у турецкого i заглавная форма зависит от локали,
  // и брать её из локали устройства значило бы получить разный значок на
  // разных телефонах для одного и того же имени.
  return first.toLocaleUpperCase("ru");
}

/**
 * Обрезка пользовательского ввода до трёх символов — снова по элементам, а не
 * по code units: три эмодзи это шесть code units, и slice(0, 3) оставил бы
 * полтора эмодзи.
 */
export function clampDayTypeLabel(value: string): string {
  return Array.from(value).slice(0, DAY_TYPE_LABEL_MAX).join("");
}
