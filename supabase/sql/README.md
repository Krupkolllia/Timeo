# Supabase SQL

Schema and RLS policies for block 8 ("Cloud", section 11 of [SPEC.md](../../SPEC.md)).

The files here are run manually in the Supabase SQL Editor, in filename order:

- `001_schema.sql` — tables mirroring the local Dexie schema (`src/db/schema.ts`), the
  `server_updated_at` trigger, indexes, and RLS keyed on `auth.uid() = user_id`.
- `002_defaults.sql` — realigns two `settings` column defaults with `DEFAULT_SETTINGS` in `src/db/settings.ts`.

Each file is idempotent and can be re-run safely.

What the project needs besides these files (Supabase console, done by hand):

- **Authentication → Providers**: e-mail and Google enabled. Google needs a Client ID and Client Secret
  from an OAuth client of type "Web application" in Google Cloud, whose Authorized redirect URI is
  `https://<project-ref>.supabase.co/auth/v1/callback`. The secret lives in the Supabase console only
  and never in this repository. If the Google consent screen is still in "Testing", only accounts
  listed there as test users can sign in.
- **Authentication → URL Configuration**: Site URL = `https://timeo.timeo-app.workers.dev`; Redirect
  URLs list `https://timeo.timeo-app.workers.dev/**` and `http://localhost:5173/**` for local
  development. Without the app's own return address in that list Supabase silently sends the person to
  the Site URL instead, which looks like a sign-in that did nothing.
- **Cloudflare Workers Builds**: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set as *build*
  variables. Vite inlines them at build time; a runtime worker secret never reaches the bundle.
- Only the `anon` key ever reaches the client. `service_role` must not appear in the app or the repo.

Conventions:

- The Postgres schema mirrors the local one: same tables, same field names,
  `id/user_id/created_at/updated_at/deleted_at` on every row.
- Conflict resolution is last-write-wins on `updated_at` (invariant 41); the incremental pull is
  ordered by the server-written `server_updated_at` (invariant 42).
- Deletion is soft everywhere, so there is no `DELETE` policy.
