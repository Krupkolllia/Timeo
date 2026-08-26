# Supabase SQL

Схема и RLS-политики для блока 7 («Облако»). Пока пусто — наполняется, когда доходит очередь
до синхронизации (раздел 4 и 5 TIMEO-SPEC.md).

Схема Postgres должна повторять локальную схему Dexie (`src/db/schema.ts`): те же таблицы,
те же поля, `id/user_id/created_at/updated_at/deleted_at` на каждой. Row Level Security — по
`user_id`. Разрешение конфликтов — последняя запись побеждает по `updated_at`.

Файлы этой папки исполняются вручную в Supabase SQL Editor (см. `TIMEO-SETUP.md`, шаг 4).
