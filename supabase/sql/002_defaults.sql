-- Дефолты столбцов settings разошлись с DEFAULT_SETTINGS в src/db/settings.ts.
-- Клиент всегда пишет строку целиком, поэтому на живых данных это не
-- проявлялось, но строка, заведённая вставкой без перечисления столбцов,
-- получала бы другое состояние экрана дня и другую норму часов.
--
-- Идемпотентно: повторный запуск ничего не меняет.

alter table public.settings alter column show_shift_times   set default false;
alter table public.settings alter column default_norm_hours set default 160;
