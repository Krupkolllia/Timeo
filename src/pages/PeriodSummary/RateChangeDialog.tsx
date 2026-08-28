import { useState } from "react";
import { ru } from "@/i18n/ru";
import type { RateChangeMode } from "@/types/models";

interface RateChangeDialogProps {
  currentRate: number;
  newRate: number;
  currency: string;
  /** Запомненный ответ (settings.preferred_rate_change_mode) — предвыбран, но диалог показывается всегда. */
  preferredMode: RateChangeMode | null;
  periodStartISO: string;
  periodEndISO: string;
  todayISO: string;
  /** Подпись следующего периода — режим «со следующего» обязан назвать, куда именно уйдёт ставка. */
  nextPeriodLabel: string;
  /** Следующий период уже создан: настройка его не перепишет, об этом надо сказать прямо. */
  nextPeriodExists: boolean;
  onCancel: () => void;
  onApply: (mode: RateChangeMode, fromDateISO: string | null) => void;
}

const MODES: RateChangeMode[] = ["recalculate_period", "apply_from_date", "apply_next_period"];

function modeLabel(mode: RateChangeMode, nextPeriodLabel: string, nextPeriodExists: boolean) {
  switch (mode) {
    case "recalculate_period":
      return { title: ru.period.modeRecalculate, hint: ru.period.modeRecalculateHint, warning: null };
    case "apply_from_date":
      return { title: ru.period.modeFromDate, hint: ru.period.modeFromDateHint, warning: null };
    case "apply_next_period":
      return {
        title: ru.period.modeNextPeriod,
        hint: `${ru.period.modeNextPeriodHint} ${nextPeriodLabel}`,
        warning: nextPeriodExists ? ru.period.modeNextPeriodHintExists : null,
      };
  }
}

/**
 * Раздел 6.6 ТЗ. Диалог показывается при каждой смене базовой ставки, даже
 * когда ответ уже запомнен: три режима дают три разных результата в платёжном
 * журнале, и «как в прошлый раз» — не то решение, которое можно принять за
 * пользователя молча.
 */
export function RateChangeDialog({
  currentRate,
  newRate,
  currency,
  preferredMode,
  periodStartISO,
  periodEndISO,
  todayISO,
  nextPeriodLabel,
  nextPeriodExists,
  onCancel,
  onApply,
}: RateChangeDialogProps) {
  const [mode, setMode] = useState<RateChangeMode>(preferredMode ?? "recalculate_period");
  // Сегодня, если оно внутри периода: смена ставки почти всегда идёт «с этого
  // дня», а не с начала месяца. Иначе — начало периода.
  const [fromDate, setFromDate] = useState(
    todayISO >= periodStartISO && todayISO <= periodEndISO ? todayISO : periodStartISO,
  );

  return (
    <div className="day-sheet-overlay fixed inset-0 z-40 flex items-end bg-black/50" onClick={onCancel}>
      <div
        className="day-sheet flex w-full flex-col gap-3 overflow-y-auto rounded-t-2xl bg-slate-900 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] text-white"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-white/20" />
        <p className="text-base font-semibold">{ru.period.rateDialogTitle}</p>
        {/* Обе цифры рядом: без «было» новое число не с чем сравнить, а решение
            принимается именно по разнице. */}
        <p className="text-sm text-white/50">
          {currentRate.toFixed(2)} → {newRate.toFixed(2)} {currency}
        </p>

        {MODES.map((item) => {
          const { title, hint, warning } = modeLabel(item, nextPeriodLabel, nextPeriodExists);
          const selected = mode === item;
          return (
            <button
              key={item}
              onClick={() => setMode(item)}
              aria-pressed={selected}
              className={`rounded-xl px-3 py-3 text-left ${selected ? "bg-white/15" : "bg-white/5 active:bg-white/10"}`}
            >
              <span className="block text-sm font-medium">{title}</span>
              <span className="mt-0.5 block text-xs text-white/40">{hint}</span>
              {/* Предупреждение серым и без запрета — раздел 9: режим остаётся
                  выбираемым, просто честно сказано, что он сделает. */}
              {warning && <span className="mt-1 block text-xs text-white/60">{warning}</span>}
            </button>
          );
        })}

        {mode === "apply_from_date" && (
          <div>
            <label className="text-xs text-white/50" htmlFor="rate-change-from-date">
              {ru.period.fromDate}
            </label>
            {/* min/max ограничивают параметр операции, а не поле данных: раздел 9
                запрещает блокировать сохранение введённых значений, а дата вне
                периода просто не описывает ни одной записи — планировщик всё
                равно отфильтрует её по границам периода. */}
            <input
              id="rate-change-from-date"
              type="date"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2"
              value={fromDate}
              min={periodStartISO}
              max={periodEndISO}
              onChange={(event) => setFromDate(event.target.value || periodStartISO)}
            />
          </div>
        )}

        <div className="mt-1 flex gap-3">
          <button
            className="min-h-11 flex-1 rounded-lg bg-white/10 py-3 text-sm font-medium active:bg-white/20"
            onClick={onCancel}
          >
            {ru.period.cancel}
          </button>
          <button
            className="min-h-11 flex-1 rounded-lg bg-app-accent py-3 text-sm font-semibold text-slate-900 active:opacity-80"
            onClick={() => onApply(mode, mode === "apply_from_date" ? fromDate : null)}
          >
            {ru.period.apply}
          </button>
        </div>
      </div>
    </div>
  );
}
