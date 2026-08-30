/**
 * Раздел 6.1 ТЗ. Длительность смены выводится из начала, конца и перерыва.
 *
 *     if duration_is_manual:  duration = duration_minutes
 *     else if start и end:    total       = end − start
 *                             if total <= 0: total += 24ч      // смена через полночь
 *                             break       = break_minutes
 *                             paid_break  = paid_break_minutes
 *                             duration    = total − (break − paid_break)
 *     else:                   duration = default
 *
 * paid_break_minutes — новое понятие, которого не было в исходном ТЗ (согласовано
 * отдельно): сколько минут перерыва оплачивается. 0 воспроизводит поведение до этой
 * работы (перерыв целиком неоплачиваемый); значение, равное break, — перерыв
 * оплачивается целиком; любое промежуточное — частично.
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

function roundedOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

export interface DerivedDuration {
  /** Оплачиваемые (отработанные) минуты. Никогда не отрицательные (инвариант 30). */
  minutes: number;
  /**
   * Та же длительность в десятичных часах — в этом виде она лежит в записи
   * (отступление раздела 5.4.1). НЕ округляется: 7ч20м это 440/60, и любое
   * округление часов ДО умножения на ставку теряет деньги, которые раздел 6.4
   * велит округлять ровно один раз и только на итоговой сумме за день.
   */
  hours: number;
  /** Полное время смены (end − start, с поправкой на полночь), целые минуты. */
  totalMinutes: number;
  /**
   * Инвариант 30, обобщённый на оплачиваемый перерыв: НЕОПЛАЧИВАЕМАЯ часть
   * перерыва длиннее смены, то есть total − (break − paid_break) < 0.
   * При paid_break = 0 это в точности старое условие «перерыв длиннее смены».
   * Даёт нулевую длительность и предупреждение, и всё равно сохраняется —
   * запрета здесь нет и быть не может (инвариант 54).
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
  paidBreakMinutes?: number | null | undefined,
): DerivedDuration | null {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  if (start === null || end === null) return null;

  // Инвариант 28: end <= start означает смену через полночь. Равенство — это
  // граничный случай, и он тоже про полные сутки: 08:00 → 08:00 это 24 часа, а
  // не ноль. Нулевую смену задают нулевой длительностью, а не совпадением
  // времён, иначе выразить суточное дежурство было бы нечем.
  let totalMinutes = end - start;
  if (totalMinutes <= 0) totalMinutes += MINUTES_PER_DAY;

  // Перерыв и его оплачиваемая часть берутся буквально, как в формуле раздела
  // 6.1. Отрицательный перерыв смену удлиняет, а paid_break больше break
  // добавляет оплачиваемое время сверх перерыва — раздел 9 разрешает выразить
  // необычный случай, а «починить» знак или порядок молча значит решить за
  // человека, что он опечатался (инвариант 54). Дробные значения округляются
  // до минуты: длительность — целые минуты (инвариант 17).
  const brk = roundedOrZero(breakMinutes);
  const paidBrk = roundedOrZero(paidBreakMinutes);
  const unpaidBreak = brk - paidBrk;

  const minutes = totalMinutes - unpaidBreak;
  if (minutes < 0) {
    return { minutes: 0, hours: 0, totalMinutes, break_exceeds_shift: true };
  }

  // Деление на 60 — единственное место, где целые минуты становятся десятичными
  // часами. Округления здесь нет намеренно: roundHours (сотые) на 7ч20м дал бы
  // 7.33 вместо 7.3333…, то есть 219.90 zł вместо 220.00 при ставке 30 zł/ч.
  // На экране число показывает formatHours, а в базе лежит значение, из
  // которого сумма получается верной до гроша.
  return { minutes, hours: minutes / 60, totalMinutes, break_exceeds_shift: false };
}

/** То, из чего раздел 6.1 выводит длительность записи. */
export interface DurationSource {
  start_time: string | null;
  end_time: string | null;
  break_minutes: number | null;
  paid_break_minutes: number | null;
  duration_is_manual: boolean;
  hours: number;
}

export interface ResolvedDuration {
  /** Оплачиваемые (отработанные) часы — то, что пишется в entry.hours. */
  hours: number;
  /**
   * Полное время смены в минутах, для отображения (раздел 8.2: три числа —
   * общее время, отработанные часы, перерыв). Когда время выводится из
   * start/end, это буквально end − start. Когда длительность вписана вручную
   * или взята из значения по умолчанию, число получается алгебраически —
   * hours×60 + break − paid_break, — что то же самое тождество формулы 6.1,
   * решённое относительно total. Нигде не хранится отдельным полем: всегда
   * пересчитывается из того, что уже лежит в записи.
   */
  totalMinutes: number;
  breakMinutes: number;
  paidBreakMinutes: number;
  /** Длительность получена из времён, связь живая. */
  derived: boolean;
  /** Инвариант 30 (обобщённый, см. DerivedDuration.break_exceeds_shift). */
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
 * называет там default_duration_minutes, но отдельного поля с этим именем в
 * коде нет — default_hours покрывает тот же случай («тип дня говорит, сколько
 * длится такой день») и остаётся постоянной заменой, а не временным долгом
 * (см. 5.4.1).
 */
export function resolveDuration(source: DurationSource, fallback: { default_hours: number }): ResolvedDuration {
  const derived = deriveDurationFromTimes(
    source.start_time,
    source.end_time,
    source.break_minutes,
    source.paid_break_minutes,
  );
  const can_derive = derived !== null;
  const breakMinutes = roundedOrZero(source.break_minutes);
  const paidBreakMinutes = roundedOrZero(source.paid_break_minutes);

  // Ручная длительность побеждает времена — это первая строка формулы 6.1 и
  // смысл самого флага. Предупреждение о перерыве при этом молчит: оно
  // объясняет ВЫВЕДЕННОЕ число, а выведенного числа здесь нет. "Общее время"
  // при этом всё равно показывается — алгебраически, из вписанных вручную
  // часов и перерыва, чтобы три числа на экране всегда были согласованы
  // между собой.
  if (source.duration_is_manual) {
    const totalMinutes = Math.max(0, Math.round(source.hours * 60) + breakMinutes - paidBreakMinutes);
    return {
      hours: source.hours,
      totalMinutes,
      breakMinutes,
      paidBreakMinutes,
      derived: false,
      break_exceeds_shift: false,
      can_derive,
    };
  }

  if (derived) {
    return {
      hours: derived.hours,
      totalMinutes: derived.totalMinutes,
      breakMinutes,
      paidBreakMinutes,
      derived: true,
      break_exceeds_shift: derived.break_exceeds_shift,
      can_derive: true,
    };
  }

  // Без времён у перерыва нет часового пояса, к которому его можно привязать:
  // "общее время" в этой ветке — не более чем default_hours типа дня, а не
  // default_hours плюс произвольно вписанный (без начала и конца) перерыв.
  // Иначе набранные вручную минуты перерыва без единого времени раздували бы
  // «Общее время смены» числом, которое не соответствует никакой реальной
  // смене, — часы (единственное, что реально попадёт в базу) при этом не
  // меняются вовсе.
  return {
    hours: fallback.default_hours,
    totalMinutes: Math.round(fallback.default_hours * 60),
    breakMinutes,
    paidBreakMinutes,
    derived: false,
    break_exceeds_shift: false,
    can_derive: false,
  };
}

/**
 * Общее время смены уже СОХРАНЁННОЙ записи, для итогов периода (раздел 6.5) и
 * расшифровки. Считается только по полям самой записи — hours, break_minutes,
 * paid_break_minutes, — без обращения к типу дня и без ветки «по умолчанию»:
 * hours записи уже заморожен (инвариант 10), и пересчитывать его через ЖИВОЙ
 * default_hours типа дня значило бы дать сохранённой строке поплыть, если тип
 * дня потом поменяют. Тождественно ResolvedDuration.totalMinutes на той же
 * записи, но без необходимости в fallback.default_hours.
 */
export function totalShiftMinutesOf(entry: {
  hours: number;
  break_minutes: number | null;
  paid_break_minutes: number | null;
}): number {
  const breakMinutes = roundedOrZero(entry.break_minutes);
  const paidBreakMinutes = roundedOrZero(entry.paid_break_minutes);
  return Math.max(0, Math.round(entry.hours * 60) + breakMinutes - paidBreakMinutes);
}
