import Dexie, { type EntityTable } from "dexie";
import type { Settings, Period, DayType, Entry, Holiday } from "@/types/models";

export class TimeoDB extends Dexie {
  settings!: EntityTable<Settings, "id">;
  periods!: EntityTable<Period, "id">;
  day_types!: EntityTable<DayType, "id">;
  entries!: EntityTable<Entry, "id">;
  holidays!: EntityTable<Holiday, "id">;

  constructor(name = "timeo") {
    super(name);
    this.version(1).stores({
      settings: "id, user_id",
      periods: "id, user_id, [year+month]",
      day_types: "id, user_id, sort_order",
      entries: "id, user_id, date, day_type_id",
      holidays: "id, user_id, date",
    });
    // Блок 0 уже был задеплоен на прод — на устройствах, открывавших приложение
    // раньше, IndexedDB уже создана на version(1) без этого индекса. Dexie
    // применяет изменения stores() только при увеличении номера версии, поэтому
    // индекс добавляется отдельной version(2), а не правкой version(1).
    this.version(2).stores({
      periods: "id, user_id, [year+month], [user_id+year+month]",
    });
  }
}
