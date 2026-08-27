import { ru } from "@/i18n/ru";

interface MonthYearPickerProps {
  year: number;
  month: number;
  onSelect: (value: { year: number; month: number }) => void;
  onClose: () => void;
}

export function MonthYearPicker({ year, month, onSelect, onClose }: MonthYearPickerProps) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 px-6" onClick={onClose}>
      <div className="w-full max-w-xs rounded-2xl bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <button
            className="rounded-full p-2 text-white/70 active:bg-white/10"
            onClick={() => onSelect({ year: year - 1, month })}
            aria-label="Предыдущий год"
          >
            ‹
          </button>
          <span className="text-lg font-semibold">{year}</span>
          <button
            className="rounded-full p-2 text-white/70 active:bg-white/10"
            onClick={() => onSelect({ year: year + 1, month })}
            aria-label="Следующий год"
          >
            ›
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {ru.calendar.monthNames.map((name, index) => {
            const monthNumber = index + 1;
            const isSelected = monthNumber === month;
            return (
              <button
                key={name}
                onClick={() => onSelect({ year, month: monthNumber })}
                className={`rounded-lg py-2 text-sm ${
                  isSelected ? "bg-app-accent text-slate-900" : "bg-white/5 text-white active:bg-white/10"
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
