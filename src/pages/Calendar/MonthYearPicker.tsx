import { useState } from "react";
import { ru } from "@/i18n/ru";

interface MonthYearPickerProps {
  year: number;
  month: number;
  onSelect: (value: { year: number; month: number }) => void;
  onClose: () => void;
}

export function MonthYearPicker({ year, month, onSelect, onClose }: MonthYearPickerProps) {
  // The year is paged through inside the picker and only confirmed by tapping a month —
  // otherwise the year arrows would immediately close the picker and switch the period.
  const [displayYear, setDisplayYear] = useState(year);

  return (
    // z-30, как у шторки дня: на z-20 выбор месяца стоял вровень с панелью
    // итогов и оказывался поверх неё лишь по порядку в разметке — тот же
    // недосмотр, из-за которого панель накрывала кнопку «Закрыть».
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-app-scrim/60 px-6" onClick={onClose}>
      <div className="w-full max-w-xs rounded-2xl bg-app-surface p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <button
            className="rounded-full p-2 text-app-fg/70 active:bg-app-fg/10"
            onClick={() => setDisplayYear((y) => y - 1)}
            aria-label={ru.calendar.prevYear}
          >
            ‹
          </button>
          <span className="text-lg font-semibold">{displayYear}</span>
          <button
            className="rounded-full p-2 text-app-fg/70 active:bg-app-fg/10"
            onClick={() => setDisplayYear((y) => y + 1)}
            aria-label={ru.calendar.nextYear}
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {ru.calendar.monthNames.map((name, index) => {
            const monthNumber = index + 1;
            const isSelected = monthNumber === month && displayYear === year;
            return (
              <button
                key={name}
                onClick={() => onSelect({ year: displayYear, month: monthNumber })}
                className={`rounded-lg py-2 text-sm ${
                  isSelected ? "bg-app-accent text-app-accent-fg" : "bg-app-fg/5 text-app-fg active:bg-app-fg/10"
                }`}
              >
                {name.slice(0, 3)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
