/**
 * Денежные значения храним с точностью до сотых. Без этого 8 × (33.3 × 1.5)
 * оседает в Dexie как 399.59999999999997 и в таком виде показывается в поле
 * «Сумма за день» — раздел 8 ТЗ требует прозрачности, а не сырого float.
 *
 * Math.round округляет к +Infinity, поэтому −1.505 даёт −1.5, а не −1.51.
 * Для отрицательных сумм (раздел 8 их разрешает) это асимметрия на копейку;
 * оставлено намеренно как самый предсказуемый вариант. Если понадобится
 * симметрия — Math.sign(v) * Math.round(Math.abs(v) * 100) / 100.
 */
export function roundMoney(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

/**
 * Множитель — до тысячных: он может быть получен делением (ставка / базовая
 * ставка периода, см. handleRateChange), и 50 / 33.3 без округления даёт
 * 1.5015015015015014 в поле ввода.
 */
export function roundMultiplier(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
}

/** Часы — до сотых, чтобы сумма шагов по 0.5 не давала хвостов. */
export function roundHours(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}
