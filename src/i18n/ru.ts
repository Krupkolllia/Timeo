export const ru = {
  app: {
    name: "Timeo",
  },
  calendar: {
    title: "Календарь",
    loading: "Загрузка…",
    prevPeriod: "Предыдущий период",
    nextPeriod: "Следующий период",
    remainingToNorm: "Осталось до нормы",
    hoursShort: "ч",
    monthNames: [
      "Январь",
      "Февраль",
      "Март",
      "Апрель",
      "Май",
      "Июнь",
      "Июль",
      "Август",
      "Сентябрь",
      "Октябрь",
      "Ноябрь",
      "Декабрь",
    ],
    weekdayNamesShort: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
  },
} as const;

export type Dictionary = typeof ru;
