-- Timeo — cleanup of duplicated seeded data.
--
-- Причина:
-- day_types и seeded holidays исторически создавались с random UUID.
-- Два устройства одного аккаунта могли независимо выполнить seed и создать
-- разные UUID для одного и того же пресета. После sync обе строки попадали
-- в облако и затем разносились обратно на устройства.
--
-- Скрипт идемпотентен: повторный запуск не создаёт новых строк и повторно
-- не меняет уже удалённые/архивные строки.

-- ---------------------------------------------------------------------------
-- day_types
-- ---------------------------------------------------------------------------
--
-- Для seeded presets до появления стабильных ID используем ту же логическую
-- идентичность, которую использовала локальная migration(11):
--
--   user_id + name + pay_mode
--
-- Самый ранний live row остаётся.
-- Дубль, на который ссылается живая entry, архивируется.
-- Дубль без ссылок мягко удаляется.
--
-- ВАЖНО: пользовательские типы дня с тем же именем технически тоже попадут
-- в эту группу. Поэтому это cleanup только для уже накопившегося исторического
-- seed-мусора. После этого новые seed будут иметь стабильные ID и больше сюда
-- не попадать.

with ranked as (
    select
        id,
        row_number() over (
      partition by user_id, lower(trim(name)), pay_mode
      order by created_at asc, id asc
    ) as rn
    from public.day_types
    where deleted_at is null
),
     referenced as (
         select distinct day_type_id
         from public.entries
         where deleted_at is null
     ),
     duplicates as (
         select r.id
         from ranked r
         where r.rn > 1
     )
update public.day_types d
set
    deleted_at = now(),
    updated_at = now()
    from duplicates x
where d.id = x.id
  and d.deleted_at is null
  and not exists (
    select 1
    from referenced e
    where e.day_type_id = d.id
    );

with ranked as (
    select
        id,
        row_number() over (
      partition by user_id, lower(trim(name)), pay_mode
      order by created_at asc, id asc
    ) as rn
    from public.day_types
    where deleted_at is null
),
     referenced as (
         select distinct day_type_id
         from public.entries
         where deleted_at is null
     ),
     duplicates as (
         select r.id
         from ranked r
         where r.rn > 1
     )
update public.day_types d
set
    is_archived = true,
    updated_at = now()
    from duplicates x
where d.id = x.id
  and d.deleted_at is null
  and exists (
    select 1
    from referenced e
    where e.day_type_id = d.id
    );

-- ---------------------------------------------------------------------------
-- seeded holidays
-- ---------------------------------------------------------------------------
--
-- Logical identity:
--
--   user_id + date + normalized name
--
-- Custom holidays are intentionally excluded.

with ranked as (
    select
        id,
        row_number() over (
      partition by user_id, date, lower(trim(name))
      order by created_at asc, id asc
    ) as rn
    from public.holidays
    where deleted_at is null
      and is_custom = false
),
     duplicates as (
         select id
         from ranked
         where rn > 1
     )
update public.holidays h
set
    deleted_at = now(),
    updated_at = now()
    from duplicates d
where h.id = d.id
  and h.deleted_at is null;