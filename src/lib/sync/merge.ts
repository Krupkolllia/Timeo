import type { BaseRecord, DayType, Entry, Period } from "@/types/models";
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
 * объекта из Dexie и у строки из Postgres разный, а разными строки от этого
 * не становятся.
 */
export function rowsEqual(a: BaseRecord, b: BaseRecord): boolean {
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

/**
 * Общий случай: обычное построчное сопоставление по id.
 */
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

    if (rowsEqual(own, incoming)) continue;

    if (resolveRow(own, row, serverNow) === "remote") {
      apply.push(incoming);
    } else {
      keptLocal.push(row.id);
    }
  }

  return { apply, keptLocal };
}

/**
 * Period — особенный случай.
 *
 * В PostgreSQL логическая уникальность периода:
 *
 *   user_id + year + month
 *
 * поэтому два разных UUID для одного месяца нельзя считать двумя независимыми
 * строками.
 *
 * removeLocalIds нужны, когда победил remote period с другим UUID: старую
 * локальную строку надо убрать ДО записи remote, иначе локально будут два live
 * периода одного месяца.
 */
export interface PeriodPullPlan extends PullPlan<Period> {
  removeLocalIds: string[];
}

/**
 * Планирование pull для periods.
 *
 * Алгоритм:
 * 1. Сопоставляем сначала по id.
 * 2. Если id другой, ищем уже существующий live period того же месяца.
 * 3. При конфликте применяем существующее LWW-правило.
 * 4. Победил remote → старый local id удаляется из локальной DB, remote
 *    применяется.
 * 5. Победил local → remote пропускается, local id идёт в forcePush.
 *
 * Дополнительно remote строки одного месяца внутри одной страницы тоже
 * дедуплицируются: обработка идёт последовательно, а не по исходному snapshot
 * local map.
 */
export function planPeriodsPull(
    local: Map<string, Period>,
    remote: RemoteRow<Period>[],
    serverNow: string,
): PeriodPullPlan {
  const localByMonth = new Map<string, Period>();

  for (const row of local.values()) {
    if (row.deleted_at !== null) continue;

    const key = `${row.user_id}\u0000${row.year}\u0000${row.month}`;
    const existing = localByMonth.get(key);

    if (!existing) {
      localByMonth.set(key, row);
      continue;
    }

    // Если старый клиент уже создал несколько live periods одного месяца,
    // временно выбираем наиболее свежую локальную версию как кандидата.
    const winner =
        resolveRow(existing, row, serverNow) === "remote"
            ? row
            : existing;

    localByMonth.set(key, winner);
  }

  const apply: Period[] = [];
  const keptLocal = new Set<string>();
  const removeLocalIds = new Set<string>();

  // Что уже решили принять/оставить в рамках этой remote-страницы.
  const remoteByMonth = new Map<string, Period>();

  for (const row of remote) {
    const incoming = stripServerColumn(row);

    // Удалённые remote rows не участвуют в live month uniqueness.
    // Их обычное id-based поведение должно сохраниться.
    if (row.deleted_at !== null) {
      const own = local.get(row.id);

      if (!own) {
        apply.push(incoming);
      } else if (!rowsEqual(own, incoming)) {
        if (resolveRow(own, row, serverNow) === "remote") {
          apply.push(incoming);
        } else {
          keptLocal.add(own.id);
        }
      }

      continue;
    }

    const sameId = local.get(row.id);

    // Обычный случай: тот же period по id.
    if (sameId) {
      if (rowsEqual(sameId, incoming)) continue;

      if (resolveRow(sameId, row, serverNow) === "remote") {
        apply.push(incoming);

        const key = `${row.user_id}\u0000${row.year}\u0000${row.month}`;
        remoteByMonth.set(key, incoming);
      } else {
        keptLocal.add(sameId.id);
      }

      continue;
    }

    const key = `${row.user_id}\u0000${row.year}\u0000${row.month}`;

    // Сначала проверяем уже принятый remote period этой страницы.
    const acceptedRemote = remoteByMonth.get(key);

    if (acceptedRemote) {
      // В одной remote page пришёл второй live period того же месяца.
      // Сравниваем их по LWW и оставляем только победителя.
      if (resolveRow(acceptedRemote, row, serverNow) === "remote") {
        const index = apply.findIndex(
            (candidate) => candidate.id === acceptedRemote.id,
        );

        if (index >= 0) {
          apply[index] = incoming;
        }

        remoteByMonth.set(key, incoming);
      }

      continue;
    }

    const sameMonth = localByMonth.get(key);

    // Такого месяца локально нет — remote можно принять.
    if (!sameMonth) {
      apply.push(incoming);
      remoteByMonth.set(key, incoming);
      continue;
    }

    // Один и тот же logical period, но разные UUID.
    if (resolveRow(sameMonth, row, serverNow) === "remote") {
      removeLocalIds.add(sameMonth.id);
      apply.push(incoming);
      remoteByMonth.set(key, incoming);
    } else {
      keptLocal.add(sameMonth.id);
    }
  }

  return {
    apply,
    keptLocal: [...keptLocal],
    removeLocalIds: [...removeLocalIds],
  };
}

/** Серверная отметка живёт только в облаке и в курсоре докачки. */
export function stripServerColumn<T extends BaseRecord>(row: RemoteRow<T>): T {
  const copy = { ...row } as unknown as Record<string, unknown>;
  delete copy.server_updated_at;
  return copy as unknown as T;
}

export interface DayTypePullPlan extends PullPlan<DayType> {
  /**
   * Инвариант 37: приехало удаление типа дня, на который локально ссылаются
   * живые записи.
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
      resurrect.push({
        ...row,
        deleted_at: null,
        updated_at: serverNow,
      });
      continue;
    }

    apply.push(row);
  }

  return {
    apply,
    keptLocal: base.keptLocal,
    resurrect,
  };
}

export interface EntryPullPlan extends PullPlan<Entry> {
  /**
   * Инвариант 37: запись приехала раньше своего типа дня.
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
    if (row.deleted_at === null && !knownTypeIds.has(row.day_type_id)) {
      deferred.push(row);
    } else {
      apply.push(row);
    }
  }

  return {
    apply,
    keptLocal: base.keptLocal,
    deferred,
  };
}
