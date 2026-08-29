import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/db/db";
import { NumberInput } from "@/components/NumberInput";
import { createEntry, listActiveEntriesForDate, softDeleteEntry, updateEntry } from "@/db/entries";
import {
  applyMultiplierEdit,
  applyRateEdit,
  buildEntryDefaultsForDayType,
  calculateEntryAmount,
  type EntryDefaults,
} from "@/lib/calc/entry";
import { resolveMultiplier, type MultiplierResult } from "@/lib/calc/multiplier";
import { resolveDuration } from "@/lib/calc/duration";
import { formatHours } from "@/lib/format/hours";
import { pickHoliday } from "@/lib/calc/holidays";
import { formatEntryDetail } from "@/lib/format/entry";
import { ru } from "@/i18n/ru";
import type { DayType, Entry, Period, Settings } from "@/types/models";

interface DayScreenProps {
  date: string;
  userId: string;
  dayTypes: DayType[];
  period: Pick<Period, "base_rate" | "is_closed">;
  settings: Pick<Settings, "show_shift_times" | "currency" | "weekend_multipliers">;
  onClose: () => void;
  // Инвариант 2: закрытый период неизменяем, и отказ должен нести объяснение и
  // предложение открыть период заново. Само переоткрытие живёт на экране
  // периода (там же подтверждение) — шторка только уводит туда.
  onOpenPeriod: () => void;
  // Плашку "отменить" рисует CalendarPage, а не сам bottom sheet: удаление
  // закрывает экран дня сразу, и если undo-таймер жил бы только в DayScreen,
  // закрытие листа уносило бы с собой единственную кнопку отмены (раздел 8 ТЗ
  // требует настоящее окно отмены, а не "пока открыт диалог").
  onEntryDeleted: (entry: Entry) => void;
  /**
   * Сюда экран кладёт собственный обработчик закрытия — тот же, что у кнопки
   * «Закрыть», вместе с вопросом о несохранённом. Нужен календарю: затемнение
   * вокруг шторки принадлежит ему, и тап по нему закрывал день напрямую, минуя
   * вопрос. Для пользователя это то же самое действие, и вести себя оно обязано
   * так же, иначе набранная смена исчезает от случайного касания мимо панели.
   */
  requestCloseRef?: MutableRefObject<(() => void) | null>;
  // Раздел 8.2: последним в ряду типов стоит плюс, ведущий прямо в создание
  // типа дня — «типы чаще всего нужны в тот момент, когда нужного нет».
  onCreateDayType: () => void;
  // Единственный вход в экран праздников (раздел 8.6): в /settings не ведёт
  // ничего до блока 7, а множитель праздника задаётся именно там. addDate
  // непустой — открыть форму добавления с уже подставленной датой.
  onOpenHolidays: (options: { addDate?: string }) => void;
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
  | "duration_is_manual"
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
    duration_is_manual: entry.duration_is_manual,
    rate_source: entry.rate_source,
  };
}

/**
 * Черновик совпадает с тем, что уже лежит в базе? От этого зависит, есть ли
 * что сохранять и надо ли спрашивать при закрытии. Сравниваем значения, а не
 * держим флаг «трогали поле»: набрать 8, стереть и снова набрать 8 — это не
 * изменение, и спрашивать тут не о чем.
 */
function draftsEqual(a: EntryDraft, b: EntryDraft): boolean {
  return (
    a.day_type_id === b.day_type_id &&
    a.hours === b.hours &&
    a.multiplier === b.multiplier &&
    a.rate_per_hour === b.rate_per_hour &&
    a.rate_is_manual === b.rate_is_manual &&
    a.amount === b.amount &&
    a.amount_override === b.amount_override &&
    a.note === b.note &&
    a.start_time === b.start_time &&
    a.end_time === b.end_time &&
    a.break_minutes === b.break_minutes &&
    a.duration_is_manual === b.duration_is_manual &&
    a.rate_source === b.rate_source
  );
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
    // Новая запись начинает со ЖИВОЙ связью: как только заданы начало и конец,
    // длительность считается по ним (раздел 6.1). Связь рвёт только правка
    // часов руками, и только её (раздел 8.2).
    duration_is_manual: false,
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
    // Раздел 6.2: у типа с закрытым замком множитель не применяется вовсе, и
    // молча показать «×1» без причины значит оставить пользователя гадать,
    // почему воскресный множитель не сработал.
    case "pinned":
      return ru.day.multiplierSourcePinned;
    case "default":
      return null;
  }
}

export function DayScreen({
  date,
  userId,
  dayTypes,
  period,
  settings,
  onClose,
  onEntryDeleted,
  requestCloseRef,
  onOpenPeriod,
  onCreateDayType,
  onOpenHolidays,
}: DayScreenProps) {
  const activeDayTypes = useMemo(
    // deleted_at === null — инвариант 38: мягко удалённые строки не участвуют
    // ни в одной выборке. Архивные скрыты по инварианту 11: они исчезают из
    // выбора, но продолжают рисоваться на старых записях, поэтому dayTypeById
    // ниже строится по полному списку.
    () =>
      [...dayTypes]
        .filter((dt) => !dt.is_archived && dt.deleted_at === null)
        .sort((a, b) => a.sort_order - b.sort_order),
    [dayTypes],
  );
  const dayTypeById = useMemo(() => new Map(dayTypes.map((dt) => [dt.id, dt])), [dayTypes]);

  // Детерминированный порядок: Dexie отдаёт записи по индексу date, порядок
  // вставки внутри одной даты не гарантирован, а полоска записей и выбор
  // «первой» не должны прыгать между перечитываниями.
  const entries = useLiveQuery(
    async () =>
      (await listActiveEntriesForDate(db, userId, date)).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [userId, date],
  );
  // Инвариант 53: на дате может лежать несколько праздников, и решает не
  // порядок, в котором их отдал Dexie (внутри одного значения индекса он не
  // гарантирован), а pickHoliday. Прежний .first() отвечал на этот вопрос
  // произвольно и вдобавок расходился с планировщиком раздела 6.7.
  const holiday = useLiveQuery(
    async () =>
      pickHoliday(
        await db.holidays
          .where("date")
          .equals(date)
          .filter((h) => h.user_id === userId && h.deleted_at === null)
          .toArray(),
      ),
    [userId, date],
  );

  // Раздел 5.4: «допускается несколько записей на один день». Без выбора экран
  // открывал только entries[0]: вторая запись была невидима, недоступна для
  // правки, а «Удалить запись» удаляла не ту, которую видит пользователь.
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const entry = selectedEntryId ? entries?.find((e) => e.id === selectedEntryId) : entries?.[0];

  const parsedDate = useMemo(() => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d);
  }, [date]);

  const [draft, setDraft] = useState<EntryDraft | null>(null);

  // Раздел 8.2 (решение заказчика): запись уходит в базу только по кнопке
  // «Сохранить». Отсюда три вещи, которых при мгновенной записи не требовалось:
  //
  //  - «начатая, но ещё не существующая запись» — состояние, в котором день
  //    выбран, поля заполнены, а строки в Dexie нет вовсе;
  //  - «есть что сохранять» — сравнение черновика с тем, что лежит в базе;
  //  - вопрос при закрытии, потому что впервые в приложении появилась
  //    возможность потерять набранное.
  //
  // Синхронный замок на запись: кнопку «Сохранить» успевают нажать дважды
  // раньше, чем createEntry резолвится, и день получил бы две одинаковые
  // строки. Тот же приём, что на экранах праздников и прошлых периодов.
  const savingRef = useRef<Promise<boolean> | null>(null);
  const [saving, setSaving] = useState(false);

  // Пользователь коснулся черновика хоть раз за это открытие дня. Нужно
  // только для ещё не созданной записи: сравнивать её не с чем, а закрытие
  // сразу после открытия дня не должно ни спрашивать, ни сохранять пустой день.
  const [touched, setTouched] = useState(false);

  /**
   * Черновик описывает НОВУЮ строку, которой в базе ещё нет.
   *
   * Отличать это от правки существующей записи по «entry === undefined» нельзя:
   * сразу после «Добавить запись» выбранной снова становится первая запись дня,
   * и черновик сравнивался бы с ней. Если новая строка случайно совпала с ней
   * значениями (а по умолчанию так и есть), экран решал, что сохранять нечего,
   * и кнопки не было вовсе — вторую запись за день стало невозможно завести.
   */
  const [creatingNew, setCreatingNew] = useState(false);

  /**
   * Состояние строки, каким оно записано в базе, — точка отсчёта для «есть что
   * сохранять». Держим его отдельно, а не читаем запись из Dexie: useLiveQuery
   * привозит собственную запись экрана с задержкой в кадр-другой, и сразу
   * после сохранения сравнение шло бы с УСТАРЕВШЕЙ строкой. Кнопка на этот
   * кадр снова становилась «Сохранить», проверка успевала кликнуть по ней
   * второй раз, и тесты падали через раз в зависимости от того, кто успел
   * первым.
   *
   * null — строки в базе ещё нет, и точки отсчёта не существует: для такой
   * записи признаком «есть что сохранять» служит сам факт правки (touched).
   */
  const [baseline, setBaseline] = useState<EntryDraft | null>(null);

  /**
   * Раскрыт ли блок времени смены. Раздел 6.1 доехал до экрана только сейчас, а
   * единственный переключатель показа времён (settings.show_shift_times) до
   * блока 7 не может включить никто — по нему функция была бы невидима на
   * телефоне вовсе. Поэтому раскрытие живёт в самой шторке, по дню: настройка
   * задаёт лишь начальное состояние, а блок 7 просто перестанет быть
   * единственным способом.
   */
  const [shiftTimesOpen, setShiftTimesOpen] = useState(settings.show_shift_times);

  // Запись, у которой времена уже заполнены, обязана показывать их сразу:
  // спрятанное начало смены, влияющее на часы, — это ровно тот случай, когда
  // число на экране необъяснимо (инвариант 55). Закрывать блок обратно эффект
  // не пытается: свернуть его — решение человека.
  useEffect(() => {
    if (!entry) return;
    if (entry.start_time !== null || entry.end_time !== null || entry.break_minutes !== null) {
      setShiftTimesOpen(true);
    }
    // Зависимости — поля записи, а не сама запись: useLiveQuery отдаёт новый
    // объект на каждое чтение из Dexie, и по entry эффект срабатывал бы на
    // каждый кадр.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, entry?.start_time, entry?.end_time, entry?.break_minutes]);

  // Отложенное действие, которое ждёт ответа на вопрос о несохранённом.
  // Функция в состоянии — только через обёртку: useState вызывает переданную
  // функцию как ленивый инициализатор.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);

  // Tracks whether the user has typed something into this screen visit before
  // switching day types. Untouched, a type tap should apply that type's own
  // defaults (that's the whole point of the button); once the user has entered
  // hours/multiplier/rate themselves, switching type must carry those over
  // instead of silently discarding them for the new type's defaults.
  const hasEditedRef = useRef(false);

  // Какой записи соответствует текущий черновик (null — записи ещё нет).
  const draftEntryIdRef = useRef<string | null>(null);

  useEffect(() => {
    hasEditedRef.current = false;
    draftEntryIdRef.current = null;
    setTouched(false);
    setCreatingNew(false);
    setSelectedEntryId(null);
  }, [date]);

  // Инициализация/переключение черновика — только когда меняется сама запись
  // (её id) или выбранный день, а не при каждом чтении из Dexie: иначе
  // собственная запись экрана эхом прилетала бы обратно и перетирала то, что
  // пользователь только что набирает в поле.
  useEffect(() => {
    // Черновик уже соответствует этой записи — повторная инициализация затёрла
    // бы то, что пользователь набирает прямо сейчас.
    if (entry && entry.id === draftEntryIdRef.current) return;
    // Запись создана нашим же сохранением, её id уже у нас, но useLiveQuery ещё
    // не привёз её в список: entry на этот кадр undefined. Без этой проверки
    // эффект уходил в ветку «записи нет» и сбрасывал черновик на значения
    // ПЕРВОГО типа дня — только что выбранная ночная смена превращалась
    // обратно в обычный день.
    if (!entry && draftEntryIdRef.current !== null) return;
    // Начатая, но ещё не сохранённая запись: строки в базе нет, и подставлять
    // сюда значения по умолчанию значит стереть набранное человеком.
    if (!entry && touched) return;
    if (creatingNew) return;

    if (entry) {
      setDraft(entryToDraft(entry));
      setBaseline(entryToDraft(entry));
      setTouched(false);
    } else if (activeDayTypes.length > 0) {
      const defaults = buildEntryDefaultsForDayType(
        parsedDate,
        activeDayTypes[0],
        period,
        holiday,
        settings.weekend_multipliers,
      );
      setDraft(draftFromDefaults(activeDayTypes[0].id, defaults));
      // Значения по умолчанию — ещё не введённые данные: открыть день и тут же
      // закрыть не должно ни спрашивать, ни сохранять пустую смену.
      setBaseline(null);
      setTouched(false);
    } else {
      setDraft(null);
      setBaseline(null);
    }
    draftEntryIdRef.current = entry?.id ?? null;
    // holiday участвует в значениях по умолчанию (раздел 6.2), а приезжает из
    // Dexie отдельным запросом — уже после первого черновика. Без него в
    // зависимостях предзаполненный множитель на праздник оставался бы правилом
    // выходного или типа дня до первого тапа по кнопке типа.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id, date, selectedEntryId, holiday?.id, touched, creatingNew]);

  const dayType = draft ? dayTypeById.get(draft.day_type_id) : undefined;

  /**
   * Правка черновика. В базу здесь не уходит ничего: запись создаётся или
   * обновляется только в handleSave (решение заказчика по разделу 8.2).
   */
  function applyDraft(next: EntryDraft) {
    setDraft(next);
    setTouched(true);
  }

  // Есть ли что сохранять. Для существующей записи — расхождение с тем, что
  // лежит в базе; для ещё не созданной — сам факт, что человек её начал.
  const isDirty = draft !== null && (baseline ? !draftsEqual(draft, baseline) : touched);

  async function handleSave(): Promise<boolean> {
    if (!draft) return false;
    // Запись уже идёт — ждём её, а не отказываем. Отказ здесь стоил дорого:
    // нажав «Сохранить» и сразу «Закрыть», человек получал вопрос о
    // несохранённом, отвечал «сохранить изменения», а закрытие молча не
    // происходило вовсе — второй вызов упирался в замок и возвращал false.
    if (savingRef.current) return savingRef.current;

    const run = async (): Promise<boolean> => {
      // Цель записи — не только entry из useLiveQuery: собственная только что
      // созданная строка приезжает оттуда с задержкой в кадр-другой, и всё это
      // время entry === undefined. Без draftEntryIdRef второе сохранение
      // (сохранил, тут же поправил, сохранил снова) уходило бы в ветку
      // создания и заводило ВТОРУЮ запись за день.
      const targetId = creatingNew ? null : (entry?.id ?? draftEntryIdRef.current);
      if (targetId) {
        await updateEntry(db, targetId, draft);
        draftEntryIdRef.current = targetId;
        setBaseline(draft);
        setTouched(false);
        return true;
      }
      const created = await createEntry(db, { ...draft, user_id: userId, date });
      // null — период закрыли, пока экран был открыт, и слой данных отказал
      // (инвариант 2). Шторка через кадр перерисуется в режим чтения.
      if (!created) return false;
      draftEntryIdRef.current = created.id;
      // Только что созданная запись становится выбранной: иначе на дне с
      // несколькими записями экран продолжил бы показывать первую.
      setSelectedEntryId(created.id);
      setCreatingNew(false);
      setBaseline(draft);
      setTouched(false);
      return true;
    };

    const promise = run();
    savingRef.current = promise;
    setSaving(true);
    try {
      return await promise;
    } finally {
      savingRef.current = null;
      setSaving(false);
    }
  }

  /**
   * Действие, которое уничтожит черновик (закрыть шторку, начать новую запись,
   * переключиться на другую запись дня). Пока в приложении не было кнопки
   * сохранения, терять было нечего; теперь — есть, поэтому спрашиваем.
   *
   * Это третье и последнее модальное окно в приложении. Инвариант 56 разрешал
   * два (переоткрытие периода и замена данных при импорте); отступление
   * согласовано с заказчиком вместе с самой кнопкой и записано в SPEC.md
   * (раздел 8.2), потому что молчаливая потеря набранной смены на телефоне,
   * который тестируют по скриншотам, обнаруживается через недели.
   */
  function guardDraft(action: () => void) {
    if (!isDirty) {
      action();
      return;
    }
    setPendingDiscard(() => action);
  }

  // Публикуем закрытие наружу на каждый рендер: обработчик замыкает черновик и
  // isDirty, а они меняются с каждым нажатием клавиши. Сохранённый один раз, он
  // отвечал бы на вопрос «есть что сохранять» состоянием на момент открытия дня.
  useEffect(() => {
    if (!requestCloseRef) return;
    requestCloseRef.current = () => guardDraft(onClose);
    return () => {
      requestCloseRef.current = null;
    };
  });

  function handleSelectDayType(dt: DayType) {
    if (!hasEditedRef.current) {
      const defaults = buildEntryDefaultsForDayType(parsedDate, dt, period, holiday, settings.weekend_multipliers);
      applyDraft(draftFromDefaults(dt.id, defaults));
      return;
    }
    // The user already typed hours/multiplier/rate for this day before tapping
    // another type — keep those instead of overwriting them with the new
    // type's defaults, only day_type_id and the pay_mode-dependent amount change.
    if (!draft) return;

    // Исключение — замок (раздел 5.3.1). «Своя ставка» и «ставка периода» это
    // не пользовательский ввод, а правило самого типа дня, и перенести старые
    // деньги через эту границу нельзя ни в одну сторону:
    //
    //  - переход НА pinned-тип сохранял бы базовую ставку и множитель выходного
    //    вместо собственной ставки типа: 6ч × 30 × 2 = 360 там, где тип дня
    //    объявил 55 zł/h и раздел 6.2 запрещает множитель вовсе;
    //  - переход С pinned-типа оставлял бы его 55 zł/h на записи как ручную
    //    ставку, и она пережила бы даже смену базовой ставки периода.
    //
    // Часы, заметка, времена и ручная сумма при этом остаются пользовательскими:
    // именно ради них эта ветка и существует.
    const previous = dayTypeById.get(draft.day_type_id);
    if (dt.rate_mode === "pinned" || previous?.rate_mode === "pinned") {
      const defaults = buildEntryDefaultsForDayType(parsedDate, dt, period, holiday, settings.weekend_multipliers);
      const switched = {
        ...draft,
        day_type_id: dt.id,
        multiplier: defaults.multiplier,
        rate_per_hour: defaults.rate_per_hour,
        rate_is_manual: defaults.rate_is_manual,
        rate_source: defaults.rate_source,
      };
      applyDraft(withDerivedDuration(switched, dt));
      return;
    }

    // withDerivedDuration, а не голый calculateEntryAmount: ветка «по умолчанию»
    // формулы 6.1 берёт default_hours НОВОГО типа дня, а при живой связи и
    // заданных временах длительность остаётся выведенной из них. Вписанные
    // руками часы (duration_is_manual) переживают смену типа — ради них эта
    // ветка и существует.
    applyDraft(withDerivedDuration({ ...draft, day_type_id: dt.id }, dt));
  }

  /**
   * Раздел 6.1 на черновике: длительность выводится заново, сумма пересчитывается
   * по 6.4. В базу здесь не уходит ничего — как и во всём этом экране, запись
   * происходит только по кнопке «Сохранить» (раздел 8.2).
   *
   * Вызывается только там, где вход формулы 6.1 реально изменился: времена,
   * перерыв, тип дня, восстановление связи. На каждый рендер вывод НЕ гоняется —
   * иначе изменившийся default_hours типа дня переписывал бы часы уже
   * сохранённой записи, а инвариант 10 это прямо запрещает.
   */
  function withDerivedDuration(next: EntryDraft, dt: DayType): EntryDraft {
    const { hours } = resolveDuration(next, dt);
    const { amount, rate_per_hour } = calculateEntryAmount({ ...next, hours }, dt, period);
    return { ...next, hours, amount, rate_per_hour };
  }

  /**
   * Раздел 8.2: правка часов руками ставит duration_is_manual и разрывает связь
   * с временами. Флаг ставится и когда времён нет вовсе: разрывать в этот
   * момент нечего, но именно он не даст выведенной длительности затереть
   * набранное, если времена появятся позже.
   */
  function handleHoursChange(hours: number) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    const next = { ...draft, hours, duration_is_manual: true };
    const { amount, rate_per_hour } = calculateEntryAmount(next, dayType, period);
    applyDraft({ ...next, amount, rate_per_hour });
  }

  /** Раздел 8.2: кнопка «считать по времени» возвращает разорванную связь. */
  function handleRestoreDurationLink() {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    applyDraft(withDerivedDuration({ ...draft, duration_is_manual: false }, dayType));
  }

  // Правила правки множителя и ставки живут в lib/calc/entry: они уже ломались
  // дважды, а компонент тестами не покрыт.
  function handleMultiplierChange(multiplier: number) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    applyDraft({ ...draft, ...applyMultiplierEdit(draft, multiplier, dayType, period) });
  }

  function handleRateChange(rate: number) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    applyDraft({ ...draft, ...applyRateEdit(draft, rate, dayType, period) });
  }

  function handleNoteChange(note: string) {
    if (!draft) return;
    hasEditedRef.current = true;
    applyDraft({ ...draft, note });
  }

  function handleToggleManualAmount(enabled: boolean) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    if (enabled) {
      applyDraft({ ...draft, amount_override: draft.amount });
      return;
    }
    const { amount, rate_per_hour } = calculateEntryAmount({ ...draft, amount_override: null }, dayType, period);
    applyDraft({ ...draft, amount_override: null, amount, rate_per_hour });
  }

  function handleAmountOverrideChange(value: number) {
    if (!draft || !dayType) return;
    hasEditedRef.current = true;
    const { amount, rate_per_hour } = calculateEntryAmount({ ...draft, amount_override: value }, dayType, period);
    applyDraft({ ...draft, amount_override: value, amount, rate_per_hour });
  }

  /**
   * Начало, конец и перерыв — входы формулы раздела 6.1, поэтому длительность
   * и сумма пересчитываются здесь же. При разорванной связи
   * (duration_is_manual) время всё равно записывается, но часов не двигает:
   * resolveDuration возвращает вписанное человеком число.
   */
  function handleShiftTimeChange(patch: Partial<Pick<EntryDraft, "start_time" | "end_time" | "break_minutes">>) {
    if (!draft) return;
    hasEditedRef.current = true;
    const next = { ...draft, ...patch };
    applyDraft(dayType ? withDerivedDuration(next, dayType) : next);
  }

  function startNewEntry() {
    if (activeDayTypes.length === 0) return;
    // Новая строка, а не правка текущей: сбрасываем и выбранную запись, и
    // ссылку, по которой черновик связан с записью в базе.
    setSelectedEntryId(null);
    draftEntryIdRef.current = null;
    hasEditedRef.current = false;
    setCreatingNew(true);
    setBaseline(null);
    const defaults = buildEntryDefaultsForDayType(
      parsedDate,
      activeDayTypes[0],
      period,
      holiday,
      settings.weekend_multipliers,
    );
    applyDraft(draftFromDefaults(activeDayTypes[0].id, defaults));
  }

  // «Добавить запись» бросает текущий черновик так же, как закрытие шторки,
  // поэтому проходит через тот же вопрос.
  function handleAddEntry() {
    guardDraft(startNewEntry);
  }

  function handleSelectEntry(id: string) {
    guardDraft(() => {
      setCreatingNew(false);
      setSelectedEntryId(id);
    });
  }

  async function handleDelete() {
    if (!entry) return;
    const deleted = entry;
    await softDeleteEntry(db, deleted.id);
    onEntryDeleted(deleted);

    // Шторку закрываем только если день опустел: удаление одной из нескольких
    // записей не должно выкидывать пользователя из дня.
    const remaining = (entries ?? []).filter((e) => e.id !== deleted.id);
    draftEntryIdRef.current = null;
    setTouched(false);
    setCreatingNew(false);
    setBaseline(null);
    if (remaining.length === 0) {
      onClose();
      return;
    }
    setSelectedEntryId(remaining[0].id);
  }

  const isManualAmount = draft?.amount_override !== null && draft?.amount_override !== undefined;
  const autoMultiplier = dayType
    ? resolveMultiplier(parsedDate, dayType, holiday, settings.weekend_multipliers)
    : null;
  // Раздел 6.2: значение видно всегда. Если оно разошлось с автоматическим
  // правилом — значит, его задали руками, и это тоже источник, а не повод
  // молчать. Раньше подпись получала класс invisible ровно в тот момент,
  // когда пользователь задавал множитель сам.
  const sourceLabel =
    !autoMultiplier || !draft
      ? null
      : autoMultiplier.value === draft.multiplier
        ? multiplierSourceLabel(autoMultiplier.source)
        : ru.day.multiplierSourceManual;

  // Раздел 6.1 на текущем черновике — откуда взялась длительность и можно ли
  // вернуть связь с временами (раздел 8.2).
  const duration = draft && dayType ? resolveDuration(draft, dayType) : null;

  const showManyHoursHint = (draft?.hours ?? 0) > 24;
  // Нулевая базовая ставка периода — причина, а «ставка за час равна нулю» —
  // следствие. Показываем причину и путь к ней, иначе экран объясняет одно и то
  // же дважды и ни разу не говорит, что с этим делать. Условие — именно
  // «ставка не задана руками», а не «ставка равна нулю»: ноль, вписанный
  // человеком, разделу 9 не противоречит и объяснять его нечем.
  const showNoBaseRateHint =
    dayType?.pay_mode === "hourly" && period.base_rate === 0 && draft?.rate_is_manual === false;
  const showZeroRateHint =
    dayType?.pay_mode === "hourly" &&
    !isManualAmount &&
    !showNoBaseRateHint &&
    (draft?.rate_per_hour ?? 0) === 0;

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

  // Закрытый период (инвариант 2) — отдельная ветка рендера, а не disabled на
  // каждом поле: половина полей всё равно осталась бы кликабельной (переключатель
  // ручной суммы, кнопки типа дня, «удалить запись»), а лист из неактивных
  // контролов ничего не объясняет. Читаемая расшифровка дня плюс путь к
  // переоткрытию честнее и короче.
  if (period.is_closed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+1rem)] text-white">
        <p className="rounded-lg bg-white/5 px-3 py-2 text-sm text-white/60">{ru.day.closedPeriodNotice}</p>

        {/* entries === undefined — это «ещё читаем из Dexie», а не «записей нет»:
            иначе шторка на кадр показывает «за этот день записей нет» и тут же
            подменяет его списком. */}
        {entries && entries.length === 0 && <p className="text-sm text-white/40">{ru.day.closedPeriodEmpty}</p>}
        {entries && entries.length > 0 && (
          <ul className="flex flex-col divide-y divide-white/5">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm">{dayTypeById.get(e.day_type_id)?.name ?? "—"}</p>
                  <p className="truncate text-xs text-white/40">
                    {formatEntryDetail(e, dayTypeById.get(e.day_type_id)?.pay_mode)}
                  </p>
                </div>
                <span className="shrink-0 text-sm tabular-nums">
                  {e.amount.toFixed(2)} {settings.currency}
                </span>
              </li>
            ))}
          </ul>
        )}

        <button
          className="min-h-11 rounded-lg bg-white/10 py-3 text-sm font-medium active:bg-white/20"
          onClick={onOpenPeriod}
        >
          {ru.day.closedPeriodAction}
        </button>
        <button className="min-h-11 rounded-lg bg-white/5 py-3 text-sm active:bg-white/10" onClick={onClose}>
          {ru.day.close}
        </button>
      </div>
    );
  }

  return (
    // min-h-0 обязателен: без него flex-элемент не сжимается ниже своего
    // контента и overflow-y-auto не срабатывает. Лимит высоты — на панели
    // целиком (.day-sheet в CalendarPage), здесь только скроллируемая часть.
    // overflow-x-hidden + touch-pan-y: ряд типов дня намеренно шире шторки на
    // 32px (-mx-4, чтобы кружки доходили до краёв), и от этого САМ вертикальный
    // скроллер получал 16px горизонтальной прокрутки — под пальцем уезжало
    // вбок всё содержимое шторки. Скрытое переполнение убирает саму прокрутку,
    // touch-pan-y запрещает горизонтальный жест целиком: по экрану ввода смены
    // возможно только движение вверх-вниз. Двум внутренним лентам ниже
    // (типы дня и вкладки записей) возвращён touch-pan-x — они прокручиваются
    // сами и это единственное исключение.
    <div className="flex min-h-0 flex-1 touch-pan-y flex-col gap-4 overflow-y-auto overflow-x-hidden pb-[calc(env(safe-area-inset-bottom)+1rem)] text-white">
      {/* Полоска записей — только когда их больше одной: обычный день с одной
          записью должен выглядеть ровно как раньше. */}
      {entries && entries.length > 1 && (
        <div className="flex touch-pan-x gap-2 overflow-x-auto">
          {entries.map((e, index) => (
            <button
              key={e.id}
              onClick={() => handleSelectEntry(e.id)}
              className={`min-h-11 shrink-0 rounded-lg px-3 text-sm ${
                e.id === entry?.id ? "bg-white/15 text-white" : "bg-white/5 text-white/60"
              }`}
            >
              {index + 1}. {dayTypeById.get(e.day_type_id)?.name} · {formatHours(e.hours)}
              {ru.calendar.hoursShort}
            </button>
          ))}
        </div>
      )}

      {/* Раздел 8.2: горизонтальный ряд крупных кружков, по одному на тип дня,
          окрашенных его цветом, со значком внутри. Ряд, а не сетка: типов
          бывает десяток, и сетка из имён занимала бы треть шторки. shrink-0 на
          элементах обязателен — иначе flex сжимает кружки в овалы вместо того,
          чтобы включить прокрутку. */}
      {/* shrink-0 на самом ряду обязателен: шторка ограничена 85dvh, и как
          flex-элемент колонки ряд сжимался до 4px — кружки превращались в
          полоски 56×24, а кнопки получали нулевую высоту. Самый нужный
          элемент экрана оказывался невидимым ровно тогда, когда полей в
          шторке много. */}
      {/* Ряд занимает ровно ширину шторки. Раньше он выходил за её края на
          32px (-mx-4 с обратным px-4), чтобы кружки при прокрутке доходили до
          самого края экрана, — и ровно из-за этого ВЕСЬ вертикальный скроллер
          шторки получал 16px горизонтальной прокрутки. Одного overflow-x:
          hidden мало: скрытое переполнение не отменяет прокрутку программную,
          а её вызывает сама iOS, подводя к фокусу поле у края, — и шторка
          уезжала вбок и там оставалась. Убрана причина, а не симптом.

          pt-1: кольцо выбранного типа (ring-2) рисуется на 2px ЗА границей
          кружка, а обрезают его сразу ДВА предка. Сам ряд — потому что
          overflow-x-auto по спецификации превращает visible на второй оси в
          auto, то есть режет и по вертикали. И вертикальный скроллер шторки,
          на верхней кромке которого ряд стоит вплотную. Снизу запас давал
          pb-1, сверху не давал никто. Компенсировать этот отступ отрицательным
          margin нельзя: он вернул бы ряд на кромку скроллера, и верхушку
          срезал бы уже он. */}
      <div className="flex shrink-0 touch-pan-x gap-3 overflow-x-auto pt-1 pb-1">
        {activeDayTypes.length === 0 && <p className="text-sm text-white/50">{ru.day.noDayTypes}</p>}
        {activeDayTypes.map((dt) => {
          const isSelected = draft?.day_type_id === dt.id;
          return (
            <button
              key={dt.id}
              onClick={() => handleSelectDayType(dt)}
              aria-pressed={isSelected}
              className="flex w-16 shrink-0 flex-col items-center gap-1"
            >
              {/* aria-hidden: значок дублирует имя, стоящее рядом, и без этого
                  доступное имя кнопки превращается в «Н Ночная смена». */}
              <span
                aria-hidden
                className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-base font-semibold text-slate-900 ${
                  isSelected ? "ring-2 ring-white" : ""
                }`}
                style={{ backgroundColor: dt.color }}
              >
                {dt.label}
              </span>
              {/* Имя под кружком: значок из 1–3 символов сам по себе опознаётся
                  не всегда, а «Отпуск» и «Отгул» дают одну и ту же букву. */}
              <span className={`w-full truncate text-center text-[11px] ${isSelected ? "text-white" : "text-white/50"}`}>
                {dt.name}
              </span>
            </button>
          );
        })}
        <button
          onClick={onCreateDayType}
          aria-label={ru.day.createDayType}
          className="flex w-16 shrink-0 flex-col items-center gap-1"
        >
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-dashed border-white/30 text-xl text-white/60">
            +
          </span>
          <span className="w-full truncate text-center text-[11px] text-white/50">{ru.day.createDayTypeShort}</span>
        </button>
      </div>

      {/* Раздел 5.3: заметка типа дня «видна при выборе типа». Отдельной
          строкой под рядом, а не подписью под кружком (в колонке 64px не
          помещается) и не атрибутом title: на телефоне тултипа не существует,
          и поле молча не делало бы ничего. Высота зарезервирована — иначе
          выбор типа с заметкой сдвигал бы вниз всю шторку. */}
      <p className="-mt-2 min-h-[1rem] shrink-0 truncate text-xs text-white/40">{dayType?.note ?? ""}</p>

      {draft && dayType && (
        <>
          <div>
            <label className="text-xs text-white/50" htmlFor="day-hours">{ru.day.hours}</label>
            <div className="mt-1 flex items-center gap-3">
              {/* 44px, а не 40: меньший размер не добирает до минимальной цели
                  нажатия на телефоне (инвариант 59), а по этим двум кнопкам
                  часы правятся чаще всего. */}
              <button
                className="h-11 w-11 rounded-full bg-white/10 text-lg active:bg-white/20"
                onClick={() => handleHoursChange(Math.max(0, draft.hours - 0.5))}
              >
                −
              </button>
              <NumberInput
                id="day-hours"
                className="w-20 rounded-lg bg-white/5 px-2 py-2 text-center text-lg"
                value={draft.hours}
                onChange={handleHoursChange}
                // Выведенная из времён длительность хранится неокруглённой
                // (7ч20м = 7.333333333333333), иначе на смене теряются гроши.
                // В поле шириной 80px её показывает formatHours.
                format={formatHours}
              />
              <button
                className="h-11 w-11 rounded-full bg-white/10 text-lg active:bg-white/20"
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
                <label className="text-xs text-white/50" htmlFor="day-multiplier">{ru.day.multiplier}</label>
                <NumberInput
                  id="day-multiplier"
                  className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2 text-lg"
                  value={draft.multiplier}
                  onChange={handleMultiplierChange}
                />
                {/* Строка видна всегда, поэтому резервировать высоту через
                    invisible больше не нужно — скачков вёрстки не будет. */}
                <p className="mt-1 text-xs text-white/40">
                  {sourceLabel ? `${sourceLabel}, ×${draft.multiplier}` : `×${draft.multiplier}`}
                </p>
              </div>
              <div>
                <label className="text-xs text-white/50" htmlFor="day-rate">{ru.day.rate}</label>
                <NumberInput
                  id="day-rate"
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

          {/* Раздел 8.6: вход в список праздников и в множитель праздника —
              отсюда, потому что до блока 7 в /settings не ведёт ничего, а
              «праздник» под множителем иначе остаётся подписью, на которую
              нельзя повлиять.

              Строка рисуется в обоих состояниях с одинаковой структурой:
              условный ряд, появляющийся только по праздникам, двигал бы всё
              ниже себя ровно в тот момент, когда пользователь целится в поле
              суммы. */}
          <button
            onClick={() => onOpenHolidays(holiday ? {} : { addDate: date })}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 text-left active:bg-white/10"
          >
            {/* min-w-0 + truncate: имя праздника пользовательское и длины
                произвольной, а выталкивать кнопку за край нельзя (инвариант 26). */}
            <span className="min-w-0 truncate text-xs text-white/50">
              {holiday ? `${ru.day.holidayRowPrefix} ${holiday.name}` : ru.day.holidayRowNone}
            </span>
            <span className="shrink-0 text-xs font-semibold text-app-accent">
              {holiday ? ru.day.holidayRowEdit : ru.day.holidayRowAdd}
            </span>
          </button>

          {/* Раздел 8.4: базовая ставка периода правится на экране периода, а не
              здесь, поэтому подсказка не поле, а путь туда. Ряд на всю ширину,
              а не подпись под множителем: в колонке 175px этот текст занял бы
              три строки и развалил бы сетку двух полей. */}
          {showNoBaseRateHint && (
            <button
              onClick={onOpenPeriod}
              className="flex min-h-11 items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 text-left active:bg-white/10"
            >
              <span className="text-xs text-white/50">{ru.day.hintNoBaseRate}</span>
              <span className="shrink-0 text-xs font-semibold text-app-accent">{ru.day.hintNoBaseRateAction}</span>
            </button>
          )}

          {/* Раздел 8.2: начало, конец и перерыв. Раскрывающийся блок, а не
              настройка: settings.show_shift_times задаёт лишь начальное
              состояние, а включить его до блока 7 не может никто — по одной
              настройке раздел 6.1 остался бы невидимым на телефоне.

              Рост шторки здесь начинает сам человек, поэтому резервировать
              высоту всего блока не нужно; резервируются только две строки
              ВНУТРИ него — предупреждение о перерыве и строка связи, — иначе
              они появлялись бы сами и двигали поля под пальцем. */}
          <div className="shrink-0">
            <button
              onClick={() => setShiftTimesOpen((open) => !open)}
              aria-expanded={shiftTimesOpen}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2 text-left active:bg-white/10"
            >
              <span className="text-xs text-white/50">{ru.day.shiftTimes}</span>
              <span className="shrink-0 text-xs font-semibold text-app-accent">
                {shiftTimesOpen ? ru.day.shiftTimesHide : ru.day.shiftTimesShow}
              </span>
            </button>

            {shiftTimesOpen && (
              <>
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-white/50" htmlFor="day-start-time">{ru.day.startTime}</label>
                    <input
                      id="day-start-time"
                      type="time"
                      className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2"
                      value={draft.start_time ?? ""}
                      onChange={(e) => handleShiftTimeChange({ start_time: e.target.value || null })}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/50" htmlFor="day-end-time">{ru.day.endTime}</label>
                    <input
                      id="day-end-time"
                      type="time"
                      className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2"
                      value={draft.end_time ?? ""}
                      onChange={(e) => handleShiftTimeChange({ end_time: e.target.value || null })}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-white/50" htmlFor="day-break-minutes">{ru.day.breakMinutes}</label>
                    <input
                      id="day-break-minutes"
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

                {/* Инвариант 30: перерыв длиннее смены — предупреждение, а не
                    запрет. Высота зарезервирована. */}
                <p className={`mt-1 text-xs text-white/40 ${duration?.break_exceeds_shift ? "" : "invisible"}`}>
                  {ru.day.hintBreakExceedsShift}
                </p>

                {/* Раздел 8.2: состояние связи «часы ↔ времена» и кнопка её
                    вернуть. Строка рисуется всегда с одинаковой высотой —
                    кнопка, появляющаяся сама, сдвигала бы поля ровно тогда,
                    когда человек в них целится. */}
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-xs text-white/40">
                    {duration?.derived
                      ? ru.day.durationDerived
                      : duration?.can_derive
                        ? ru.day.durationManual
                        : ""}
                  </span>
                  {duration && !duration.derived && duration.can_derive && (
                    <button
                      onClick={handleRestoreDurationLink}
                      className="shrink-0 text-xs font-semibold text-app-accent active:opacity-70"
                    >
                      {ru.day.durationRestoreLink}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
            <span className="text-sm">{ru.day.manualAmountToggle}</span>
            {/* Область нажатия 44px по высоте, дорожка внутри остаётся 24px:
                сам переключатель ростом с дорожку — цель в 24px, вдвое меньше
                минимальной (инвариант 59). -my-2 съедает добавленную высоту,
                чтобы строка не растолстела. */}
            <button
              role="switch"
              aria-checked={isManualAmount}
              onClick={() => handleToggleManualAmount(!isManualAmount)}
              className="-my-2 flex h-11 w-11 items-center justify-end"
            >
              <span
                className={`relative block h-6 w-11 rounded-full transition-colors ${isManualAmount ? "bg-app-accent" : "bg-white/20"}`}
              >
                {/* Absolute + left, not transform — a translate-based knob depends on the
                    parent not being a flex/centered container; absolute positioning against
                    an explicit `relative` parent has no such ambiguity. */}
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-[left] ${
                    isManualAmount ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </span>
            </button>
          </div>

          <div>
            <label className="text-xs text-white/50" htmlFor="day-amount">{ru.day.amount}</label>
            {/* Валюта в одной строке с числом: отдельным <p> в 24px под полем она
                читалась как ещё одно поле. min-w-0 обязателен — без него flex-элемент
                с длинным числом не сожмётся и вытолкнет валюту за край. */}
            <div className="mt-1 flex items-center gap-2 rounded-lg bg-white/5 px-2">
              <NumberInput
                id="day-amount"
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
            <label className="text-xs text-white/50" htmlFor="day-note">{ru.day.note}</label>
            <textarea
              id="day-note"
              className="mt-1 w-full rounded-lg bg-white/5 px-2 py-2 text-sm"
              placeholder={ru.day.notePlaceholder}
              value={draft.note}
              onChange={(e) => handleNoteChange(e.target.value)}
              rows={2}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <button className="min-h-11 py-3 text-sm text-white/50 active:text-white/70" onClick={handleAddEntry}>
              {ru.day.addEntry}
            </button>
            {/* Только для строки, которая уже есть в базе: у начатой новой
                записи удалять нечего, а entry в этот момент показывает первую
                запись дня — кнопка удалила бы чужую. */}
            {entry && !creatingNew && (
              <button className="min-h-11 py-3 text-sm text-white/50 active:text-white/70" onClick={handleDelete}>
                {ru.day.deleteEntry}
              </button>
            )}
          </div>
        </>
      )}

      {/* Основное действие ниже всех и во всю ширину (инвариант 59): именно им
          заканчивается ввод смены. Неактивна, когда сохранять нечего, — это
          видимое состояние, а не молчаливое бездействие. */}
      <button
        className="min-h-11 rounded-lg bg-app-accent py-3 text-sm font-semibold text-slate-900 active:opacity-80 disabled:opacity-40"
        disabled={!isDirty || saving}
        onClick={() => void handleSave()}
      >
        {isDirty ? ru.day.save : ru.day.saved}
      </button>

      <button
        className="rounded-lg bg-white/10 py-3 text-sm font-medium active:bg-white/20"
        onClick={() => guardDraft(onClose)}
      >
        {ru.day.close}
      </button>

      {/* Раздел 8.2: единственное место в приложении, где набранное можно
          потерять. Закрытие по фону — это «остаться», а не «выбросить»:
          случайный тап мимо не должен стоить смены. */}
      {pendingDiscard && (
        <div
          className="day-sheet-overlay fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setPendingDiscard(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-slate-900 p-4 text-white"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-base font-semibold">{ru.day.unsavedTitle}</p>
            <p className="mt-2 text-sm text-white/50">{ru.day.unsavedBody}</p>
            <div className="mt-4 flex gap-3">
              <button
                className="min-h-11 flex-1 rounded-lg bg-white/10 py-3 text-sm font-medium active:bg-white/20"
                onClick={() => {
                  const action = pendingDiscard;
                  setPendingDiscard(null);
                  setTouched(false);
                  // Черновик возвращаем к сохранённому состоянию строки: иначе
                  // брошенные значения остались бы на экране записи, к которой
                  // они не относятся.
                  if (baseline) setDraft(baseline);
                  setCreatingNew(false);
                  action();
                }}
              >
                {ru.day.unsavedDiscard}
              </button>
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-accent py-3 text-sm font-semibold text-slate-900 active:opacity-80"
                onClick={() => {
                  const action = pendingDiscard;
                  setPendingDiscard(null);
                  void handleSave().then((ok) => {
                    if (ok) action();
                  });
                }}
              >
                {ru.day.unsavedSave}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
