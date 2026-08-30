import { useState } from "react";
import { NumberInput } from "@/components/NumberInput";
import { clampDayTypeLabel, deriveDayTypeLabel } from "@/lib/format/dayType";
import { ru } from "@/i18n/ru";
import { DAY_TYPE_COLORS } from "@/pages/DayTypes/dayTypeDefaults";
import type { DayTypeDraft } from "@/db/dayTypes";
import type { PayMode } from "@/types/models";

interface DayTypeFormProps {
  initial: DayTypeDraft;
  /** Ставка периода, в контексте которого показывается ставка (раздел 5.3.1). */
  baseRate: number | null;
  periodLabel: string;
  currency: string;
  onSave: (draft: DayTypeDraft) => void;
  onCancel: () => void;
  onOpenPeriod: () => void;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
      <span className="min-w-0 text-sm">{label}</span>
      {/* Область нажатия 44px по высоте при дорожке в 24px — как на экране дня
          (инвариант 59); -my-2 не даёт строке растолстеть. */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className="-my-2 flex h-11 w-11 shrink-0 items-center justify-end"
      >
        <span
          className={`relative block h-6 w-11 rounded-full transition-colors ${checked ? "bg-app-accent" : "bg-white/20"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-[left] ${checked ? "left-[22px]" : "left-0.5"}`}
          />
        </span>
      </button>
    </div>
  );
}

export function DayTypeForm({
  initial,
  baseRate,
  periodLabel,
  currency,
  onSave,
  onCancel,
  onOpenPeriod,
}: DayTypeFormProps) {
  const [draft, setDraft] = useState<DayTypeDraft>(initial);
  // Значок, пока пользователь его не трогал, следует за именем: пустой кружок
  // на календаре — регрессия, а требовать заполнить поле запрещает инвариант 54.
  // Как только значок задан руками, имя на него больше не влияет.
  const [labelTouched, setLabelTouched] = useState(initial.label !== "");

  const label = labelTouched ? draft.label : deriveDayTypeLabel(draft.name);
  const isPinned = draft.rate_mode === "pinned";
  const isHourly = draft.pay_mode === "hourly";
  const pinnedRate = draft.default_rate ?? 0;

  // Раздел 5.3.1 в исходном виде пересчитывал ставку из множителя и обратно.
  // Хранить производное значение нельзя (раздел 6.4 применит множитель второй
  // раз), поэтому показываем то же число, ничего не записывая.
  const showPreview = !isPinned && isHourly && baseRate !== null && baseRate > 0;
  const previewRate = showPreview ? (baseRate as number) * draft.default_multiplier : 0;
  // Инвариант 22: на периоде без базовой ставки типу с множителем объяснить
  // нечего — показываем причину и путь к ней, как на экране дня.
  const showNoBaseRate = !isPinned && isHourly && (baseRate === null || baseRate === 0);

  function patch(next: Partial<DayTypeDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  return (
    <>
      {/* min-h-0 обязателен: без него flex-элемент не сжимается ниже своего
          контента, overflow-y-auto бездействует и скроллится документ целиком —
          на 390×844 форма с этим числом полей уходит под нижний край. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6">
        {/* Раздел 5.3.1: ставка типа дня всегда в контексте периода. */}
        <p className="text-xs text-white/40">
          {periodLabel}
          {baseRate !== null && `, ${ru.dayTypes.periodContextBase} ${baseRate.toFixed(2)} ${currency}`}
        </p>

        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <label className="text-xs text-white/50" htmlFor="day-type-name">
              {ru.dayTypes.name}
            </label>
            <input
              id="day-type-name"
              type="text"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3 text-base"
              placeholder={ru.dayTypes.namePlaceholder}
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </div>
          <div className="w-24 shrink-0">
            <label className="text-xs text-white/50" htmlFor="day-type-label">
              {ru.dayTypes.label}
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="day-type-label"
                type="text"
                className="w-full min-w-0 rounded-lg bg-white/5 px-2 py-3 text-center text-base"
                value={label}
                onChange={(event) => {
                  setLabelTouched(true);
                  patch({ label: clampDayTypeLabel(event.target.value) });
                }}
              />
              {/* Живой предпросмотр кружка: значок редактируется ради него. */}
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-slate-900"
                style={{ backgroundColor: draft.color }}
              >
                {label}
              </span>
            </div>
          </div>
        </div>
        <p className="-mt-3 text-xs text-white/40">{ru.dayTypes.labelHint}</p>

        <div>
          <p className="text-xs text-white/50" id="day-type-color-label">
            {ru.dayTypes.color}
          </p>
          <div className="mt-1 flex flex-wrap gap-2" role="group" aria-labelledby="day-type-color-label">
            {DAY_TYPE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={draft.color === color}
                onClick={() => patch({ color })}
                className={`h-11 w-11 rounded-full ${draft.color === color ? "ring-2 ring-white" : ""}`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-white/50" htmlFor="day-type-note">
            {ru.dayTypes.note}
          </label>
          <input
            id="day-type-note"
            type="text"
            className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3 text-sm"
            placeholder={ru.dayTypes.notePlaceholder}
            value={draft.note}
            onChange={(event) => patch({ note: event.target.value })}
          />
        </div>

        <div>
          <p className="text-xs text-white/50" id="day-type-pay-mode-label">
            {ru.dayTypes.payMode}
          </p>
          <div className="mt-1 grid grid-cols-3 gap-2" role="group" aria-labelledby="day-type-pay-mode-label">
            {(
              [
                ["hourly", ru.dayTypes.payModeHourly],
                ["fixed_amount", ru.dayTypes.payModeFixed],
                ["unpaid", ru.dayTypes.payModeUnpaid],
              ] as [PayMode, string][]
            ).map(([mode, title]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={draft.pay_mode === mode}
                onClick={() => patch({ pay_mode: mode })}
                className={`min-h-11 rounded-lg px-2 py-2 text-xs ${
                  draft.pay_mode === mode ? "bg-app-accent font-semibold text-slate-900" : "bg-white/5 text-white"
                }`}
              >
                {title}
              </button>
            ))}
          </div>
        </div>

        {draft.pay_mode === "fixed_amount" && (
          <div>
            <label className="text-xs text-white/50" htmlFor="day-type-fixed-amount">
              {ru.dayTypes.fixedAmount}
            </label>
            <div className="mt-1 flex items-center gap-2 rounded-lg bg-white/5 px-2">
              <NumberInput
                id="day-type-fixed-amount"
                className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none"
                value={draft.fixed_amount ?? 0}
                onChange={(fixed_amount) => patch({ fixed_amount })}
              />
              <span className="shrink-0 text-sm text-white/50">{currency}</span>
            </div>
          </div>
        )}

        <div>
          <label className="text-xs text-white/50" htmlFor="day-type-hours">
            {ru.dayTypes.defaultHours}
          </label>
          <NumberInput
            id="day-type-hours"
            className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3 text-lg"
            value={draft.default_hours}
            onChange={(default_hours) => patch({ default_hours })}
          />
        </div>

        {/* Раздел 5.3: времена смены по умолчанию. Заданы оба — часы по
            умолчанию выводятся из них (раздел 6.1) вместо поля выше; хотя бы
            одного нет — работает "Часы по умолчанию" как и раньше. */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/50" htmlFor="day-type-default-start">
              {ru.dayTypes.defaultStartTime}
            </label>
            <input
              id="day-type-default-start"
              type="time"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3"
              value={draft.default_start ?? ""}
              onChange={(event) => patch({ default_start: event.target.value || null })}
            />
          </div>
          <div>
            <label className="text-xs text-white/50" htmlFor="day-type-default-end">
              {ru.dayTypes.defaultEndTime}
            </label>
            <input
              id="day-type-default-end"
              type="time"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3"
              value={draft.default_end ?? ""}
              onChange={(event) => patch({ default_end: event.target.value || null })}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/50" htmlFor="day-type-default-break">
              {ru.dayTypes.defaultBreakMinutes}
            </label>
            <NumberInput
              id="day-type-default-break"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3 text-lg"
              value={draft.default_break_minutes ?? 0}
              onChange={(value) => patch({ default_break_minutes: value })}
            />
          </div>
          <div>
            <label className="text-xs text-white/50" htmlFor="day-type-default-break-paid">
              {ru.dayTypes.defaultBreakPaidMinutes}
            </label>
            <NumberInput
              id="day-type-default-break-paid"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3 text-lg"
              value={draft.default_break_paid_minutes ?? 0}
              onChange={(value) => patch({ default_break_paid_minutes: value })}
            />
          </div>
        </div>
        <p className="-mt-2 text-xs text-white/40">{ru.dayTypes.defaultTimesHint}</p>

        {/* Замок — отдельный осознанный переключатель, а не побочный эффект
            ввода в поле ставки (раздел 5.3.1). */}
        <Toggle
          label={ru.dayTypes.rateLockToggle}
          checked={isPinned}
          onChange={(checked) => patch({ rate_mode: checked ? "pinned" : "multiplier" })}
        />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/50" htmlFor="day-type-multiplier">
              {ru.dayTypes.multiplier}
            </label>
            {/* Поле остаётся редактируемым и при закрытом замке: раздел 9
                запрещает блокировать, а приглушение плюс объяснение под ним
                говорят ровно то же самое, не отбирая ввод. Открыв замок,
                пользователь получит своё число обратно. */}
            <NumberInput
              id="day-type-multiplier"
              className={`mt-1 w-full rounded-lg bg-white/5 px-2 py-3 text-lg ${isPinned ? "opacity-50" : ""}`}
              value={draft.default_multiplier}
              onChange={(default_multiplier) => patch({ default_multiplier })}
            />
          </div>
          <div>
            <label className="text-xs text-white/50" htmlFor="day-type-rate">
              {ru.dayTypes.rate}
            </label>
            <NumberInput
              id="day-type-rate"
              className={`mt-1 w-full rounded-lg bg-white/5 px-2 py-3 text-lg ${isPinned ? "" : "opacity-50"}`}
              value={pinnedRate}
              onChange={(default_rate) => patch({ default_rate })}
            />
          </div>
        </div>

        {/* Одна строка объяснения на оба поля, высота зарезервирована: без
            min-h появление подсказки дёргало бы вниз всё, что под ней. */}
        <div className="-mt-2 min-h-[1rem] text-xs text-white/40">
          {!isHourly
            ? draft.pay_mode === "unpaid"
              ? ru.dayTypes.hintUnpaid
              : ru.dayTypes.hintFixedAmount
            : isPinned
              ? pinnedRate === 0
                ? ru.dayTypes.hintNoPinnedRate
                : ru.dayTypes.hintPinnedNoMultiplier
              : showPreview
                ? `${ru.dayTypes.ratePreviewPrefix} ${(baseRate as number).toFixed(2)} ${currency} ${ru.dayTypes.ratePreviewMiddle} ${previewRate.toFixed(2)} ${currency} ${ru.dayTypes.ratePreviewSuffix}`
                : ""}
        </div>

        {/* Раздел 9: предупреждаем, но не запрещаем (инвариант 24). */}
        {(draft.default_multiplier < 0 || (isPinned && pinnedRate < 0)) && (
          <p className="-mt-3 text-xs text-white/40">
            {draft.default_multiplier < 0 ? ru.dayTypes.hintNegativeMultiplier : ru.dayTypes.hintNegativeRate}
          </p>
        )}

        {showNoBaseRate && (
          <button
            type="button"
            onClick={onOpenPeriod}
            className="flex min-h-11 items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 text-left active:bg-white/10"
          >
            <span className="text-xs text-white/50">{ru.dayTypes.hintNoBaseRate}</span>
            <span className="shrink-0 text-xs font-semibold text-app-accent">{ru.dayTypes.hintNoBaseRateAction}</span>
          </button>
        )}

        <Toggle
          label={ru.dayTypes.countsAsWork}
          checked={draft.counts_as_work}
          onChange={(counts_as_work) => patch({ counts_as_work })}
        />
        <Toggle
          label={ru.dayTypes.countsTowardNorm}
          checked={draft.counts_toward_norm}
          onChange={(counts_toward_norm) => patch({ counts_toward_norm })}
        />
        {/* Модель хранит обратный флаг (ignore_auto_multipliers), а на экране
            стоит формулировка раздела 5.3 — «разрешить». */}
        <Toggle
          label={ru.dayTypes.allowAutoMultipliers}
          checked={!draft.ignore_auto_multipliers}
          onChange={(allow) => patch({ ignore_auto_multipliers: !allow })}
        />
      </div>

      {/* Кнопки — в нижней части экрана и вне скроллера (инвариант 59:
          управление достаётся большим пальцем и не уезжает вместе со списком
          полей). */}
      <div className="flex shrink-0 gap-3 border-t border-white/10 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <button
          type="button"
          className="min-h-11 flex-1 rounded-lg bg-white/10 py-3 text-sm font-medium active:bg-white/20"
          onClick={onCancel}
        >
          {ru.period.cancel}
        </button>
        <button
          type="button"
          className="min-h-11 flex-1 rounded-lg bg-app-accent py-3 text-sm font-semibold text-slate-900 active:opacity-80"
          // label || derive(...): поле значка можно очистить backspace'ом, и
          // тогда labelTouched уже true, а draft.label пуст — без запасного
          // значения форма молча сохраняла бы пустой кружок, ровно ту
          // регрессию, которую version(6) чинила для старых данных.
          onClick={() => onSave({ ...draft, label: label || deriveDayTypeLabel(draft.name) })}
        >
          {ru.dayTypes.save}
        </button>
      </div>
    </>
  );
}
