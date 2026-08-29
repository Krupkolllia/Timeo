import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate, useSearchParams } from "react-router-dom";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { createHoliday, listHolidays, restoreHoliday, softDeleteHoliday } from "@/db/holidays";
import { updateWeekendMultipliers } from "@/db/settings";
import { toISODate } from "@/lib/calc/calendarGrid";
import { formatDayShort } from "@/lib/format/date";
import { NumberInput } from "@/components/NumberInput";
import { ru } from "@/i18n/ru";
import type { Holiday } from "@/types/models";

const userId = getLocalUserId();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function HolidaysPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Куда возвращаться по «назад» и после сохранения: экран открывается из
  // шторки дня (раздел 8.6), и вернуть пользователя нужно ровно в тот день.
  const returnTo = searchParams.get("return") ?? "/";
  // Дата приходит из адреса, то есть извне: строка неизвестного вида ушла бы
  // прямо в поле и в запись.
  const addParam = searchParams.get("add");
  const addDate = addParam !== null && ISO_DATE.test(addParam) ? addParam : null;

  const settings = useLiveQuery(() => db.settings.where("user_id").equals(userId).first(), []);
  const holidays = useLiveQuery(() => listHolidays(db, userId), []);

  const [formOpen, setFormOpen] = useState(addDate !== null);
  // Ради какого дня сюда пришли. Отдельно от addDate, потому что намерение
  // одноразовое: «назад» из формы означает «остаюсь в списке», и следующее
  // сохранение не должно снова уносить пользователя в тот день.
  const [returnAfterSave, setReturnAfterSave] = useState(addDate !== null);
  const [draftDate, setDraftDate] = useState(addDate ?? toISODate(new Date()));
  // Последняя дата, которую поле отдало в полном виде. Нативный выбор даты
  // умеет быть пустым и отдаёт "" на середине правки, а пустая строка,
  // сохранённая как дата, — это строка «undefined undefined» в списке, год без
  // названия и запись, которая не совпадёт ни с одним днём календаря. Правило
  // то же, что у NumberInput: незаконченный ввод не распространяется дальше
  // поля, и ничего при этом не блокируется (инвариант 56).
  const [lastValidDate, setLastValidDate] = useState(addDate ?? toISODate(new Date()));
  const [draftName, setDraftName] = useState("");
  const [pendingUndo, setPendingUndo] = useState<Holiday | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    };
  }, []);

  // Группировка по годам (раздел 8.6). Список уже отсортирован слоем данных, и
  // порядок внутри одной даты детерминирован (инвариант 53).
  const byYear = useMemo(() => {
    const groups = new Map<string, Holiday[]>();
    for (const holiday of holidays ?? []) {
      const year = holiday.date.slice(0, 4);
      const group = groups.get(year);
      if (group) group.push(holiday);
      else groups.set(year, [holiday]);
    }
    return [...groups.entries()];
  }, [holidays]);

  // Раздел 9: предупреждение, а не запрет. Два праздника на одну дату
  // разрешены инвариантом 53, но сказать об этом надо до сохранения.
  const duplicateWarning = (holidays ?? []).some((holiday) => holiday.date === draftDate);
  // Поле пустое: говорим, какая дата сохранится, вместо того чтобы запрещать
  // сохранение (раздел 9 — предупреждение, а не запрет).
  const emptyDateWarning = !ISO_DATE.test(draftDate);

  function openForm(date: string) {
    setDraftDate(date);
    setLastValidDate(date);
    setDraftName("");
    setFormOpen(true);
  }

  function handleDateChange(value: string) {
    setDraftDate(value);
    if (ISO_DATE.test(value)) setLastValidDate(value);
  }

  async function handleSave() {
    // Ничего не проверяем: пустое имя, дата в прошлом и повтор даты сохраняются
    // как есть (инвариант 56, раздел 9).
    await createHoliday(db, userId, { date: ISO_DATE.test(draftDate) ? draftDate : lastValidDate, name: draftName });
    setFormOpen(false);
    setDraftName("");
    // Пришли из дня ради конкретной даты — возвращаем туда же.
    if (returnAfterSave) {
      setReturnAfterSave(false);
      navigate(returnTo);
    }
  }

  async function handleDelete(holiday: Holiday) {
    await softDeleteHoliday(db, holiday.id);
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setPendingUndo(holiday);
    undoTimeoutRef.current = setTimeout(() => setPendingUndo(null), 5000);
  }

  async function handleUndoDelete() {
    if (!pendingUndo) return;
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    await restoreHoliday(db, pendingUndo.id);
    setPendingUndo(null);
  }

  function handleMultiplierChange(patch: Partial<{ saturday: number; sunday: number; holiday: number }>) {
    if (!settings) return;
    // Патч, а не собранный целиком объект: слияние делает слой данных внутри
    // транзакции, иначе быстрая правка второго поля вернула бы первое к
    // прежнему значению.
    void updateWeekendMultipliers(db, settings.id, patch);
  }

  if (!settings || holidays === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-app-bg text-white/50">{ru.calendar.loading}</div>
    );
  }

  // h-dvh, а не min-h-dvh: без ограниченной высоты у flex-родителя
  // overflow-y-auto на списке не срабатывает и скроллится документ целиком —
  // шапка с кнопкой «назад» уезжает за верхний край. Список тут длинный —
  // тринадцать праздников на год.
  return (
    <div className="flex h-dvh flex-col bg-app-bg text-white">
      <header className="flex shrink-0 items-center gap-1 px-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-2">
        <button
          className="rounded-full p-3 text-xl text-white/70 active:bg-white/10"
          onClick={() => {
            if (!formOpen) {
              navigate(returnTo);
              return;
            }
            setFormOpen(false);
            setReturnAfterSave(false);
          }}
          aria-label={ru.holidays.back}
        >
          ‹
        </button>
        <span className="min-w-0 truncate text-lg font-semibold tracking-tight">
          {formOpen ? ru.holidays.formTitle : ru.holidays.title}
        </span>
      </header>

      {formOpen ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6">
          <div>
            <label className="text-xs text-white/50" htmlFor="holiday-date">
              {ru.holidays.date}
            </label>
            {/* type="date" отдаёт ровно YYYY-MM-DD и не проходит через UTC
                (инвариант 27), а на iOS открывает системный выбор даты. */}
            <input
              id="holiday-date"
              type="date"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3"
              value={draftDate}
              onChange={(event) => handleDateChange(event.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-white/50" htmlFor="holiday-name">
              {ru.holidays.name}
            </label>
            <input
              id="holiday-name"
              type="text"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-3"
              placeholder={ru.holidays.namePlaceholder}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
            />
          </div>
          {/* Высота зарезервирована всегда: строка, появляющаяся по совпадению
              даты, иначе двигала бы кнопку сохранения под пальцем. */}
          <p className={`text-xs text-white/40 ${emptyDateWarning || duplicateWarning ? "" : "invisible"}`}>
            {emptyDateWarning
              ? `${ru.holidays.emptyDateWarning} ${formatDayShort(lastValidDate)}`
              : ru.holidays.duplicateWarning}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6">
          <section>
            <h2 className="text-xs text-white/40">{ru.holidays.multipliersTitle}</h2>
            <div className="mt-2 grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-white/50" htmlFor="multiplier-saturday">
                  {ru.holidays.multiplierSaturday}
                </label>
                <NumberInput
                  id="multiplier-saturday"
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2 text-lg"
                  value={settings.weekend_multipliers.saturday}
                  onChange={(value) => handleMultiplierChange({ saturday: value })}
                />
              </div>
              <div>
                <label className="text-xs text-white/50" htmlFor="multiplier-sunday">
                  {ru.holidays.multiplierSunday}
                </label>
                <NumberInput
                  id="multiplier-sunday"
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2 text-lg"
                  value={settings.weekend_multipliers.sunday}
                  onChange={(value) => handleMultiplierChange({ sunday: value })}
                />
              </div>
              <div>
                <label className="text-xs text-white/50" htmlFor="multiplier-holiday">
                  {ru.holidays.multiplierHoliday}
                </label>
                <NumberInput
                  id="multiplier-holiday"
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2 text-lg"
                  value={settings.weekend_multipliers.holiday}
                  onChange={(value) => handleMultiplierChange({ holiday: value })}
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-white/40">{ru.holidays.multipliersNote}</p>
          </section>

          {byYear.length === 0 && <p className="text-sm text-white/40">{ru.holidays.empty}</p>}

          {byYear.map(([year, rows]) => (
            <section key={year}>
              <h2 className="text-xs text-white/40">{year}</h2>
              <ul className="mt-2 flex flex-col gap-2">
                {rows.map((holiday) => (
                  <li key={holiday.id} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2">
                    <span className="w-20 shrink-0 text-xs text-white/50">{formatDayShort(holiday.date)}</span>
                    {/* min-w-0 + truncate: имя пользовательское и произвольной
                        длины, кнопка удаления за край уезжать не должна
                        (инвариант 26). */}
                    <span className="min-w-0 flex-1 truncate text-sm">{holiday.name}</span>
                    <button
                      className="-mr-2 min-h-11 shrink-0 px-3 text-xs text-white/40 active:text-white/70"
                      aria-label={`${ru.holidays.delete}: ${holiday.name || holiday.date}`}
                      onClick={() => void handleDelete(holiday)}
                    >
                      {ru.holidays.delete}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Основное действие — в нижней части экрана (инвариант 59). */}
      <div className="shrink-0 border-t border-white/10 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <button
          className="min-h-11 w-full rounded-lg bg-app-accent py-3 text-sm font-semibold text-slate-900 active:opacity-80"
          onClick={() => (formOpen ? void handleSave() : openForm(addDate ?? toISODate(new Date())))}
        >
          {formOpen ? ru.holidays.save : ru.holidays.add}
        </button>
      </div>

      {/* Плашка отмены сверху, как на календаре и в типах дня: низ занят
          основным действием. */}
      {pendingUndo && (
        <div className="fixed inset-x-4 top-[calc(env(safe-area-inset-top)+0.5rem)] z-30 flex items-center justify-between gap-3 rounded-xl bg-slate-800 px-4 py-2 shadow-lg">
          <span className="min-w-0 truncate text-sm">{ru.holidays.deleted}</span>
          <button
            className="-mr-2 min-h-11 shrink-0 px-3 text-sm font-semibold text-app-accent"
            onClick={() => void handleUndoDelete()}
          >
            {ru.holidays.undo}
          </button>
        </div>
      )}
    </div>
  );
}
