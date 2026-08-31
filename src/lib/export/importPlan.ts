import type { BackupFile } from "@/lib/export/backup";
import type { DayType, Entry, Holiday, Period, Settings } from "@/types/models";

/** Инвариант 47: два режима, и молчаливое слияние никогда не по умолчанию. */
export type ImportMode = "replace" | "merge";

export interface ImportPlanInput {
  file: BackupFile;
  current: {
    settings: Settings | null;
    periods: Period[];
    day_types: DayType[];
    entries: Entry[];
    holidays: Holiday[];
  };
  mode: ImportMode;
  /** Локальный идентификатор пользователя, на который переписываются все строки файла. */
  userId: string;
  /** Генератор идентификаторов — параметром, чтобы план был проверяем без моков crypto. */
  newId: () => string;
}

export interface ImportCounts {
  periods: number;
  day_types: number;
  entries: number;
  holidays: number;
  /** Записи, у которых day_type_id пришлось переписать (инвариант 36). */
  repointed_entries: number;
  /** Типы дня, созданные заново из-за занятого идентификатора. */
  recreated_day_types: number;
  /** Записи, чей тип дня не нашёлся нигде и был заменён восстановительным. */
  recovered_entries: number;
  /** Строки, уже существующие в базе и потому пропущенные (только режим merge). */
  skipped: number;
}

export interface ImportPlan {
  mode: ImportMode;
  /** Полностью очистить таблицы перед записью (режим replace). */
  clearAll: boolean;
  settings: Settings | null;
  /** Режим merge: точечная правка существующей строки настроек, см. ниже. */
  settingsPatch: Partial<Settings> | null;
  periods: Period[];
  day_types: DayType[];
  entries: Entry[];
  holidays: Holiday[];
  counts: ImportCounts;
}

export const RECOVERED_DAY_TYPE_NAME = "Тип дня не найден";

/**
 * Одна и та же строка или две разные, случайно получившие один идентификатор?
 *
 * uuid v4 не совпадают случайно, поэтому реальный источник совпадения — это
 * одна и та же строка, приехавшая через файл. Отличаем по created_at: момент
 * создания в этом коде не переписывается нигде и никогда (все правки трогают
 * только updated_at), поэтому он и есть свидетельство о рождении строки.
 *
 * Инвариант 36 требует обработать и невозможный случай: идентификатор занят
 * ДРУГИМ типом — тогда тип создаётся заново, а записи перенаправляются на него.
 */
function isSameRow(a: { created_at: string }, b: { created_at: string }): boolean {
  return a.created_at === b.created_at;
}

function withUser<T extends { user_id: string }>(row: T, userId: string): T {
  // Файл приехал с другого устройства, где локальный user_id другой. Без этой
  // перезаписи строки лягут в базу и не найдутся ни одним запросом — с экрана
  // это выглядит как «импорт ничего не сделал».
  return { ...row, user_id: userId };
}

function makeRecoveredDayType(id: string, sortOrder: number, userId: string, now: string): DayType {
  return {
    id,
    user_id: userId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    name: RECOVERED_DAY_TYPE_NAME,
    color: "#94a3b8",
    label: "?",
    note: "Создан при восстановлении из файла: записи ссылались на тип дня, которого в файле нет",
    pay_mode: "hourly",
    rate_mode: "multiplier",
    fixed_amount: null,
    // Часы такой записи всё же отработаны: сумма у записи своя и от типа не
    // зависит вовсе (раздел 6.4), а вот в часах периода их отсутствие было бы
    // молчаливой потерей.
    counts_as_work: true,
    counts_toward_norm: true,
    default_hours: 8,
    default_start: null,
    default_end: null,
    default_break_minutes: null,
    default_break_paid_minutes: null,
    default_multiplier: 1,
    default_rate: null,
    ignore_auto_multipliers: false,
    sort_order: sortOrder,
    // В архив: это аварийная строка, и предлагать её в выборе типа дня незачем.
    is_archived: true,
  };
}

/**
 * Инварианты 36, 47 и 49. Чистая функция над обычными массивами: ни Dexie, ни
 * React, ни времени — всё решается ДО открытия транзакции, чтобы запись была
 * одним неделимым куском.
 *
 * replace: база очищается целиком, строки файла ложатся под своими
 * идентификаторами.
 *
 * merge («добавить недостающее»): существующие строки не трогаются вовсе.
 * Добавляется только то, чего нет, и правится единственное поле настроек —
 * seeded_holiday_years, см. ниже.
 */
export function planImport(input: ImportPlanInput): ImportPlan {
  const { file, current, mode, userId, newId } = input;
  const now = new Date().toISOString();

  const counts: ImportCounts = {
    periods: 0,
    day_types: 0,
    entries: 0,
    holidays: 0,
    repointed_entries: 0,
    recreated_day_types: 0,
    recovered_entries: 0,
    skipped: 0,
  };

  const replace = mode === "replace";

  // Существующие строки берём ВМЕСТЕ с мягко удалёнными: идентификатор занят и
  // ими тоже (инвариант 38 держит их в базе), а вставка по занятому ключу
  // молча перетёрла бы строку.
  const localDayTypes = replace ? new Map<string, DayType>() : new Map(current.day_types.map((row) => [row.id, row]));
  const localEntries = replace ? new Map<string, Entry>() : new Map(current.entries.map((row) => [row.id, row]));
  const localHolidays = replace ? new Map<string, Holiday>() : new Map(current.holidays.map((row) => [row.id, row]));
  // Только живые: мягко удалённой строки для пользователя не существует
  // (инвариант 38), и «добавить недостающее» обязано считать её месяц
  // свободным — иначе восстановление молча не вернуло бы удалённый период.
  const livePeriods = current.periods.filter((row) => row.deleted_at === null);
  const localPeriods = replace ? new Map<string, Period>() : new Map(livePeriods.map((row) => [row.id, row]));
  // Период опознаётся не только по id: две строки на один year+month сломали бы
  // выборку периода (она берёт .first()), и месяц раздвоился бы навсегда.
  const localPeriodByMonth = replace
    ? new Map<string, Period>()
    : new Map(livePeriods.map((row) => [`${row.year}:${row.month}`, row]));

  const dayTypeIdMap = new Map<string, string>();
  const dayTypes: DayType[] = [];

  let maxSortOrder = 0;
  for (const row of current.day_types) maxSortOrder = Math.max(maxSortOrder, row.sort_order);
  for (const row of file.day_types) maxSortOrder = Math.max(maxSortOrder, row.sort_order);

  for (const imported of file.day_types) {
    const local = localDayTypes.get(imported.id);
    if (!local) {
      dayTypes.push(withUser(imported, userId));
      counts.day_types++;
      continue;
    }
    if (isSameRow(local, imported)) {
      // Та же самая строка. «Добавить недостающее» ничего не перезаписывает:
      // локальная версия может быть новее файла, и переименованный тип не
      // должен откатываться к своему прежнему имени.
      counts.skipped++;
      continue;
    }
    // Идентификатор занят ДРУГИМ типом — инвариант 36 буквально про этот
    // случай: создаём новый и запоминаем подмену для записей.
    const replacementId = newId();
    dayTypeIdMap.set(imported.id, replacementId);
    dayTypes.push({ ...withUser(imported, userId), id: replacementId, sort_order: ++maxSortOrder });
    counts.day_types++;
    counts.recreated_day_types++;
  }

  // Какие идентификаторы типов дня будут существовать в базе ПОСЛЕ импорта.
  const knownDayTypeIds = new Set<string>([...localDayTypes.keys(), ...dayTypes.map((row) => row.id)]);

  let recoveredDayTypeId: string | null = null;
  const entries: Entry[] = [];

  for (const imported of file.entries) {
    const local = localEntries.get(imported.id);
    if (local && isSameRow(local, imported)) {
      counts.skipped++;
      continue;
    }

    let dayTypeId = imported.day_type_id;
    const remapped = dayTypeIdMap.get(dayTypeId);
    if (remapped) {
      dayTypeId = remapped;
      counts.repointed_entries++;
    } else if (!knownDayTypeIds.has(dayTypeId)) {
      // Инвариант 36: осиротевших записей после импорта быть не может. Тип
      // отсутствует и в файле, и в базе — заводим аварийный и показываем его
      // в итогах импорта. Выбросить запись нельзя: в ней лежит сумма.
      if (recoveredDayTypeId === null) {
        recoveredDayTypeId = newId();
        dayTypes.push(makeRecoveredDayType(recoveredDayTypeId, ++maxSortOrder, userId, now));
        knownDayTypeIds.add(recoveredDayTypeId);
        counts.day_types++;
      }
      dayTypeId = recoveredDayTypeId;
      counts.repointed_entries++;
      counts.recovered_entries++;
    }

    // Идентификатор занят другой записью — та же логика, что и у типов дня,
    // только перенаправлять на неё некого.
    const id = local ? newId() : imported.id;
    entries.push({ ...withUser(imported, userId), id, day_type_id: dayTypeId });
    counts.entries++;
  }

  const periods: Period[] = [];
  // Внутри одного месяца строка может быть только одна: выборка периода берёт
  // .first(), и две живые строки на один year+month раздваивали бы месяц
  // навсегда — какая из них выиграет, зависело бы от порядка ключей. Файл с
  // таким содержимым (правленный руками, записанный сломанной сборкой) не
  // должен превращаться в неисправимую базу. Побеждает самая ранняя по
  // created_at, при равенстве — по id: то же правило, что и у праздников на
  // одну дату (инвариант 53).
  const importedByMonth = new Map<string, Period>();
  for (const imported of file.periods) {
    const key = `${imported.year}:${imported.month}`;
    const rival = importedByMonth.get(key);
    if (!rival) {
      importedByMonth.set(key, imported);
      continue;
    }
    const winner =
      imported.created_at < rival.created_at ||
      (imported.created_at === rival.created_at && imported.id < rival.id)
        ? imported
        : rival;
    importedByMonth.set(key, winner);
    counts.skipped++;
  }

  for (const imported of importedByMonth.values()) {
    const local = localPeriods.get(imported.id);
    if (local && isSameRow(local, imported)) {
      counts.skipped++;
      continue;
    }
    // Месяц уже есть в базе — «добавить недостающее» его не трогает.
    // Переписать его значило бы изменить чужой период, в том числе закрытый
    // (инварианты 1 и 2).
    if (localPeriodByMonth.has(`${imported.year}:${imported.month}`)) {
      counts.skipped++;
      continue;
    }
    const id = local ? newId() : imported.id;
    periods.push({ ...withUser(imported, userId), id });
    counts.periods++;
  }

  const holidays: Holiday[] = [];
  for (const imported of file.holidays) {
    const local = localHolidays.get(imported.id);
    if (local && isSameRow(local, imported)) {
      counts.skipped++;
      continue;
    }
    // Два праздника на одну дату законны (инвариант 53), поэтому по дате здесь
    // ничего не отсеивается — только по идентификатору.
    const id = local ? newId() : imported.id;
    holidays.push({ ...withUser(imported, userId), id });
    counts.holidays++;
  }

  // В режиме merge строка настроек тоже «недостающая», если её нет вовсе:
  // база, у которой ещё не было первого запуска, иначе осталась бы без валюты,
  // дня начала периода и множителей, а экраны ждут эту строку как обязательную.
  const settings = (replace || !current.settings) && file.settings ? withUser(file.settings, userId) : null;

  // Единственная правка существующей строки в режиме merge, и она обязательна.
  // Посев праздников (раздел 5.5) считает год незасеянным, пока его нет в
  // seeded_holiday_years, — а праздники из файла уже лежат в базе. Без этого
  // объединения ближайший запуск засеял бы те же годы поверх импортированных и
  // задвоил каждую дату.
  const settingsPatch =
    !replace && current.settings && file.settings
      ? {
          seeded_holiday_years: [
            ...new Set([...current.settings.seeded_holiday_years, ...file.settings.seeded_holiday_years]),
          ].sort((a, b) => a - b),
        }
      : null;

  return { mode, clearAll: replace, settings, settingsPatch, periods, day_types: dayTypes, entries, holidays, counts };
}
