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

export interface DayType extends BaseRecord {
  name: string;
  color: string;
  icon: string;
  pay_mode: PayMode;
  fixed_amount: number | null;
  counts_as_work: boolean;
  counts_toward_norm: boolean;
  default_hours: number;
  default_multiplier: number;
  default_rate: number | null;
  ignore_auto_multipliers: boolean;
  sort_order: number;
  is_archived: boolean;
}

export type RateSource =
  | "period_base"
  | "weekend_rule"
  | "holiday_rule"
  | "day_type_default"
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
