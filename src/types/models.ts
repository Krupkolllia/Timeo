export interface BaseRecord {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type PeriodNaming = "end_month" | "start_month";
export type Theme = "system" | "light" | "dark";

export interface WeekendMultipliers {
  saturday: number;
  sunday: number;
  holiday: number;
}

/** Ссылка на период по его устойчивому идентификатору (раздел 5.2). */
export interface PeriodRef {
  year: number;
  month: number;
}

export interface Settings extends BaseRecord {
  currency: string;
  period_start_day: number;
  period_naming: PeriodNaming;
  default_hours: number;
  theme: Theme;
  show_shift_times: boolean;
  reminder_enabled: boolean;
  reminder_time: string | null;
  week_starts_on: "monday";
  weekend_multipliers: WeekendMultipliers;
  default_base_rate: number;
  default_norm_hours: number;
  /**
   * С какого периода default_base_rate начинает действовать. Заполняется
   * режимом «применить со следующего периода» (раздел 6.6): без этой отметки
   * значение не может «подхватиться при создании следующего периода», потому
   * что по разделу 5.2 новый период копирует ставку у предыдущего и до
   * default_base_rate дело не доходит вовсе.
   */
  default_base_rate_from_period: PeriodRef | null;
  preferred_rate_change_mode: RateChangeMode | null;
  /**
   * Годы, для которых уже засеяны польские государственные праздники
   * (раздел 5.5). Единица посева — год: повторный запуск никогда не трогает
   * год из этого списка, поэтому удалённый пользователем праздник не
   * воскресает.
   *
   * Признаком «год засеян» намеренно служит эта отметка, а не наличие строк в
   * holidays: удаление мягкое, но инвариант 38 держит удалённые строки лишь до
   * распространения синхронизации (блок 8). После их очистки год выглядел бы
   * незасеянным, и приложение вернуло бы ровно то, что человек стёр.
   */
  seeded_holiday_years: number[];
}

export interface ClosedTotals {
  amount: number;
  total_hours: number;
  norm_hours_covered: number;
}

export interface Period extends BaseRecord {
  year: number;
  month: number;
  base_rate: number;
  norm_hours: number;
  extra_amount: number;
  extra_note: string;
  is_closed: boolean;
  closed_totals: ClosedTotals | null;
  is_manual: boolean;
}

export type PayMode = "hourly" | "fixed_amount" | "unpaid";

/**
 * Раздел 5.3.1 ТЗ. Замок «независимо от базовой ставки»: открыт — ставка типа
 * дня выводится из базовой ставки периода, закрыт — у типа своя ставка,
 * лежащая в default_rate.
 *
 * До блока 4 этого поля не было и режим выводился из `default_rate !== null`.
 * Правило работало, но было невидимым: раздел 6.2 («если rate_mode = pinned,
 * множитель не применяется») опирается именно на него, и без явного поля
 * различие нельзя ни задать, ни показать.
 */
export type RateMode = "multiplier" | "pinned";

export interface DayType extends BaseRecord {
  name: string;
  color: string;
  /**
   * Раздел 5.3: 1–3 символа для значка. Заменило поле icon ("briefcase",
   * "moon", …), которое не рисовалось нигде: раздел 8.2 требует цветной кружок
   * с символами, а не набор иконок.
   */
  label: string;
  /** Раздел 5.3: свободное описание, видно в выборе типа дня. */
  note: string;
  pay_mode: PayMode;
  rate_mode: RateMode;
  fixed_amount: number | null;
  counts_as_work: boolean;
  counts_toward_norm: boolean;
  default_hours: number;
  default_multiplier: number;
  /**
   * Раздел 5.3 называет это поле pinned_rate. Имя оставлено прежним осознанно:
   * переименование ключа в живой базе не даёт пользователю ничего, а миграция
   * блока 4 обязана доказывать, что не изменила ни одной суммы. Смысл при этом
   * изменился и это главное: значение читается, только когда
   * rate_mode = "pinned", а не «как только оно не null».
   */
  default_rate: number | null;
  /** Раздел 5.3 называет это поле allow_auto_multipliers; здесь оно обратное. */
  ignore_auto_multipliers: boolean;
  sort_order: number;
  is_archived: boolean;
}

export type RateSource =
  | "period_base"
  | "weekend_rule"
  | "holiday_rule"
  | "day_type_default"
  // Раздел 6.3: у типа дня закрыт замок, ставка взята из его default_rate.
  // Отличается от "manual" происхождением: число не вписывал человек на экране
  // дня, оно пришло из шаблона (инвариант 15).
  | "type_pinned"
  | "manual"
  // Раздел 6.6: ставка заморожена системой при смене базовой ставки «с даты».
  // Отличается от "manual" (пользователь вписал число сам) только
  // происхождением, но на экране расшифровки это разные истории, и раздел
  // 5.4 требует, чтобы rate_source описывал, как число реально получилось.
  | "frozen";

export type RateChangeMode = "recalculate_period" | "apply_from_date" | "apply_next_period";

export interface Entry extends BaseRecord {
  date: string;
  day_type_id: string;
  hours: number;
  multiplier: number;
  rate_per_hour: number;
  rate_is_manual: boolean;
  amount: number;
  amount_override: number | null;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number | null;
  note: string;
  rate_source: RateSource;
}

export interface Holiday extends BaseRecord {
  date: string;
  name: string;
  is_custom: boolean;
}
