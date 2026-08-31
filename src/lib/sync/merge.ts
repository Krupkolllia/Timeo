import type { BaseRecord, DayType, Entry } from "@/types/models";
import type { RemoteRow } from "@/lib/sync/types";

/**
 * Насколько часы устройства могут опережать серверные, прежде чем их отметке
 * времени перестают верить. Сутки — с запасом на часовой пояс, летнее время и
 * телефон, забывший синхронизировать время: такое расхождение бывает у
 * исправного устройства, расхождение в год — нет.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function ms(iso: string): number {
  const value = Date.parse(iso);
  // Непарсимая отметка времени — это строка, которой в базе быть не должно
  // вовсе. Считаем её бесконечно старой: она проиграет любой осмысленной
  // версии, а не выиграет у всех сразу.
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Инвариант 42. updated_at приходит с часов телефона, и телефон с часами на год
 * вперёд выигрывал бы каждый конфликт до конца этого года. Поэтому отметка,
 * ушедшая в будущее дальше допуска, при сравнении заменяется на серверную —
 * то есть на момент, когда сервер эту строку действительно принял.
 *
 * Для локальной строки серверной отметки нет (её ещё не принимали): такая
 * строка сравнивается по текущему серверному времени, а при выгрузке её
 * updated_at чинится (clampFutureUpdatedAt) — иначе «навсегда» вернулось бы.
 */
export function comparableUpdatedAt(
  row: { updated_at: string; server_updated_at?: string | null },
  serverNow: string,
): number {
  const own = ms(row.updated_at);
  if (own <= ms(serverNow) + CLOCK_SKEW_TOLERANCE_MS) return own;
  return row.server_updated_at ? ms(row.server_updated_at) : ms(serverNow);
}

export type Winner = "local" | "remote";

/**
 * Инвариант 41: last-write-wins по updated_at, построчно. Ничья достаётся
 * облаку — это общая для всех устройств версия, и на ней обмен затихает, а не
 * начинает гонять строку туда-обратно.
 */
export function resolveRow(
  local: { updated_at: string },
  remote: { updated_at: string; server_updated_at?: string | null },
  serverNow: string,
): Winner {
  const l = comparableUpdatedAt(local, serverNow);
  const r = comparableUpdatedAt(remote, serverNow);
  return l > r ? "local" : "remote";
}

/**
 * Чинит отметку времени, ушедшую в будущее, перед выгрузкой: и в облако, и в
 * локальную базу уезжает серверное «сейчас».
 *
 * Ни одно число не меняется — только момент последней правки, — поэтому
 * закрытого периода это не касается в смысле инварианта 2: его суммы лежат в
 * closed_totals и здесь не открываются вовсе.
 */
export function clampFutureUpdatedAt<T extends BaseRecord>(row: T, serverNow: string): T {
  if (ms(row.updated_at) <= ms(serverNow) + CLOCK_SKEW_TOLERANCE_MS) return row;
  return { ...row, updated_at: serverNow };
}

/**
 * Одинаковы ли строки по содержимому. Ключи сортируются: порядок полей у
 * объекта из Dexie и у строки из Postgres разный, а разными строки от этого не
 * становятся.
 */
export function rowsEqual(a: BaseRecord, b: BaseRecord): boolean {
  // Сортировка нужна на всех уровнях, а не только на верхнем: closed_totals и
  // weekend_multipliers — это jsonb, а Postgres хранит его ключи в своём
  // порядке. Вернувшаяся строка отличалась бы от отправленной, и эхо
  // собственной выгрузки записывалось бы в базу заново каждый цикл.
  const canon = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canon);
    if (value === null || typeof value !== "object") return value;
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "server_updated_at")
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([key, item]) => [key, canon(item)]);
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export interface PullPlan<T extends BaseRecord> {
  /** Строки, которые надо записать в локальную базу. */
  apply: T[];
  /** Идентификаторы строк, где победила локальная версия — их надо выгрузить. */
  keptLocal: string[];
}

/** Общий случай: периоды, праздники, настройки. Только LWW, построчно. */
export function planPull<T extends BaseRecord>(
  local: Map<string, T>,
  remote: RemoteRow<T>[],
  serverNow: string,
): PullPlan<T> {
  const apply: T[] = [];
  const keptLocal: string[] = [];

  for (const row of remote) {
    const own = local.get(row.id);
    const incoming = stripServerColumn(row);
    if (!own) {
      apply.push(incoming);
      continue;
    }
    // Эхо собственной выгрузки: строка вернулась ровно такой, какой уехала.
    // Записывать её незачем, и считать «принятой» — тоже, иначе экран сообщал
    // бы о синхронизации, которой не было.
    if (rowsEqual(own, incoming)) continue;
    if (resolveRow(own, row, serverNow) === "remote") apply.push(incoming);
    else keptLocal.push(row.id);
  }

  return { apply, keptLocal };
}

/** Серверная отметка живёт только в облаке и в курсоре докачки — в локальную модель она не входит. */
export function stripServerColumn<T extends BaseRecord>(row: RemoteRow<T>): T {
  const copy = { ...row } as unknown as Record<string, unknown>;
  delete copy.server_updated_at;
  return copy as unknown as T;
}

export interface DayTypePullPlan extends PullPlan<DayType> {
  /**
   * Инвариант 37: приехало удаление типа дня, на который локально ссылаются
   * живые записи. Побеждает та версия, в которой тип существует, — тип
   * остаётся живым и уезжает обратно в облако.
   */
  resurrect: DayType[];
}

export function planDayTypesPull(
  local: Map<string, DayType>,
  remote: RemoteRow<DayType>[],
  serverNow: string,
  referencedTypeIds: ReadonlySet<string>,
): DayTypePullPlan {
  const base = planPull(local, remote, serverNow);
  const apply: DayType[] = [];
  const resurrect: DayType[] = [];

  for (const row of base.apply) {
    if (row.deleted_at !== null && referencedTypeIds.has(row.id)) {
      // Берём приехавшую версию, а не локальную: в base.apply строка попадает
      // только когда своей версии нет вовсе либо удалённая выиграла
      // last-write-wins, то есть локальная здесь заведомо устаревшая. Разлив её
      // обратно (воскрешённое уходит в forcePush) откатил бы переименование и
      // множитель на всех устройствах. Отменяем только удаление.
      resurrect.push({ ...row, deleted_at: null, updated_at: serverNow });
      continue;
    }
    apply.push(row);
  }

  return { apply, keptLocal: base.keptLocal, resurrect };
}

export interface EntryPullPlan extends PullPlan<Entry> {
  /**
   * Инвариант 37: запись приехала раньше своего типа дня. Не пишем её вовсе —
   * запись без типа не открывается на экране дня и не считается в итогах. Она
   * приедет на следующем проходе, когда тип уже будет.
   */
  deferred: Entry[];
}

export function planEntriesPull(
  local: Map<string, Entry>,
  remote: RemoteRow<Entry>[],
  serverNow: string,
  knownTypeIds: ReadonlySet<string>,
): EntryPullPlan {
  const base = planPull(local, remote, serverNow);
  const apply: Entry[] = [];
  const deferred: Entry[] = [];

  for (const row of base.apply) {
    // Удаление применяем всегда: осиротить оно не может, а держать его до
    // приезда типа значило бы показывать день, который человек стёр.
    if (row.deleted_at === null && !knownTypeIds.has(row.day_type_id)) deferred.push(row);
    else apply.push(row);
  }

  return { apply, keptLocal: base.keptLocal, deferred };
}
