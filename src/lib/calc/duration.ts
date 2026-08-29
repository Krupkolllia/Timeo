/**
 * Раздел 6.1 ТЗ. Длительность смены выводится из начала, конца и перерыва.
 *
 *     if duration_is_manual:  duration = duration_minutes
 *     else if start и end:    raw = end − start
 *                             if raw <= 0: raw += 24ч      // смена через полночь
 *                             duration = raw − break_minutes
 *     else:                   duration = default
 *
 * Всё считается в ЦЕЛЫХ МИНУТАХ, а времена разбираются вручную. Построить два
 * Date и вычесть их — это ровно тот способ, которым ломается инвариант 27
 * (сериализация через UTC) и теряется час в ночь перевода стрелок. По
 * инварианту 31 длительность — настенное время: 22:00 → 06:00 это восемь часов
 * всегда, включая ночь перевода стрелок. Разбор строки "ЧЧ:ММ" в число минут
 * не знает ни о часовых поясах, ни о календаре, и знать не должен: раздел 6.1
 * оперирует двумя моментами внутри суток, а не двумя точками на оси времени.
 *
 * Дат этот модуль не касается вовсе — в этом инвариант 29: смена с 31 августа
 * 22:00 по 1 сентября 06:00 принадлежит августу целиком, потому что период
 * записи определяет её поле date, и никакая ночная смена не может перенести
 * часы или деньги в соседний период.
 */

/** Минут в сутках. Столько добавляется смене, перешедшей через полночь. */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * "ЧЧ:ММ" → минуты от полуночи. Секунды допускаются и отбрасываются: input
 * type="time" отдаёт их, когда у поля задан step, и запись, приехавшая из
 * экспорта чужой версии, не обязана быть в нашем формате.
 *
 * Всё, что не разобралось, — null, а не 0: ноль означал бы полночь и молча
 * превратил бы мусор в осмысленную смену.
 */
export function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface DerivedDuration {
  /** Длительность в целых минутах. Никогда не отрицательная (инвариант 30). */
  minutes: number;
  /**
   * Та же длительность в десятичных часах — в этом виде она лежит в записи
   * (отступление раздела 5.4.1). НЕ округляется: 7ч20м это 440/60, и любое
   * округление часов ДО умножения на ставку теряет деньги, которые раздел 6.4
   * велит округлять ровно один раз и только на итоговой сумме за день.
   */
  hours: number;
  /**
   * Инвариант 30: перерыв длиннее смены даёт нулевую длительность и
   * предупреждение — и всё равно сохраняется. Запрета здесь нет и быть не
   * может (инвариант 54).
   */
  break_exceeds_shift: boolean;
}

/**
 * Выводит длительность из времён. null — вывести нельзя: хотя бы одно из
 * времён не задано или не разобралось, и по разделу 6.1 работает ветка
 * значения по умолчанию.
 */
export function deriveDurationFromTimes(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  breakMinutes: number | null | undefined,
): DerivedDuration | null {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  if (start === null || end === null) return null;

  // Инвариант 28: end <= start означает смену через полночь. Равенство — это
  // граничный случай, и он тоже про полные сутки: 08:00 → 08:00 это 24 часа, а
  // не ноль. Нулевую смену задают нулевой длительностью, а не совпадением
  // времён, иначе выразить суточное дежурство было бы нечем.
  let raw = end - start;
  if (raw <= 0) raw += MINUTES_PER_DAY;

  // Перерыв берётся буквально, как в формуле раздела 6.1. Отрицательный
  // перерыв смену удлиняет — раздел 9 разрешает выразить необычный случай, а
  // «починить» знак молча значит решить за человека, что он опечатался.
  // Дробный перерыв округляется до минуты: длительность — целые минуты
  // (инвариант 17), и половина минуты в поле не должна превращать её в дробь.
  const breakRaw = typeof breakMinutes === "number" && Number.isFinite(breakMinutes) ? breakMinutes : 0;
  const brk = Math.round(breakRaw);

  const minutes = raw - brk;
  if (minutes < 0) {
    return { minutes: 0, hours: 0, break_exceeds_shift: true };
  }

  // Деление на 60 — единственное место, где целые минуты становятся десятичными
  // часами. Округления здесь нет намеренно: roundHours (сотые) на 7ч20м дал бы
  // 7.33 вместо 7.3333…, то есть 219.90 zł вместо 220.00 при ставке 30 zł/ч.
  // На экране число показывает formatHours, а в базе лежит значение, из
  // которого сумма получается верной до гроша.
  return { minutes, hours: minutes / 60, break_exceeds_shift: false };
}

/** То, из чего раздел 6.1 выводит длительность записи. */
export interface DurationSource {
  start_time: string | null;
  end_time: string | null;
  break_minutes: number | null;
  duration_is_manual: boolean;
  hours: number;
}

export interface ResolvedDuration {
  hours: number;
  /** Длительность получена из времён, связь живая. */
  derived: boolean;
  /** Инвариант 30: перерыв длиннее смены. Только для выведенной длительности. */
  break_exceeds_shift: boolean;
  /**
   * Времена заданы и длительность из них вывести можно. Раздел 8.2: при
   * разорванной связи это условие показа кнопки «вернуть связь» — без времён
   * восстанавливать нечего.
   */
  can_derive: boolean;
}

/**
 * Раздел 6.1 целиком, для одной записи.
 *
 * Ветка значения по умолчанию подставляет default_hours типа дня: раздел 5.3
 * называет там default_duration_minutes, но полей времени у типа дня в коде
 * нет и в эту работу они не входят (см. 5.4.1). Подстановка задокументирована,
 * а не выбрана молча: default_hours покрывает ровно тот же случай — «тип дня
 * говорит, сколько длится такой день».
 */
export function resolveDuration(source: DurationSource, fallback: { default_hours: number }): ResolvedDuration {
  const derived = deriveDurationFromTimes(source.start_time, source.end_time, source.break_minutes);
  const can_derive = derived !== null;

  // Ручная длительность побеждает времена — это первая строка формулы 6.1 и
  // смысл самого флага. Предупреждение о перерыве при этом молчит: оно
  // объясняет ВЫВЕДЕННОЕ число, а выведенного числа здесь нет.
  if (source.duration_is_manual) {
    return { hours: source.hours, derived: false, break_exceeds_shift: false, can_derive };
  }

  if (derived) {
    return { hours: derived.hours, derived: true, break_exceeds_shift: derived.break_exceeds_shift, can_derive: true };
  }

  return { hours: fallback.default_hours, derived: false, break_exceeds_shift: false, can_derive: false };
}
