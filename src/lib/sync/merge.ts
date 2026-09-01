import type {
  BaseRecord,
  DayType,
  Entry,
  Holiday,
  Period,
} from "@/types/models";
import type { RemoteRow } from "@/lib/sync/types";

export const CLOCK_SKEW_TOLERANCE_MS =
    24 * 60 * 60 * 1000;

function ms(iso: string): number {
  const value = Date.parse(iso);

  return Number.isNaN(value)
      ? 0
      : value;
}

function dayTypeLogicalKey(
    row: Pick<
        DayType,
        "user_id" | "name" | "pay_mode"
    >,
): string {
  return [
    row.user_id,
    row.name.trim().toLowerCase(),
    row.pay_mode,
  ].join("\u0000");
}

function holidayLogicalKey(
    row: Pick<
        Holiday,
        "user_id" | "date" | "name" | "is_custom"
    >,
): string {
  return [
    row.user_id,
    row.date,
    row.name.trim().toLowerCase(),
    row.is_custom,
  ].join("\u0000");
}

export function comparableUpdatedAt(
    row: {
      updated_at: string;
      server_updated_at?:
          | string
          | null;
    },
    serverNow: string,
): number {
  const own = ms(row.updated_at);

  if (
      own <=
      ms(serverNow) +
      CLOCK_SKEW_TOLERANCE_MS
  ) {
    return own;
  }

  return row.server_updated_at
      ? ms(row.server_updated_at)
      : ms(serverNow);
}

export type Winner =
    | "local"
    | "remote";

export function resolveRow(
    local: {
      updated_at: string;
    },
    remote: {
      updated_at: string;
      server_updated_at?:
          | string
          | null;
    },
    serverNow: string,
): Winner {
  const l =
      comparableUpdatedAt(
          local,
          serverNow,
      );

  const r =
      comparableUpdatedAt(
          remote,
          serverNow,
      );

  return l > r
      ? "local"
      : "remote";
}

export function clampFutureUpdatedAt<
    T extends BaseRecord,
>(
    row: T,
    serverNow: string,
): T {
  if (
      ms(row.updated_at) <=
      ms(serverNow) +
      CLOCK_SKEW_TOLERANCE_MS
  ) {
    return row;
  }

  return {
    ...row,
    updated_at: serverNow,
  };
}

export function rowsEqual(
    a: BaseRecord,
    b: BaseRecord,
): boolean {
  const canon = (
      value: unknown,
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map(canon);
    }

    if (
        value === null ||
        typeof value !== "object"
    ) {
      return value;
    }

    return Object.entries(
        value as Record<
            string,
            unknown
        >,
    )
    .filter(
        ([key]) =>
            key !==
            "server_updated_at",
    )
    .sort(
        ([x], [y]) =>
            x < y ? -1 : 1,
    )
    .map(
        ([key, item]) => [
          key,
          canon(item),
        ],
    );
  };

  return (
      JSON.stringify(canon(a)) ===
      JSON.stringify(canon(b))
  );
}

export interface PullPlan<
    T extends BaseRecord,
> {
  apply: T[];
  keptLocal: string[];
}

export function planPull<
    T extends BaseRecord,
>(
    local: Map<string, T>,
    remote: RemoteRow<T>[],
    serverNow: string,
): PullPlan<T> {
  const apply: T[] = [];
  const keptLocal: string[] = [];

  for (const row of remote) {
    const own = local.get(
        row.id,
    );

    const incoming =
        stripServerColumn(row);

    if (!own) {
      apply.push(incoming);
      continue;
    }

    if (
        rowsEqual(
            own,
            incoming,
        )
    ) {
      continue;
    }

    if (
        resolveRow(
            own,
            row,
            serverNow,
        ) === "remote"
    ) {
      apply.push(incoming);
    } else {
      keptLocal.push(
          row.id,
      );
    }
  }

  return {
    apply,
    keptLocal,
  };
}

export interface PeriodPullPlan
    extends PullPlan<Period> {
  removeLocalIds: string[];
}

export function planPeriodsPull(
    local: Map<string, Period>,
    remote: RemoteRow<Period>[],
    serverNow: string,
): PeriodPullPlan {
  const localByMonth =
      new Map<string, Period>();

  for (const row of local.values()) {
    if (
        row.deleted_at !== null
    ) {
      continue;
    }

    const key =
        `${row.user_id}\u0000${row.year}\u0000${row.month}`;

    const existing =
        localByMonth.get(key);

    if (!existing) {
      localByMonth.set(
          key,
          row,
      );
      continue;
    }

    const winner =
        resolveRow(
            existing,
            row,
            serverNow,
        ) === "remote"
            ? row
            : existing;

    localByMonth.set(
        key,
        winner,
    );
  }

  const apply: Period[] = [];
  const keptLocal =
      new Set<string>();

  const removeLocalIds =
      new Set<string>();

  const remoteByMonth =
      new Map<string, Period>();

  for (const row of remote) {
    const incoming =
        stripServerColumn(row);

    if (
        row.deleted_at !==
        null
    ) {
      const own =
          local.get(row.id);

      if (!own) {
        apply.push(
            incoming,
        );
      } else if (
          !rowsEqual(
              own,
              incoming,
          )
      ) {
        if (
            resolveRow(
                own,
                row,
                serverNow,
            ) === "remote"
        ) {
          apply.push(
              incoming,
          );
        } else {
          keptLocal.add(
              own.id,
          );
        }
      }

      continue;
    }

    const sameId =
        local.get(row.id);

    if (sameId) {
      if (
          rowsEqual(
              sameId,
              incoming,
          )
      ) {
        continue;
      }

      if (
          resolveRow(
              sameId,
              row,
              serverNow,
          ) === "remote"
      ) {
        apply.push(
            incoming,
        );

        const key =
            `${row.user_id}\u0000${row.year}\u0000${row.month}`;

        remoteByMonth.set(
            key,
            incoming,
        );
      } else {
        keptLocal.add(
            sameId.id,
        );
      }

      continue;
    }

    const key =
        `${row.user_id}\u0000${row.year}\u0000${row.month}`;

    const acceptedRemote =
        remoteByMonth.get(key);

    if (acceptedRemote) {
      if (
          resolveRow(
              acceptedRemote,
              row,
              serverNow,
          ) === "remote"
      ) {
        const index =
            apply.findIndex(
                (candidate) =>
                    candidate.id ===
                    acceptedRemote.id,
            );

        if (index >= 0) {
          apply[index] =
              incoming;
        }

        remoteByMonth.set(
            key,
            incoming,
        );
      }

      continue;
    }

    const sameMonth =
        localByMonth.get(key);

    if (!sameMonth) {
      apply.push(
          incoming,
      );

      remoteByMonth.set(
          key,
          incoming,
      );

      continue;
    }

    if (
        resolveRow(
            sameMonth,
            row,
            serverNow,
        ) === "remote"
    ) {
      removeLocalIds.add(
          sameMonth.id,
      );

      apply.push(
          incoming,
      );

      remoteByMonth.set(
          key,
          incoming,
      );
    } else {
      keptLocal.add(
          sameMonth.id,
      );
    }
  }

  return {
    apply,
    keptLocal: [
      ...keptLocal,
    ],
    removeLocalIds: [
      ...removeLocalIds,
    ],
  };
}

/**
 * DayTypePullPlan отличается от обычного PullPlan тем, что duplicate
 * day types нельзя бездумно удалять: существующие entries могут ссылаться
 * на старый UUID.
 *
 * Поэтому:
 *
 * - один logical type остаётся активным;
 * - duplicate, который не используется entries, можно soft-delete;
 * - duplicate, на который ссылается entry, архивируем;
 * - remote duplicate тоже можно привести к архиву локально, не ломая историю.
 */
export interface DayTypePullPlan
    extends PullPlan<DayType> {
  resurrect: DayType[];
  removeLocalIds: string[];
  archiveLocalIds: string[];
  archiveRemote: DayType[];
}

export function planDayTypesPull(
    local: Map<string, DayType>,
    remote: RemoteRow<DayType>[],
    serverNow: string,
    referencedTypeIds: ReadonlySet<string>,
): DayTypePullPlan {
  const localByLogicalKey =
      new Map<string, DayType>();

  for (const row of local.values()) {
    if (
        row.deleted_at !== null
    ) {
      continue;
    }

    const key =
        dayTypeLogicalKey(row);

    const existing =
        localByLogicalKey.get(key);

    if (!existing) {
      localByLogicalKey.set(
          key,
          row,
      );
      continue;
    }

    if (
        resolveRow(
            existing,
            row,
            serverNow,
        ) === "remote"
    ) {
      localByLogicalKey.set(
          key,
          row,
      );
    }
  }

  const apply: DayType[] = [];
  const keptLocal =
      new Set<string>();

  const removeLocalIds =
      new Set<string>();

  const archiveLocalIds =
      new Set<string>();

  const resurrect: DayType[] = [];

  /**
   * Приходит несколько remote строк одного logical type.
   *
   * Мы храним одну live-версию.
   * Остальные превращаем в archived, а не выбрасываем:
   * remote entries могут продолжать ссылаться на их UUID.
   */
  const remoteByLogicalKey =
      new Map<string, DayType>();

  for (const row of remote) {
    const incoming =
        stripServerColumn(row);

    const key =
        dayTypeLogicalKey(row);

    const sameId =
        local.get(row.id);

    if (sameId) {
      if (
          rowsEqual(
              sameId,
              incoming,
          )
      ) {
        continue;
      }

      if (
          resolveRow(
              sameId,
              row,
              serverNow,
          ) === "remote"
      ) {
        if (
            row.deleted_at !==
            null &&
            referencedTypeIds.has(
                row.id,
            )
        ) {
          resurrect.push({
            ...incoming,
            deleted_at: null,
            updated_at:
            serverNow,
          });
        } else {
          apply.push(
              incoming,
          );
        }
      } else {
        keptLocal.add(
            sameId.id,
        );
      }

      continue;
    }

    const acceptedRemote =
        remoteByLogicalKey.get(
            key,
        );

    if (acceptedRemote) {
      /**
       * Второй remote duplicate в той же page.
       *
       * Если он новее — старый становится archived,
       * новый остаётся live.
       * Если старый новее — второй сразу archived.
       */
      if (
          resolveRow(
              acceptedRemote,
              row,
              serverNow,
          ) === "remote"
      ) {
        const index =
            apply.findIndex(
                (candidate) =>
                    candidate.id ===
                    acceptedRemote.id,
            );

        const archivedOld: DayType =
            {
              ...acceptedRemote,
              is_archived: true,
            };

        if (index >= 0) {
          apply[index] =
              archivedOld;
        }

        apply.push(
            incoming,
        );

        remoteByLogicalKey.set(
            key,
            incoming,
        );
      } else {
        apply.push({
          ...incoming,
          is_archived: true,
        });
      }

      continue;
    }

    const sameLogical =
        localByLogicalKey.get(key);

    if (sameLogical) {
      if (
          resolveRow(
              sameLogical,
              row,
              serverNow,
          ) === "remote"
      ) {
        /**
         * Remote версия выигрывает.
         *
         * Старую локальную строку нельзя всегда удалять:
         * на неё может ссылаться entry.
         */
        if (
            referencedTypeIds.has(
                sameLogical.id,
            )
        ) {
          archiveLocalIds.add(
              sameLogical.id,
          );
        } else {
          removeLocalIds.add(
              sameLogical.id,
          );
        }

        apply.push(
            incoming,
        );

        localByLogicalKey.set(
            key,
            incoming,
        );
      } else {
        /**
         * Local версия новее.
         * Remote duplicate скрываем в archive.
         */
        apply.push({
          ...incoming,
          is_archived: true,
        });
      }

      continue;
    }

    /**
     * Первый remote type этого logical key.
     */
    if (
        row.deleted_at !==
        null
    ) {
      if (
          referencedTypeIds.has(
              row.id,
          )
      ) {
        resurrect.push({
          ...incoming,
          deleted_at: null,
          updated_at:
          serverNow,
        });
      } else {
        apply.push(
            incoming,
        );
      }
    } else {
      apply.push(
          incoming,
      );
    }

    remoteByLogicalKey.set(
        key,
        incoming,
    );

    /**
     * Важно: локальный индекс тоже обновляем.
     * Иначе второй проход по этой странице не увидит первый remote type.
     */
    localByLogicalKey.set(
        key,
        incoming,
    );
  }

  return {
    apply,
    keptLocal: [
      ...keptLocal,
    ],
    resurrect,
    removeLocalIds: [
      ...removeLocalIds,
    ],
    archiveLocalIds: [
      ...archiveLocalIds,
    ],
    archiveRemote: [],
  };
}

export interface HolidayPullPlan
    extends PullPlan<Holiday> {
  removeLocalIds: string[];
}

export function planHolidaysPull(
    local: Map<string, Holiday>,
    remote: RemoteRow<Holiday>[],
    serverNow: string,
): HolidayPullPlan {
  const apply: Holiday[] = [];
  const keptLocal =
      new Set<string>();

  const removeLocalIds =
      new Set<string>();

  const localByLogicalKey =
      new Map<string, Holiday>();

  for (const row of local.values()) {
    if (
        row.deleted_at !== null
    ) {
      continue;
    }

    const key = row.is_custom
        ? `custom:${row.id}`
        : holidayLogicalKey(row);

    localByLogicalKey.set(
        key,
        row,
    );
  }

  const remoteByLogicalKey =
      new Map<string, Holiday>();

  for (const row of remote) {
    const incoming =
        stripServerColumn(row);

    const sameId =
        local.get(row.id);

    if (sameId) {
      if (
          rowsEqual(
              sameId,
              incoming,
          )
      ) {
        continue;
      }

      if (
          resolveRow(
              sameId,
              row,
              serverNow,
          ) === "remote"
      ) {
        apply.push(
            incoming,
        );
      } else {
        keptLocal.add(
            sameId.id,
        );
      }

      continue;
    }

    /**
     * Custom holidays deliberately use UUID identity.
     *
     * Two identical custom holidays may be intentional.
     */
    const key = row.is_custom
        ? `custom:${row.id}`
        : holidayLogicalKey(row);

    const acceptedRemote =
        remoteByLogicalKey.get(
            key,
        );

    if (acceptedRemote) {
      /**
       * Duplicate seeded holiday in the same remote page.
       */
      if (
          resolveRow(
              acceptedRemote,
              row,
              serverNow,
          ) === "remote"
      ) {
        const index =
            apply.findIndex(
                (candidate) =>
                    candidate.id ===
                    acceptedRemote.id,
            );

        if (index >= 0) {
          apply[index] =
              incoming;
        }

        remoteByLogicalKey.set(
            key,
            incoming,
        );
      }

      continue;
    }

    const sameLogical =
        localByLogicalKey.get(
            key,
        );

    if (!sameLogical) {
      apply.push(
          incoming,
      );

      remoteByLogicalKey.set(
          key,
          incoming,
      );

      localByLogicalKey.set(
          key,
          incoming,
      );

      continue;
    }

    if (
        resolveRow(
            sameLogical,
            row,
            serverNow,
        ) === "remote"
    ) {
      removeLocalIds.add(
          sameLogical.id,
      );

      apply.push(
          incoming,
      );

      localByLogicalKey.set(
          key,
          incoming,
      );

      remoteByLogicalKey.set(
          key,
          incoming,
      );
    } else {
      /**
       * Local seeded holiday is newer.
       * Remote duplicate is simply ignored locally.
       */
      keptLocal.add(
          sameLogical.id,
      );
    }
  }

  return {
    apply,
    keptLocal: [
      ...keptLocal,
    ],
    removeLocalIds: [
      ...removeLocalIds,
    ],
  };
}

export function stripServerColumn<
    T extends BaseRecord,
>(
    row: RemoteRow<T>,
): T {
  const copy =
      {
        ...row,
      } as unknown as Record<
          string,
          unknown
      >;

  delete copy.server_updated_at;

  return copy as unknown as T;
}

export interface EntryPullPlan
    extends PullPlan<Entry> {
  deferred: Entry[];
}

export function planEntriesPull(
    local: Map<string, Entry>,
    remote: RemoteRow<Entry>[],
    serverNow: string,
    knownTypeIds: ReadonlySet<string>,
): EntryPullPlan {
  const base = planPull(
      local,
      remote,
      serverNow,
  );

  const apply: Entry[] = [];
  const deferred: Entry[] = [];

  for (const row of base.apply) {
    if (
        row.deleted_at === null &&
        !knownTypeIds.has(
            row.day_type_id,
        )
    ) {
      deferred.push(
          row,
      );
    } else {
      apply.push(
          row,
      );
    }
  }

  return {
    apply,
    keptLocal:
    base.keptLocal,
    deferred,
  };
}