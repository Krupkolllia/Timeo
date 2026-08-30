import { describe, expect, it } from "vitest";
import {
  MINUTES_PER_DAY,
  deriveDurationFromTimes,
  parseTimeToMinutes,
  resolveDuration,
  totalShiftMinutesOf,
} from "@/lib/calc/duration";
import { roundMoney } from "@/lib/calc/round";

describe("parseTimeToMinutes", () => {
  it.each([
    ["00:00", 0],
    ["00:01", 1],
    ["08:00", 480],
    ["08:30", 510],
    ["22:00", 1320],
    ["23:59", 1439],
    // Однозначный час: input type="time" его не отдаёт, но файл экспорта чужой
    // версии не обязан быть в нашем формате.
    ["8:00", 480],
    // Секунды отдаёт input type="time" со step — отбрасываем их.
    ["08:00:00", 480],
    ["08:30:59.500", 510],
    [" 08:00 ", 480],
  ])("разбирает %s", (value, expected) => {
    expect(parseTimeToMinutes(value)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["  "],
    ["24:00"],
    ["08:60"],
    ["25:00"],
    ["8"],
    ["08-00"],
    ["восемь"],
    ["08:0"],
    ["0800"],
    ["2026-08-10T08:00"],
  ])("не разбирает %s", (value) => {
    // null, а не 0: ноль означал бы полночь и молча превратил бы мусор в смену.
    expect(parseTimeToMinutes(value as string | null | undefined)).toBeNull();
  });
});

describe("deriveDurationFromTimes — раздел 6.1", () => {
  it.each([
    // [начало, конец, перерыв, минут, комментарий]
    ["08:00", "16:00", null, 480, "обычная дневная смена"],
    ["08:00", "16:00", 30, 450, "с получасовым перерывом"],
    ["08:00", "16:00", 0, 480, "нулевой перерыв"],
    // Инвариант 28 и 31: смена через полночь — плюс 24 часа, и это настенное
    // время, а не разница двух моментов на оси времени.
    ["22:00", "06:00", null, 480, "через полночь"],
    ["22:00", "06:00", 30, 450, "через полночь с перерывом"],
    ["23:59", "00:00", null, 1, "через полночь на одну минуту"],
    ["00:00", "00:01", null, 1, "минута после полуночи"],
    // Инвариант 28, граничный случай: равные времена — это полные сутки, а не
    // ноль. Нулевую смену задают нулевой длительностью.
    ["08:00", "08:00", null, MINUTES_PER_DAY, "равные времена — сутки"],
    ["00:00", "00:00", null, MINUTES_PER_DAY, "полночь в полночь — сутки"],
    ["08:00", "08:00", 60, MINUTES_PER_DAY - 60, "сутки минус перерыв"],
    // Инвариант 32: больше 24 часов допускается (мягкое предупреждение — дело
    // экрана, не формулы).
    ["22:00", "06:00", -60, 540, "отрицательный перерыв удлиняет смену"],
    // Минуты, не кратные шестидесяти: ради них всё и считается в целых минутах.
    ["07:45", "16:10", 20, 485, "7ч45 → 16ч10 минус 20 минут"],
    ["08:00", "15:20", null, 440, "7 часов 20 минут"],
    // Дробный перерыв округляется до минуты: длительность — целые минуты.
    ["08:00", "16:00", 30.4, 450, "дробный перерыв округляется вниз"],
    ["08:00", "16:00", 30.6, 449, "дробный перерыв округляется вверх"],
  ])("%s → %s (перерыв %s): %s минут — %s", (start, end, brk, expected, _case) => {
    const result = deriveDurationFromTimes(start as string, end as string, brk as number | null);
    expect(result).not.toBeNull();
    expect(result?.minutes).toBe(expected as number);
    expect(result?.break_exceeds_shift).toBe(false);
  });

  it("минуты переводятся в часы делением на 60 и НЕ округляются", () => {
    // Округление до сотых дало бы 7.33 и потеряло бы деньги: см. следующий тест.
    expect(deriveDurationFromTimes("08:00", "15:20", null)?.hours).toBe(440 / 60);
    expect(deriveDurationFromTimes("08:00", "16:00", null)?.hours).toBe(8);
    expect(deriveDurationFromTimes("08:00", "16:00", 30)?.hours).toBe(7.5);
  });

  it("сумма за смену 7ч20м сходится до гроша", () => {
    // Раздел 6.4: округление до гроша происходит один раз, на итоговом
    // произведении. При округлении часов до сотых (7.33) здесь получилось бы
    // 219.90 — десять грошей, исчезнувших ни на чём.
    const derived = deriveDurationFromTimes("08:00", "15:20", null);
    expect(roundMoney((derived?.hours ?? 0) * 30 * 1)).toBe(220);
    // То же произведение, посчитанное прямо из целых минут.
    expect(roundMoney((derived?.hours ?? 0) * 30)).toBe(roundMoney((440 * 30) / 60));
  });

  /**
   * Точная десятичная сумма за смену, посчитанная на целых числах: минуты —
   * целые, ставка хранится с точностью до сотых гроша (4 знака, инвариант 16),
   * множитель — до шести знаков. Это тот самый BigDecimal, которого в JS нет:
   * ни одного промежуточного double, поэтому эталон не зависит от порядка
   * умножений.
   *
   * Округление half-up к +Infinity — как Math.round в roundMoney. Деление
   * BigInt отбрасывает дробную часть в сторону нуля, поэтому эталон верен для
   * неотрицательных сумм; отрицательные ставки (инвариант 24) здесь не
   * проверяются.
   */
  function exactAmount(minutes: number, rate: number, multiplier: number): number {
    const numerator = BigInt(minutes) * BigInt(Math.round(rate * 10_000)) * BigInt(Math.round(multiplier * 1_000_000));
    // Приводим к грошам: /60 минут, /10^4 ставки, /10^6 множителя, ×100 грошей.
    const denominator = 60n * 10_000n * 1_000_000n;
    const grosze = (2n * numerator * 100n + denominator) / (2n * denominator);
    return Number(grosze) / 100;
  }

  it.each([
    [1, 33.33, 1],
    // Ровно тот случай, ради которого длительность не округляется: точная
    // сумма равна 1.025, то есть попадает на границу округления гроша.
    [50, 1.23, 1],
    [440, 30, 1],
    [440, 33.33, 1.5],
    [485, 27.77, 2],
    [1000, 19.99, 1.25],
    [7, 100, 3],
    [23, 0.07, 6],
    [1439, 41.11, 1.5],
  ])("длительность %s минут при ставке %s и множителе %s даёт точную сумму", (minutes, rate, multiplier) => {
    // Каждый случай — реальная смена: начало 00:00, конец через N минут.
    const end = `${String(Math.floor((minutes % MINUTES_PER_DAY) / 60)).padStart(2, "0")}:${String(
      minutes % 60,
    ).padStart(2, "0")}`;
    const derived = deriveDurationFromTimes("00:00", end, null);
    expect(derived?.minutes).toBe(minutes);
    expect(roundMoney(derived!.hours * rate * multiplier)).toBe(exactAmount(minutes, rate, multiplier));
  });

  it("округление длительности до сотых часа теряло бы гроши", () => {
    // Контрпример к соблазну хранить roundHours(minutes / 60): именно он и
    // стоил бы человеку денег. 440 минут — это 7.3333…, а не 7.33.
    const derived = deriveDurationFromTimes("08:00", "15:20", null);
    expect(roundMoney(derived!.hours * 30)).toBe(220);
    const roundedToHundredths = Math.round((440 / 60) * 100) / 100;
    expect(roundedToHundredths).toBe(7.33);
    expect(roundMoney(roundedToHundredths * 30)).toBe(219.9);
  });

  it("инвариант 30: перерыв длиннее смены даёт ноль и предупреждение", () => {
    const result = deriveDurationFromTimes("08:00", "16:00", 600);
    expect(result).toEqual({ minutes: 0, hours: 0, totalMinutes: 480, break_exceeds_shift: true });
  });

  it("перерыв ровно в длину смены даёт ноль без предупреждения", () => {
    // Инвариант 25: нулевая длительность законна. Предупреждать не о чем —
    // инвариант 30 говорит именно про перерыв ДЛИННЕЕ смены.
    expect(deriveDurationFromTimes("08:00", "16:00", 480)).toEqual({
      minutes: 0,
      hours: 0,
      totalMinutes: 480,
      break_exceeds_shift: false,
    });
  });

  it.each([
    [null, "16:00"],
    ["08:00", null],
    [null, null],
    ["", "16:00"],
    ["мусор", "16:00"],
    ["08:00", "24:30"],
  ])("без пары разобранных времён вывести нельзя: %s / %s", (start, end) => {
    expect(deriveDurationFromTimes(start, end, 30)).toBeNull();
  });

  it("нечисловой перерыв считается нулевым, а не превращает смену в NaN", () => {
    expect(deriveDurationFromTimes("08:00", "16:00", NaN)?.minutes).toBe(480);
    expect(deriveDurationFromTimes("08:00", "16:00", undefined)?.minutes).toBe(480);
    expect(deriveDurationFromTimes("08:00", "16:00", Infinity)?.minutes).toBe(480);
  });

  it("не трогает даты вовсе (инвариант 29)", () => {
    // Смена с 31 августа 22:00 по 1 сентября 06:00 — восемь часов, и ни один
    // из входов функции не знает, какое это число. Перенести часы в соседний
    // период здесь физически нечем: период записи решает её поле date.
    expect(deriveDurationFromTimes("22:00", "06:00", null)?.minutes).toBe(480);
    expect(Object.keys(deriveDurationFromTimes("22:00", "06:00", null) ?? {})).toEqual([
      "minutes",
      "hours",
      "totalMinutes",
      "break_exceeds_shift",
    ]);
  });

  it("инвариант 31: длительность — настенное время, перевод стрелок не влияет", () => {
    // Функция вообще не принимает даты, поэтому ночь перевода стрелок ничем не
    // отличается от любой другой: 22:00 → 06:00 это восемь часов всегда.
    // Утверждение структурное — подставить дату сюда физически некуда.
    expect(deriveDurationFromTimes.length).toBe(4);
    expect(deriveDurationFromTimes("22:00", "06:00", null)?.minutes).toBe(480);

    // Для сравнения: расчёт через Date в поясе с переводом стрелок даёт 420 или
    // 540 минут вместо 480 — ровно тот час необъяснимой разницы дважды в год,
    // от которого раздел 6.1 и отказывается.
    const viaDate = (date: Date, hours: number) => new Date(date.getTime() + hours * 3600_000);
    const nightStart = new Date(2026, 9, 25, 22, 0);
    const wallClockHours = (viaDate(nightStart, 8).getHours() - nightStart.getHours() + 24) % 24;
    // В поясе без перевода стрелок это те же 8 часов, и утверждать нечего.
    expect([7, 8, 9]).toContain(wallClockHours);
  });

  describe("оплачиваемый перерыв (новое понятие, согласовано отдельно)", () => {
    it("paid_break отсутствует или 0 — то же самое, что и раньше", () => {
      expect(deriveDurationFromTimes("08:00", "16:00", 60, 0)?.minutes).toBe(420);
      expect(deriveDurationFromTimes("08:00", "16:00", 60, null)?.minutes).toBe(420);
      expect(deriveDurationFromTimes("08:00", "16:00", 60, undefined)?.minutes).toBe(420);
    });

    it("перерыв оплачивается частично: worked = total − (break − paid_break)", () => {
      const result = deriveDurationFromTimes("08:00", "16:00", 60, 20);
      // total 480, break 60, paid 20 → неоплачиваемая часть 40 → 440.
      expect(result).toEqual({ minutes: 440, hours: 440 / 60, totalMinutes: 480, break_exceeds_shift: false });
    });

    it("перерыв оплачивается целиком: рабочее время равно общему времени смены", () => {
      const result = deriveDurationFromTimes("08:00", "16:00", 60, 60);
      expect(result).toEqual({ minutes: 480, hours: 8, totalMinutes: 480, break_exceeds_shift: false });
    });

    it("paid_break > break — оплачено больше, чем длился перерыв: не запрещено (инвариант 54)", () => {
      // Неоплачиваемая часть становится отрицательной (30−90=−60) и УДЛИНЯЕТ
      // рабочее время сверх общего — та же алгебра, что и у отрицательного
      // break_minutes, только с другой стороны формулы: 480−(−60)=540.
      const result = deriveDurationFromTimes("08:00", "16:00", 30, 90);
      expect(result).toEqual({ minutes: 540, hours: 540 / 60, totalMinutes: 480, break_exceeds_shift: false });
    });

    it("инвариант 30 обобщённый: неоплачиваемая часть перерыва длиннее смены", () => {
      // break 600, paid 100 → неоплаченная часть 500 > total 480 → ноль.
      // При paid_break=0 это в точности старое условие «перерыв длиннее смены».
      const result = deriveDurationFromTimes("08:00", "16:00", 600, 100);
      expect(result).toEqual({ minutes: 0, hours: 0, totalMinutes: 480, break_exceeds_shift: true });
    });

    it("отрицательный paid_break увеличивает неоплачиваемую часть перерыва", () => {
      const result = deriveDurationFromTimes("08:00", "16:00", 60, -30);
      // Неоплачиваемая часть 60-(-30)=90 → 480-90=390.
      expect(result?.minutes).toBe(390);
    });

    it("дробный paid_break округляется до минуты, как и break", () => {
      // round(20.4)=20 → неоплаченная часть 60-20=40 → 480-40=440.
      expect(deriveDurationFromTimes("08:00", "16:00", 60, 20.4)?.minutes).toBe(440);
      // round(20.6)=21 → неоплаченная часть 60-21=39 → 480-39=441.
      expect(deriveDurationFromTimes("08:00", "16:00", 60, 20.6)?.minutes).toBe(441);
    });
  });
});

describe("resolveDuration — раздел 6.1 целиком", () => {
  const fallback = { default_hours: 8 };
  const base = {
    start_time: null,
    end_time: null,
    break_minutes: null,
    paid_break_minutes: null,
    duration_is_manual: false,
    hours: 0,
  };

  it("ручная длительность побеждает времена", () => {
    expect(
      resolveDuration(
        { ...base, start_time: "08:00", end_time: "16:00", duration_is_manual: true, hours: 5 },
        fallback,
      ),
    ).toEqual({
      hours: 5,
      totalMinutes: 300,
      breakMinutes: 0,
      paidBreakMinutes: 0,
      derived: false,
      break_exceeds_shift: false,
      can_derive: true,
    });
  });

  it("при ручной длительности предупреждение о перерыве молчит", () => {
    // Оно объясняет ВЫВЕДЕННОЕ число, а выведенного числа здесь нет.
    expect(
      resolveDuration(
        {
          ...base,
          start_time: "08:00",
          end_time: "16:00",
          break_minutes: 600,
          duration_is_manual: true,
          hours: 5,
        },
        fallback,
      ),
    ).toEqual({
      hours: 5,
      // Алгебраически: 5×60 + 600 − 0 = 900, но общее время смены не может
      // получиться отрицательным — здесь оно просто больше вписанных часов,
      // потому что перерыв сам по себе огромный. Формула не занижает его.
      totalMinutes: 900,
      breakMinutes: 600,
      paidBreakMinutes: 0,
      derived: false,
      break_exceeds_shift: false,
      can_derive: true,
    });
  });

  it("живая связь и заданные времена — длительность выводится", () => {
    expect(resolveDuration({ ...base, start_time: "22:00", end_time: "06:00", break_minutes: 30 }, fallback)).toEqual({
      hours: 7.5,
      totalMinutes: 480,
      breakMinutes: 30,
      paidBreakMinutes: 0,
      derived: true,
      break_exceeds_shift: false,
      can_derive: true,
    });
  });

  it("живая связь и оплачиваемый перерыв — тоже выводится", () => {
    expect(
      resolveDuration(
        { ...base, start_time: "22:00", end_time: "06:00", break_minutes: 30, paid_break_minutes: 30 },
        fallback,
      ),
    ).toEqual({
      hours: 8,
      totalMinutes: 480,
      breakMinutes: 30,
      paidBreakMinutes: 30,
      derived: true,
      break_exceeds_shift: false,
      can_derive: true,
    });
  });

  it("живая связь без времён — значение по умолчанию типа дня", () => {
    expect(resolveDuration({ ...base, hours: 3 }, { default_hours: 12 })).toEqual({
      hours: 12,
      totalMinutes: 720,
      breakMinutes: 0,
      paidBreakMinutes: 0,
      derived: false,
      break_exceeds_shift: false,
      can_derive: false,
    });
  });

  it("перерыв без единого времени не раздувает общее время смены (нечего привязать ко времени)", () => {
    // Без start/end перерыву не с чем связать реальный час — раздутое "общее
    // время" здесь было бы числом, не отвечающим ни одной настоящей смене.
    // Часы (то, что реально уходит в базу) при этом не сдвигаются: hours
    // остаётся default_hours типа дня, ровно как без перерыва вовсе.
    const result = resolveDuration({ ...base, break_minutes: 120, hours: 3 }, { default_hours: 8 });
    expect(result.hours).toBe(8);
    expect(result.totalMinutes).toBe(480);
    expect(result.breakMinutes).toBe(120);
  });

  it("живая связь и только одно время — тоже значение по умолчанию", () => {
    expect(resolveDuration({ ...base, start_time: "08:00", hours: 3 }, fallback)).toEqual({
      hours: 8,
      totalMinutes: 480,
      breakMinutes: 0,
      paidBreakMinutes: 0,
      derived: false,
      break_exceeds_shift: false,
      can_derive: false,
    });
  });

  it("ручная длительность без времён: восстанавливать нечего", () => {
    expect(resolveDuration({ ...base, duration_is_manual: true, hours: 3 }, fallback)).toEqual({
      hours: 3,
      totalMinutes: 180,
      breakMinutes: 0,
      paidBreakMinutes: 0,
      derived: false,
      break_exceeds_shift: false,
      can_derive: false,
    });
  });

  it("выведенная длительность идемпотентна (инвариант 13)", () => {
    const source = { ...base, start_time: "07:45", end_time: "16:10", break_minutes: 20 };
    const once = resolveDuration(source, fallback);
    const twice = resolveDuration({ ...source, hours: once.hours }, fallback);
    expect(twice).toEqual(once);
  });
});

describe("totalShiftMinutesOf — раздел 6.5, для СОХРАНЁННОЙ записи", () => {
  it("воспроизводит общее время смены из hours/break/paid_break без обращения к типу дня", () => {
    // 7ч30м оплачиваемых + 30 минут неоплаченного перерыва (60 - 30 paid) = 8ч.
    expect(totalShiftMinutesOf({ hours: 7.5, break_minutes: 60, paid_break_minutes: 30 })).toBe(480);
  });

  it("null-поля считаются нулём — миграция version(9) для старых записей", () => {
    expect(totalShiftMinutesOf({ hours: 8, break_minutes: null, paid_break_minutes: null })).toBe(480);
  });

  it("не зависит от текущего дня типа (инвариант 10): считает только по своим полям", () => {
    // Никакого dayType-параметра в сигнатуре нет вовсе — значение не может
    // поплыть, если шаблон потом изменят.
    expect(totalShiftMinutesOf.length).toBe(1);
  });
});
