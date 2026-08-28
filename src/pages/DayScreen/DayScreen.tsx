import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/db";
import { NumberInput } from "@/components/NumberInput";
import { createEntry, listActiveEntriesForDate, softDeleteEntry, updateEntry } from "@/db/entries";
import { buildEntryDefaultsForDayType, calculateEntryAmount, mapRateSource, type EntryDefaults } from "@/lib/calc/entry";
import { resolveMultiplier, type MultiplierResult } from "@/lib/calc/multiplier";
import { ru } from "@/i18n/ru";
import type { DayType, Entry, Period, Settings } from "@/types/models";

interface DayScreenProps {
  date: string;
  userId: string;
  dayTypes: DayType[];
  period: Pick<Period, "base_rate">;
  settings: Pick<Settings, "show_shift_times" | "currency" | "weekend_multipliers">;
  onClose: () => void;
  // Плашку "отменить" рисует CalendarPage, а не сам bottom sheet: удаление
  // закрывает экран дня сразу, и если undo-таймер жил бы только в DayScreen,
  // закрытие листа уносило бы с собой единственную кнопку отмены (раздел 8 ТЗ
  // требует настоящее окно отмены, а не "пока открыт диалог").
  onEntryDeleted: (entry: Entry) => void;
}

// Форма записи, которой оперирует экран. Совпадает с редактируемыми полями Entry,
// без служебных (id/user_id/timestamps) — их добавляет слой db/entries при записи.
type EntryDraft = Pick<
  Entry,
  | "day_type_id"
  | "hours"
  | "multiplier"
  | "rate_per_hour"
  | "rate_is_manual"
  | "amount"
  | "amount_override"
  | "note"
  | "start_time"
  | "end_time"
  | "break_minutes"
  | "rate_source"
>;

function entryToDraft(entry: Entry): EntryDraft {
  return {
    day_type_id: entry.day_type_id,
    hours: entry.hours,
    multiplier: entry.multiplier,
    rate_per_hour: entry.rate_per_hour,
    rate_is_manual: entry.rate_is_manual,
    amount: entry.amount,
    amount_override: entry.amount_override,
    note: entry.note,
    start_time: entry.start_time,
    end_time: entry.end_time,
    break_minutes: entry.break_minutes,
    rate_source: entry.rate_source,
  };
}

function draftFromDefaults(dayTypeId: string, defaults: EntryDefaults): EntryDraft {
  return {
    day_type_id: dayTypeId,
    hours: defaults.hours,
    multiplier: defaults.multiplier,
    rate_per_hour: defaults.rate_per_hour,
    rate_is_manual: defaults.rate_is_manual,
    amount: defaults.amount,
    amount_override: null,
    note: "",
    start_time: null,
    end_time: null,
    break_minutes: null,
    rate_source: defaults.rate_source,
  };
}

// Раздел 8 ТЗ разрешает отрицательные суммы, но ввод отрицательного числа
// начинается с промежуточного состояния вроде "-" или "-.", которое Number()
// превращает в NaN. Раньше это NaN тут же летело в calculateEntryAmount и
// оседало в Dexie как amount: NaN, портя итог периода. Возвращаем null для
// ещё не готового ввода — обработчик просто не трогает черновик до тех пор,
// пока пользователь не допечатает валидное число.
function parseNumberInput(value: string): number | null {
  if (value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function multiplierSourceLabel(source: MultiplierResult["source"]): string | null {
  switch (source) {
    case "holiday":
      return ru.day.multiplierSourceHoliday;
    case "sunday":
      return ru.day.multiplierSourceSunday;
    case "saturday":
      return ru.day.multiplierSourceSaturday;
    case "day_type_ignore":
    case "day_type_default":
      return ru.day.multiplierSourceDayType;
    case "default":
      return null;
  }
}

export function DayScreen({ date, userId, dayTypes, period, settings, onClose, onEntryDeleted }: DayScreenProps) {
  const activeDayTypes = useMemo(
    () => [...dayTypes].filter((dt) => !dt.is_archived).sort((a, b) => a.sort_order - b.sort_order),
    [dayTypes],
  );
  const dayTypeById = useMemo(() => new Map(dayTypes.map((dt) => [dt.id, dt])), [dayTypes]);

  const entries = useLiveQuery(() => listActiveEntriesForDate(db, userId, date), [userId, date]);
  const holiday = useLiveQuery(
    () =>
      db.holidays
        .where("date")
        .equals(date)
        .filter((h) => h.user_id === userId && h.deleted_at === null)
        .first(),
    [userId, date],
  );

  const entry = entries?.[0];
  const parsedDate = useMemo(() => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d);
  }, [date]);

  const [draft, setDraft] = useState<EntryDraft | null>(null);

  // Синхронный "замок" на создание записи: без него быстрый двойной тап по
  // двум кнопкам типа дня успевает вызвать persist() дважды до того, как первый
  // createEntry() резолвится и useLiveQuery увидит новую запись — оба вызова
  // видят entry === undefined и оба создают строку, задваивая запись за день.
  const entryIdRef = useRef<string | null>(entry?.id ?? null);
  const creatingRef = useRef<Promise<Entry> | null>(null);
  useEffect(() => {
    entryIdRef.current = entry?.id ?? null;
  }, [entry?.id]);

  // Tracks whether the user has typed something into this screen visit before
  // switching day types. Untouched, a type tap should apply that type's own
  // defaults (that's the whole point of the button); once the user has entered
  // hours/multiplier/rate themselves, switching type must carry those over
  // instead of silently discarding them for the new type's defaults.
  const hasEditedRef = useRef(false);

  // Запись, созданную этим же экраном, отличаем от записи, приехавшей извне.
  // Отдельный ref, а не entryIdRef: тот синхронизируется эффектом выше, который
  // объявлен раньше и успевает отработать первым — проверка стала бы всегда истинной.
  const selfCreatedIdRef = useRef<string | null>(null);

  // Флаг «пользователь уже вводил значения» живёт на время посещения дня, а не
  // строки в базе: первый же ввод создаёт запись и меняет entry.id, и общий
  // эффект инициализации сбрасывал бы флаг ровно тогда, когда вводить начали.
  useEffect(() => {
    hasEditedRef.current = false;
    selfCreatedIdRef.current = null;
  }, [date]);

  // Инициализация/переключение черновика — только когда меняется сама запись
  // (её id) или выбранный день, а не при каждом чтении из Dexie: иначе
  // собственная запись экрана эхом прилетала бы обратно и перетирала то, что
  // пользователь только что набирает в поле.
  useEffect(() => {
    // Собственная только что созданная запись — черновик уже актуален, повторная
    // инициализация затёрла бы то, что пользователь набирает прямо сейчас.
    if (entry && entry.id === selfCreatedIdRef.current) return;

    if (entry) {
      setDraft(entryToDraft(entry));
    } else if (activeDayTypes.length > 0) {
      const defaults = buildEntryDefaultsForDayType(
        parsedDate,
        activeDayTypes[0],
        period,
        holiday,
        settings.weekend_multipliers,
      );
      setDraft(draftFromDefaults(activeDayTypes[0].id, defaults));
    } else {
      setDraft(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, date]);

  const dayType = draft ? dayTypeById.get(draft.day_type_id) : undefined;

  async function persist(next: EntryDraft) {
    setDraft(next);

    if (entryIdRef.current) {
      await updateEntry(db, entryIdRef.current, next);
      return;
    }

    if (creatingRef.current) {
      // Создание уже в полёте (предыдущий вызов persist ещё не резолвился) —
      // дожидаемся его и обновляем ту же строку вместо второй вставки.
      const created = await creatingRef.current;
      entryIdRef.current = created.id;
      selfCreatedIdRef.current = created.id;
      await updateEntry(db, created.id, next);
      return;
    }

    const promise = createEntry(db, { ...next, user_id: userId, date });
    creatingRef.current = promise;
    const created = await promise;
    entryIdRef.current = created.id;
    selfCreatedIdRef.current = created.id;
    creatingRef.current = null;
  }

  function handleSelectDayType(dt: DayType) {
    if (!hasEditedRef.current) {
      const defaults = buildEntryDefaultsForDayType(parsedDate, dt, period, holiday, settings.weekend_multipliers);
      void persist(draftFromDefaults(dt.id, defaults));
      return;
    }
    // The user already typed hours/multiplier/rate for this day before tapping
    // another type — keep those instead of overwriting them with the new
    // type's defaults, only day_type_id and the pay_mode-dependent amount change.
    if (!draft) return;
    const next = { ...draft, day_type_id: dt.id };
    const { amount, rate_per_hour } = calculateEntryAmount(next, dt, period);
    void persist({ ...next, amount, rate_per_hour });
  }

  function handleHoursChange(hours: number) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    const { amount, rate_per_hour } = calculateEntryAmount({ ...draft, hours }, dayType, period);
    void persist({ ...draft, hours, amount, rate_per_hour });
  }

  function handleMultiplierChange(multiplier: number) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    // Раздел 3 ТЗ: правка множителя переводит ставку в авто-режим и пересчитывает
    // её из base_rate периода — источник истины всегда base_rate × multiplier.
    const { amount, rate_per_hour } = calculateEntryAmount(
      { ...draft, multiplier, rate_is_manual: false },
      dayType,
      period,
    );
    // rate_source по-прежнему выводится из правила раздела 6.2: если введённое
    // значение совпадает с тем, что дало бы авто-правило (праздник/выходной/тип
    // дня), считаем его тем же источником; иначе это уже не привязано ни к
    // какому правилу, и ближайшее по смыслу значение — "ставка периода".
    const auto = resolveMultiplier(parsedDate, dayType, holiday, settings.weekend_multipliers);
    const rate_source = mapRateSource(auto.value === multiplier ? auto.source : "default", false);
    void persist({ ...draft, multiplier, rate_is_manual: false, rate_per_hour, amount, rate_source });
  }

  function handleRateChange(rate: number) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    // Правка ставки фиксирует rate_is_manual=true — множитель остаётся как есть,
    // чисто для истории/отображения (раздел 3 ТЗ).
    const { amount, rate_per_hour } = calculateEntryAmount(
      { ...draft, rate_per_hour: rate, rate_is_manual: true },
      dayType,
      period,
    );
    void persist({ ...draft, rate_is_manual: true, rate_per_hour, amount, rate_source: mapRateSource("default", true) });
  }

  function handleNoteChange(note: string) {
    if (!draft) return;
    hasEditedRef.current = true;
    void persist({ ...draft, note });
  }

  function handleToggleManualAmount(enabled: boolean) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    if (enabled) {
      void persist({ ...draft, amount_override: draft.amount });
      return;
    }
    const { amount, rate_per_hour } = calculateEntryAmount({ ...draft, amount_override: null }, dayType, period);
    void persist({ ...draft, amount_override: null, amount, rate_per_hour });
  }

  function handleAmountOverrideChange(value: number) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    const { amount, rate_per_hour } = calculateEntryAmount({ ...draft, amount_override: value }, dayType, period);
    void persist({ ...draft, amount_override: value, amount, rate_per_hour });
  }

  function handleShiftTimeChange(patch: Partial<Pick<EntryDraft, "start_time" | "end_time" | "break_minutes">>) {
    if (!draft) return;
    hasEditedRef.current = true;
    void persist({ ...draft, ...patch });
  }

  async function handleDelete() {
    if (!entry) return;
    await softDeleteEntry(db, entry.id);
    onEntryDeleted(entry);
    onClose();
  }

  const isManualAmount = draft?.amount_override !== null && draft?.amount_override !== undefined;
  const multiplierResult = dayType
    ? resolveMultiplier(parsedDate, dayType, holiday, settings.weekend_multipliers)
    : null;
  const showMultiplierSourceLabel = multiplierResult && draft && multiplierResult.value === draft.multiplier;
  const sourceLabel = showMultiplierSourceLabel ? multiplierSourceLabel(multiplierResult.source) : null;

  const showManyHoursHint = (draft?.hours ?? 0) > 24;
  const showZeroRateHint = dayType?.pay_mode === "hourly" && !isManualAmount && (draft?.rate_per_hour ?? 0) === 0;

  // Раздел 6.1: unpaid всегда даёт 0, и множитель со ставкой на результат не
  // влияют. Раздел 8 запрещает запрещать — поля остаются редактируемыми
  // (осознанное решение коммита 8dec465), но приглушаются, а под суммой
  // появляется объяснение, откуда ноль. Прозрачность вместо запрета.
  const isUnpaidWithoutOverride = dayType?.pay_mode === "unpaid" && !isManualAmount;
  const amountHint = isUnpaidWithoutOverride
    ? ru.day.hintUnpaidDayType
    : (draft?.amount ?? 0) < 0
      ? ru.day.hintNegativeAmount
      : null;

  return (
    // min-h-0 обязателен: без него flex-элемент не сжимается ниже своего
    // контента и overflow-y-auto не срабатывает. Лимит высоты — на панели
    // целиком (.day-sheet в CalendarPage), здесь только скроллируемая часть.
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+1rem)] text-white">
      <div className="grid grid-cols-3 gap-2">
        {activeDayTypes.length === 0 && <p className="col-span-3 text-sm text-white/50">{ru.day.noDayTypes}</p>}
        {activeDayTypes.map((dt) => {
          const isSelected = draft?.day_type_id === dt.id;
          return (
            <button
              key={dt.id}
              onClick={() => handleSelectDayType(dt)}
              className={`rounded-xl px-2 py-3 text-sm font-medium ${
                isSelected ? "text-slate-900" : "bg-white/5 text-white active:bg-white/10"
              }`}
              style={isSelected ? { backgroundColor: dt.color } : undefined}
            >
              {dt.name}
            </button>
          );
        })}
      </div>

      {draft && dayType && (
        <>
          <div>
            <label className="text-xs text-white/50">{ru.day.hours}</label>
            <div className="mt-1 flex items-center gap-3">
              <button
                className="h-10 w-10 rounded-full bg-white/10 text-lg active:bg-white/20"
                onClick={() => handleHoursChange(Math.max(0, draft.hours - 0.5))}
              >
                −
              </button>
              <NumberInput
                className="w-20 rounded-lg bg-white/5 px-2 py-2 text-center text-lg"
                value={draft.hours}
                onChange={handleHoursChange}
              />
              <button
                className="h-10 w-10 rounded-full bg-white/10 text-lg active:bg-white/20"
                onClick={() => handleHoursChange(draft.hours + 0.5)}
              >
                +
              </button>
            </div>
            <p className={`mt-1 text-xs text-white/40 ${showManyHoursHint ? "" : "invisible"}`}>
              {ru.day.hintManyHours}
            </p>
          </div>

          {/* Always rendered at the same height regardless of pay_mode — otherwise
              the sheet visibly grows/shrinks every time a different day type is
              tapped, since hourly types show two inputs and others show nothing.
              unpaid types (Отгул, Выходной) also get the multiplier/rate inputs —
              the user wants the fields available even though pay_mode=unpaid still
              pins amount at 0 per section 6.1 of the spec; only fixed_amount types
              fall back to the placeholder plate. */}
          {dayType.pay_mode === "hourly" || dayType.pay_mode === "unpaid" ? (
            <div className={`grid grid-cols-2 gap-3 ${isUnpaidWithoutOverride ? "opacity-60" : ""}`}>
              <div>
                <label className="text-xs text-white/50">{ru.day.multiplier}</label>
                <NumberInput
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2 text-lg"
                  value={draft.multiplier}
                  onChange={handleMultiplierChange}
                />
                <p className={`mt-1 text-xs text-white/40 ${sourceLabel ? "" : "invisible"}`}>
                  {sourceLabel ?? " "}, ×{draft.multiplier}
                </p>
              </div>
              <div>
                <label className="text-xs text-white/50">{ru.day.rate}</label>
                <NumberInput
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2 text-lg"
                  value={draft.rate_per_hour}
                  onChange={handleRateChange}
                />
                <p className={`mt-1 text-xs text-white/40 ${showZeroRateHint ? "" : "invisible"}`}>
                  {ru.day.hintZeroRate}
                </p>
              </div>
            </div>
          ) : (
            // Only fixed_amount types land here now (hourly and unpaid both use
            // the grid above) — min-h keeps this plate's height close enough to
            // the grid's that the sheet doesn't visibly jump when switching.
            <div className="flex min-h-[92px] items-start rounded-lg bg-white/5 px-3 py-2 text-sm text-white/50">
              {ru.day.payModeFixedAmount}
            </div>
          )}

          {settings.show_shift_times && (
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-white/50">{ru.day.startTime}</label>
                <input
                  type="time"
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2"
                  value={draft.start_time ?? ""}
                  onChange={(e) => handleShiftTimeChange({ start_time: e.target.value || null })}
                />
              </div>
              <div>
                <label className="text-xs text-white/50">{ru.day.endTime}</label>
                <input
                  type="time"
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2"
                  value={draft.end_time ?? ""}
                  onChange={(e) => handleShiftTimeChange({ end_time: e.target.value || null })}
                />
              </div>
              <div>
                <label className="text-xs text-white/50">{ru.day.breakMinutes}</label>
                <input
                  type="number"
                  inputMode="numeric"
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2"
                  value={draft.break_minutes ?? ""}
                  onChange={(e) => {
                    if (e.target.value === "") {
                      handleShiftTimeChange({ break_minutes: null });
                      return;
                    }
                    const parsed = parseNumberInput(e.target.value);
                    if (parsed !== null) handleShiftTimeChange({ break_minutes: parsed });
                  }}
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
            <span className="text-sm">{ru.day.manualAmountToggle}</span>
            <button
              role="switch"
              aria-checked={isManualAmount}
              onClick={() => handleToggleManualAmount(!isManualAmount)}
              className={`relative h-6 w-11 rounded-full transition-colors ${isManualAmount ? "bg-app-accent" : "bg-white/20"}`}
            >
              {/* Absolute + left, not transform — a translate-based knob depends on the
                  button not being a flex/centered container; absolute positioning against
                  an explicit `relative` parent has no such ambiguity. */}
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-[left] ${
                  isManualAmount ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          </div>

          <div>
            <label className="text-xs text-white/50">{ru.day.amount}</label>
            {/* Валюта в одной строке с числом: отдельным <p> в 24px под полем она
                читалась как ещё одно поле. min-w-0 обязателен — без него flex-элемент
                с длинным числом не сожмётся и вытолкнет валюту за край. */}
            <div className="mt-1 flex items-center gap-2 rounded-lg bg-white/5 px-2">
              <NumberInput
                disabled={!isManualAmount}
                className="min-w-0 flex-1 bg-transparent py-3 text-2xl font-semibold outline-none disabled:opacity-70"
                value={isManualAmount ? (draft.amount_override ?? 0) : draft.amount}
                onChange={handleAmountOverrideChange}
              />
              <span className="shrink-0 text-sm text-white/50">{settings.currency}</span>
            </div>
            <p className={`mt-1 text-xs text-white/40 ${amountHint ? "" : "invisible"}`}>{amountHint ?? " "}</p>
          </div>

          <div>
            <label className="text-xs text-white/50">{ru.day.note}</label>
            <textarea
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2 text-sm"
              placeholder={ru.day.notePlaceholder}
              value={draft.note}
              onChange={(e) => handleNoteChange(e.target.value)}
              rows={2}
            />
          </div>

          {entry && (
            <button className="min-h-11 py-3 text-sm text-white/50 active:text-white/70" onClick={handleDelete}>
              {ru.day.deleteEntry}
            </button>
          )}
        </>
      )}

      <button className="rounded-lg bg-white/10 py-3 text-sm font-medium active:bg-white/20" onClick={onClose}>
        {ru.day.close}
      </button>
    </div>
  );
}
