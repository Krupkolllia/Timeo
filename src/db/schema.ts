import Dexie, { type EntityTable } from "dexie";
import type { Settings, Period, DayType, Entry, Holiday } from "@/types/models";
import type { SyncMeta } from "@/db/syncMeta";
import { roundHours, roundMoney, roundMultiplier } from "@/lib/calc/round";
import { periodForDate } from "@/lib/calc/period";
import { deriveDayTypeLabel } from "@/lib/format/dayType";

export class TimeoDB extends Dexie {
  settings!: EntityTable<Settings, "id">;
  periods!: EntityTable<Period, "id">;
  day_types!: EntityTable<DayType, "id">;
  entries!: EntityTable<Entry, "id">;
  holidays!: EntityTable<Holiday, "id">;
  sync_meta!: EntityTable<SyncMeta, "user_id">;

  constructor(name = "timeo") {
    super(name);
    this.version(1).stores({
      settings: "id, user_id",
      periods: "id, user_id, [year+month]",
      day_types: "id, user_id, sort_order",
      entries: "id, user_id, date, day_type_id",
      holidays: "id, user_id, date",
    });
    // Block 0 was already deployed to prod — on devices that opened the app
    // before, IndexedDB was already created at version(1) without this index. Dexie
    // only applies stores() changes when the version number increases, so the
    // index is added as a separate version(2) instead of editing version(1).
    this.version(2).stores({
      periods: "id, user_id, [year+month], [user_id+year+month]",
    });
    // Записи, созданные до округления, лежат в базе с float-хвостами вида
    // amount: 399.59999999999997. Пересчёт не трогаем — только нормализуем уже
    // сохранённые числа, чтобы не изменить ни одной суммы больше чем на
    // копейку и не нарушить изоляцию периодов (раздел 6.3).
    //
    // updated_at здесь намеренно не трогаем: иначе при появлении синхронизации
    // (блок 7) все записи разом уедут в облако как «изменённые».
    this.version(3).upgrade((tx) =>
      tx
        .table("entries")
        .toCollection()
        .modify((entry: Entry) => {
          entry.amount = roundMoney(entry.amount);
          entry.rate_per_hour = roundMoney(entry.rate_per_hour);
          if (entry.amount_override !== null) entry.amount_override = roundMoney(entry.amount_override);
          entry.hours = roundHours(entry.hours);
          entry.multiplier = roundMultiplier(entry.multiplier);
        }),
    );
    // На устройствах, открывавших приложение раньше, в строке settings нет
    // поля default_base_rate_from_period, и чтение дало бы undefined там, где
    // код ждёт PeriodRef | null. Заполняем явным null.
    //
    // updated_at, как и в version(3), намеренно не трогаем: иначе при появлении
    // синхронизации (блок 8) настройки уедут в облако как «изменённые».
    this.version(4).upgrade((tx) =>
      tx
        .table("settings")
        .toCollection()
        .modify((settings: Settings) => {
          settings.default_base_rate_from_period = settings.default_base_rate_from_period ?? null;
        }),
    );
    // Записи, созданные до 4cc25c5, лежат в базе по СТАРОЙ формуле:
    //
    //     rate_per_hour = base_rate × multiplier   (множитель свёрнут в ставку)
    //     amount        = hours × rate_per_hour
    //
    // Новая формула (раздел 6.4) применяет множитель отдельно:
    //
    //     amount = hours × rate × multiplier
    //
    // Для rate_is_manual = false это безобидно: ставка заново выводится из
    // period.base_rate при каждом расчёте, и сумма получается той же самой.
    // Расходится только сохранённое rate_per_hour — на экране дня и в
    // расшифровке периода видна ставка 45 при базовой 30, и строка
    // «8ч × 45.00 · ×1.5» противоречит собственной сумме 360 (инвариант 55).
    //
    // Для rate_is_manual = true всё хуже. Старый код выводил из вписанной
    // ставки ещё и множитель (multiplier = rate ÷ base_rate), так что оба поля
    // несут один и тот же коэффициент. Новая формула умножает на него второй
    // раз: 8ч × 50 = 400 превращается в 8 × 50 × 1.667 = 666.80 при первом же
    // касании любого поля. Множитель в таких записях в сумме не участвовал
    // никогда, поэтому честное значение для него — 1: сумма сохраняется точно,
    // вписанная человеком ставка остаётся нетронутой, а строка расшифровки
    // впервые совпадает с суммой.
    //
    // Правится только то, что однозначно опознано как старая форма: сумма не
    // сходится по новой формуле И сходится по старой. Записи с amount_override,
    // записи новой формы и всё, что не подошло ни под одну из двух формул,
    // не трогаются вовсе.
    //
    // Закрытые периоды не трогаются (инвариант 2): их итоги и так берутся из
    // closed_totals, а зафиксированный месяц неизменяем по определению.
    //
    // updated_at, как и в version(3)/version(4), намеренно не трогаем: иначе
    // при появлении синхронизации (блок 8) вся база разом уедет в облако как
    // «изменённая».
    this.version(5).upgrade(async (tx) => {
      const settingsRows = (await tx.table("settings").toArray()) as Settings[];
      const periods = (await tx.table("periods").toArray()) as Period[];

      const startDayByUser = new Map<string, number>();
      for (const row of settingsRows) startDayByUser.set(row.user_id, row.period_start_day ?? 1);

      const periodKey = (userId: string, year: number, month: number) => `${userId}:${year}:${month}`;
      const periodByKey = new Map<string, Period>();
      for (const period of periods) periodByKey.set(periodKey(period.user_id, period.year, period.month), period);

      const periodOfEntry = (entry: Entry): Period | undefined => {
        // Дату разбираем вручную: new Date("2026-08-10") — это UTC-полночь
        // (инвариант 27).
        const [year, month, day] = entry.date.split("-").map(Number);
        if (!year || !month || !day) return undefined;
        const startDay = startDayByUser.get(entry.user_id) ?? 1;
        const id = periodForDate(new Date(year, month - 1, day), startDay);
        return periodByKey.get(periodKey(entry.user_id, id.year, id.month));
      };

      await tx
        .table("entries")
        .toCollection()
        .modify((entry: Entry) => {
          if (entry.amount_override !== null && entry.amount_override !== undefined) return;

          // Уже по новой формуле (в том числе любая запись с множителем 1) —
          // трогать нечего.
          if (roundMoney(entry.hours * entry.rate_per_hour * entry.multiplier) === entry.amount) return;
          // Не сходится и по старой — форму записи мы не опознали, и гадать на
          // платёжном журнале нельзя.
          if (roundMoney(entry.hours * entry.rate_per_hour) !== entry.amount) return;

          const period = periodOfEntry(entry);
          if (period?.is_closed) return;

          if (entry.rate_is_manual) {
            entry.multiplier = 1;
            return;
          }

          // Автоматическая ставка: сумма и так пересчитается верно, чинить надо
          // только само сохранённое число. Меняем его, лишь если это делает
          // запись согласованной — иначе базовая ставка периода с тех пор
          // изменилась, и подставлять её задним числом нельзя.
          if (!period) return;
          const baseRate = roundMoney(period.base_rate);
          if (roundMoney(entry.hours * baseRate * entry.multiplier) !== entry.amount) return;
          entry.rate_per_hour = baseRate;
        });
    });
    // Блок 4 приводит day_types к разделу 5.3. Три поля:
    //
    //   label     — 1–3 символа для значка (раздел 8.2). Заменяет icon
    //               ("briefcase", "moon", …), который не рисовался нигде.
    //   note      — описание, видимое в выборе типа дня.
    //   rate_mode — "multiplier" | "pinned" (раздел 5.3.1). Раньше режим
    //               выводился из `default_rate !== null`; выводим ровно то же
    //               самое, чтобы ни один существующий тип не начал вести себя
    //               иначе, чем вёл вчера.
    //
    // label выводим из имени, а не оставляем пустым: пустой кружок на ячейке
    // календаря — регрессия, а не нейтральное значение. Пользователь может
    // поправить значок в форме сразу после обновления.
    //
    // Трогается ровно одна таблица. entries и periods здесь не открываются
    // вовсе, поэтому ни одна сумма не может измениться (тип дня — это
    // косметика на момент отрисовки плюс шаблон для БУДУЩИХ записей, раздел
    // 5.4) и ни один закрытый период не может быть затронут (инвариант 2).
    //
    // updated_at, как и в version(3)/(4)/(5), намеренно не трогаем: иначе при
    // появлении синхронизации (блок 8) все типы дней уедут в облако как
    // «изменённые».
    this.version(6).upgrade((tx) =>
      tx
        .table("day_types")
        .toCollection()
        .modify((dayType: DayType & { icon?: string }) => {
          dayType.label = dayType.label || deriveDayTypeLabel(dayType.name ?? "");
          dayType.note = dayType.note ?? "";
          dayType.rate_mode =
            dayType.rate_mode ?? (dayType.default_rate !== null && dayType.default_rate !== undefined
              ? "pinned"
              : "multiplier");
          delete dayType.icon;
        }),
    );
    // Блок 5 добавляет settings.seeded_holiday_years — список годов, для
    // которых праздники уже засеяны. На устройствах, открывавших приложение
    // раньше, поля нет, и чтение дало бы undefined там, где код ждёт number[];
    // посев решил бы, что не засеян ни один год, и это как раз безобидно —
    // праздников у такого пользователя ещё нет вовсе. Заполняем явным [] по
    // тем же причинам, что и version(4): читатель не должен знать про
    // undefined.
    //
    // Трогается ровно одна таблица — settings. entries и periods здесь не
    // открываются вовсе, поэтому ни одна сумма не может измениться и ни один
    // закрытый период не может быть затронут (инвариант 2).
    //
    // updated_at, как и в version(3)/(4)/(5)/(6), намеренно не трогаем: иначе
    // при появлении синхронизации (блок 8) настройки уедут в облако как
    // «изменённые».
    this.version(7).upgrade((tx) =>
      tx
        .table("settings")
        .toCollection()
        .modify((settings: Settings) => {
          settings.seeded_holiday_years = settings.seeded_holiday_years ?? [];
        }),
    );
    // Блок 2, долг раздела 6.1: длительность впервые начинает выводиться из
    // начала, конца и перерыва. Появляется поле entries.duration_is_manual —
    // «длительность вписана руками, связь с временами разорвана».
    //
    // Всем существующим записям ставится true, и это главное решение этой
    // миграции.
    //
    // Ни одно число в базе никогда не выводилось из времён: start_time,
    // end_time и break_minutes хранились с самого блока 2 и не влияли ни на
    // что, а hours человек набирал сам либо получал из шаблона типа дня.
    // Поэтому true здесь — не осторожность, а буквальная правда о том, откуда
    // взялось сохранённое число.
    //
    // False был бы тихой катастрофой: у записи, где начало и конец уже
    // заполнены, при первом же открытии дня длительность пересчиталась бы по
    // ним, и «Сохранить» переписало бы настоящую зарплату числом, которого
    // человек не вводил. На телефоне, который проверяют по скриншотам, такое
    // всплывает через недели. Включить вывод для конкретного дня можно одной
    // кнопкой «считать по времени» на экране дня (раздел 8.2) — видимо,
    // по одному дню и по решению человека.
    //
    // Флаг ставится и записям закрытых периодов. Он не участвует ни в одной
    // сумме, поэтому инвариант 2 не нарушается: closed_totals и amount
    // остаются нетронутыми, а оставить поле неопределённым значило бы
    // договориться о выводе длительности на случай, если период переоткроют.
    //
    // Меняется ровно одно поле. hours, amount, amount_override, ставки и
    // множители не трогаются вовсе, periods здесь не открывается — ни одна
    // сумма измениться не может.
    //
    // updated_at, как и в version(3)/(4)/(5)/(6)/(7), намеренно не трогаем:
    // иначе при появлении синхронизации (блок 8) все записи разом уедут в
    // облако как «изменённые».
    this.version(8).upgrade((tx) =>
      tx
        .table("entries")
        .toCollection()
        .modify((entry: Entry) => {
          entry.duration_is_manual = true;
        }),
    );
    // Раздел 5.3: у типа дня появляются собственные времена по умолчанию и
    // оплачиваемый перерыв (новое понятие, вне исходного ТЗ). У записи —
    // paid_break_minutes, сколько минут её перерыва оплачивается.
    //
    // day_types получают default_start=null, default_end=null,
    // default_break_minutes=null — «времён нет», формула 6.1 идёт по ветке
    // default_hours ровно как раньше, потому что для вывода из времён нужны
    // оба поля start/end, а их нет ни у одного существующего типа.
    // default_break_paid_minutes=0 — «оплачиваемых минут нет», но это поле
    // применяется только вместе с default_start/default_end, которых тоже
    // нет, так что оно ни на что не влияет для существующих типов.
    //
    // entries получают paid_break_minutes=0 — «перерыв целиком неоплачиваемый».
    // Формула 6.1 до этой миграции всегда вычитала break_minutes целиком, то
    // есть paid_break_minutes=0 — не осторожное умолчание, а буквальное
    // описание того, что уже произошло с каждой существующей записью:
    // worked = total − (break − paid_break) при paid_break=0 даёт то же
    // число, что и старая формула duration = raw − break_minutes.
    //
    // Ни hours, ни amount, ни rate_source, ни updated_at не трогаются, periods
    // здесь не открывается вовсе — ни одна сумма и ни один закрытый период не
    // могут измениться (инвариант 2).
    //
    // settings.total_hours_paid_only=true — «итоги периода считаются по
    // оплачиваемым часам», то есть ровно то, чем entries.hours уже был
    // всегда: раздел 6.5 продолжает суммировать то же самое число, что и до
    // этой миграции, пока человек сам не переключит настройку.
    this.version(9).upgrade((tx) =>
      Promise.all([
        tx
          .table("day_types")
          .toCollection()
          .modify((dayType: DayType) => {
            dayType.default_start = null;
            dayType.default_end = null;
            dayType.default_break_minutes = null;
            dayType.default_break_paid_minutes = 0;
          }),
        tx
          .table("entries")
          .toCollection()
          .modify((entry: Entry) => {
            entry.paid_break_minutes = 0;
          }),
        tx
          .table("settings")
          .toCollection()
          .modify((settings: Settings) => {
            settings.total_hours_paid_only = true;
          }),
      ]),
    );
    // Блок 8. Служебная таблица синхронизации: курсоры докачки и водяные знаки
    // выгрузки, по строке на пользователя. Пользовательских данных в ней нет —
    // ни в экспорт (инвариант 46), ни в облако она не идёт.
    //
    // Пяти таблиц с данными эта версия не касается вовсе: ни одного поля не
    // добавляется и не переписывается, upgrade-функции нет. Значит, ни одна
    // сумма и ни один закрытый период измениться не могут (инвариант 2), а
    // updated_at существующих строк остаётся историческим — ровно как во всех
    // девяти предыдущих версиях, и по той же причине: первая выгрузка не имеет
    // права выглядеть как «всё разом изменилось».
    this.version(10).stores({
      sync_meta: "user_id",
    });
  }
}
