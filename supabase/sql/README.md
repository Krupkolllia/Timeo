# Supabase SQL

Schema and RLS policies for block 8 ("Cloud", section 11 of [SPEC.md](../../SPEC.md)).

The files here are run manually in the Supabase SQL Editor, in filename order:

- `001_schema.sql` — tables mirroring the local Dexie schema (`src/db/schema.ts`), the
  `server_updated_at` trigger, indexes, and RLS keyed on `auth.uid() = user_id`.

Each file is idempotent and can be re-run safely.

Conventions:

- The Postgres schema mirrors the local one: same tables, same field names,
  `id/user_id/created_at/updated_at/deleted_at` on every row.
- Conflict resolution is last-write-wins on `updated_at` (invariant 41); the incremental pull is
  ordered by the server-written `server_updated_at` (invariant 42).
- Deletion is soft everywhere, so there is no `DELETE` policy.
