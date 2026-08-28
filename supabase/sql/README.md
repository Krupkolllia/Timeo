# Supabase SQL

Schema and RLS policies for block 7 ("Cloud"). Currently empty — gets filled in when it's
sync's turn (sections 4 and 5 of TIMEO-SPEC.md).

The Postgres schema should mirror the local Dexie schema (`src/db/schema.ts`): the same tables,
the same fields, `id/user_id/created_at/updated_at/deleted_at` on each. Row Level Security is by
`user_id`. Conflict resolution — last write wins by `updated_at`.

The files in this folder are run manually in the Supabase SQL Editor (see `TIMEO-SETUP.md`, step 4).
