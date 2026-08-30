-- Timeo — block 8, cloud schema.
--
-- Run in the Supabase SQL Editor once, whole file at a time. Idempotent: every
-- statement is IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS, so
-- re-running it is safe and changes nothing.
--
-- The schema mirrors the local Dexie schema (src/db/schema.ts, src/types/models.ts):
-- same tables, same field names, id/user_id/created_at/updated_at/deleted_at on
-- every row. Row Level Security is keyed on auth.uid() = user_id (SPEC section 4).
--
-- Two deliberate decisions worth knowing before you read the DDL:
--
--   1. server_updated_at. Invariant 42: updated_at comes from the client clock,
--      but sync is ordered by the server's receipt order. A phone with a wrong
--      clock must not be able to hide a newer row from the pull. So every table
--      carries server_updated_at, written by a trigger and never by the client,
--      and the incremental pull filters on it. updated_at stays the conflict
--      resolver (last write wins, invariant 41); server_updated_at is only the
--      pull cursor.
--
--   2. No foreign key from entries.day_type_id to day_types.id. Invariant 37
--      (an entry never references a missing type) is enforced by push ordering
--      on the client — types before entries. A database-level FK would instead
--      reject the whole push when rows arrive out of order and lose local data,
--      which invariant 43 forbids.

-- ---------------------------------------------------------------------------
-- Shared trigger: server clock, and columns the client must not be able to set
-- ---------------------------------------------------------------------------

create or replace function public.timeo_touch_server_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.server_updated_at := now();
  -- user_id is immutable: a row can never be moved to another account.
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'user_id is immutable';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- settings (SPEC 5.1) — exactly one row per user
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  id                            uuid primary key,
  user_id                       uuid not null references auth.users (id) on delete cascade,
  created_at                    timestamptz not null,
  updated_at                    timestamptz not null,
  deleted_at                    timestamptz,
  server_updated_at             timestamptz not null default now(),

  currency                      text    not null default 'PLN',
  period_start_day              integer not null default 1,
  period_naming                 text    not null default 'end_month',
  default_hours                 numeric not null default 8,
  theme                         text    not null default 'system',
  show_shift_times              boolean not null default true,
  reminder_enabled              boolean not null default false,
  reminder_time                 text,
  week_starts_on                text    not null default 'monday',
  weekend_multipliers           jsonb   not null default '{"saturday": 1, "sunday": 1, "holiday": 1}'::jsonb,
  default_base_rate             numeric not null default 0,
  default_norm_hours            numeric not null default 0,
  default_base_rate_from_period jsonb,
  preferred_rate_change_mode    text,
  seeded_holiday_years          jsonb   not null default '[]'::jsonb,
  total_hours_paid_only         boolean not null default true,

  constraint settings_one_row_per_user unique (user_id)
);

-- ---------------------------------------------------------------------------
-- periods (SPEC 5.2)
-- ---------------------------------------------------------------------------

create table if not exists public.periods (
  id                uuid primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  deleted_at        timestamptz,
  server_updated_at timestamptz not null default now(),

  year          integer not null,
  month         integer not null,
  base_rate     numeric not null default 0,
  norm_hours    numeric not null default 0,
  extra_amount  numeric not null default 0,
  extra_note    text    not null default '',
  is_closed     boolean not null default false,
  closed_totals jsonb,
  is_manual     boolean not null default false
);

-- One live period per calendar month. Partial, because a soft-deleted period
-- must not block recreating that month (invariant 38 keeps deleted rows around
-- until sync has propagated them).
create unique index if not exists periods_user_month_uniq
  on public.periods (user_id, year, month)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- day_types (SPEC 5.3)
-- ---------------------------------------------------------------------------

create table if not exists public.day_types (
  id                uuid primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  deleted_at        timestamptz,
  server_updated_at timestamptz not null default now(),

  name                       text    not null default '',
  color                      text    not null default '#000000',
  label                      text    not null default '',
  note                       text    not null default '',
  pay_mode                   text    not null default 'hourly',
  rate_mode                  text    not null default 'multiplier',
  fixed_amount               numeric,
  counts_as_work             boolean not null default true,
  counts_toward_norm         boolean not null default true,
  default_hours              numeric not null default 8,
  default_start              text,
  default_end                text,
  default_break_minutes      integer,
  default_break_paid_minutes integer,
  default_multiplier         numeric not null default 1,
  default_rate               numeric,
  ignore_auto_multipliers    boolean not null default false,
  sort_order                 integer not null default 0,
  is_archived                boolean not null default false
);

create index if not exists day_types_user_sort_idx
  on public.day_types (user_id, sort_order);

-- ---------------------------------------------------------------------------
-- entries (SPEC 5.4)
-- ---------------------------------------------------------------------------

create table if not exists public.entries (
  id                uuid primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  deleted_at        timestamptz,
  server_updated_at timestamptz not null default now(),

  -- Local date as written on the phone, "YYYY-MM-DD". Deliberately text and not
  -- date: invariant 27 forbids round-tripping these through UTC, and Postgres
  -- date would invite exactly that on the way back out.
  date               text    not null,
  day_type_id        uuid    not null,
  hours              numeric not null default 0,
  multiplier         numeric not null default 1,
  rate_per_hour      numeric not null default 0,
  rate_is_manual     boolean not null default false,
  amount             numeric not null default 0,
  amount_override    numeric,
  start_time         text,
  end_time           text,
  break_minutes      integer,
  paid_break_minutes integer,
  duration_is_manual boolean not null default false,
  note               text    not null default '',
  rate_source        text    not null default 'period_base'
);

create index if not exists entries_user_date_idx
  on public.entries (user_id, date);

create index if not exists entries_user_day_type_idx
  on public.entries (user_id, day_type_id);

-- ---------------------------------------------------------------------------
-- holidays (SPEC 5.5)
-- ---------------------------------------------------------------------------

create table if not exists public.holidays (
  id                uuid primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  deleted_at        timestamptz,
  server_updated_at timestamptz not null default now(),

  -- Same reasoning as entries.date: local "YYYY-MM-DD" text, never a UTC round trip.
  date      text    not null,
  name      text    not null default '',
  is_custom boolean not null default false
);

create index if not exists holidays_user_date_idx
  on public.holidays (user_id, date);

-- ---------------------------------------------------------------------------
-- push_subscriptions (SPEC 5.6) — cloud only, never part of an export file
-- ---------------------------------------------------------------------------

create table if not exists public.push_subscriptions (
  id                uuid primary key,
  user_id           uuid not null references auth.users (id) on delete cascade,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  deleted_at        timestamptz,
  server_updated_at timestamptz not null default now(),

  endpoint     text  not null,
  keys         jsonb not null,
  device_label text  not null default '',
  last_seen_at timestamptz
);

-- One live subscription per endpoint per user: re-subscribing on the same
-- device updates the row instead of piling up duplicate pushes.
create unique index if not exists push_subscriptions_user_endpoint_uniq
  on public.push_subscriptions (user_id, endpoint)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Pull cursor index + trigger on every table
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['settings', 'periods', 'day_types', 'entries', 'holidays', 'push_subscriptions']
  loop
    execute format(
      'create index if not exists %I on public.%I (user_id, server_updated_at)',
      t || '_user_server_updated_idx', t
    );
    execute format('drop trigger if exists %I on public.%I', t || '_touch_server_updated_at', t);
    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.timeo_touch_server_updated_at()',
      t || '_touch_server_updated_at', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security — SPEC section 4: every table, policies on auth.uid() = user_id
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['settings', 'periods', 'day_types', 'entries', 'holidays', 'push_subscriptions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)',
      t || '_select_own', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (auth.uid() = user_id)',
      t || '_insert_own', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t || '_update_own', t
    );

    -- Deletion is soft everywhere (deleted_at, with an undo window), so there is
    -- deliberately no DELETE policy: a bug in the client cannot hard-delete a
    -- month of work. Purging expired soft-deleted rows is a server-side job.
    execute format('grant select, insert, update on public.%I to authenticated', t);
    -- Supabase's default grants hand new public tables to anon as well. RLS
    -- already leaves anon with no policy and therefore no rows, but a signed-out
    -- client has no business holding the privilege at all.
    execute format('revoke all on public.%I from anon', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sanity check — should print six tables, all with rowsecurity = true
-- ---------------------------------------------------------------------------

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('settings', 'periods', 'day_types', 'entries', 'holidays', 'push_subscriptions')
order by tablename;
