# Timeo

Source of truth for product and architecture — [TIMEO-SPEC.md](TIMEO-SPEC.md). All decisions there
are agreed with the customer and must not be reinvented without an explicit instruction. Read it
before any work on functionality.

## Who the user is

The end user is not a developer, and tests changes remotely on an iPhone 13 Pro through an
intermediary (the customer). Hence: don't break the production deploy without extreme necessity,
changes are verified with screenshots, not guesses.

## Invariants that must not be violated

- Changes in one period (`periods`) never affect totals in another period — section 6.3.
- No input field blocks saving (no hard validation) — section 8.
- Multipliers do not multiply together, one rule wins — section 6.2.
- The local database (Dexie/IndexedDB) is the primary data source, the screen doesn't wait on the network.
- Changing `period_start_day` is forbidden while closed periods exist.

## Stack

React + TypeScript + Vite, Tailwind v4, Dexie (IndexedDB), Zustand, react-router-dom,
vite-plugin-pwa, Supabase (Postgres + Auth, from block 7), Cloudflare Pages/Workers.

## Structure

```
src/
  app/        routing and app root
  pages/      screens (section 7 of the spec), one directory per screen
  components/ reusable UI components
  db/         Dexie schema, local user_id
  store/      Zustand stores
  lib/calc/   calculation logic (section 6 of the spec) — pure functions, no side effects
  lib/sync/   Supabase client, sync
  lib/export/ JSON backup/restore
  i18n/       text dictionary (currently ru only)
  types/      data model (section 5 of the spec)
supabase/sql/ Supabase schema and RLS policies
workers/      Cloudflare Workers (reminders, keep-alive)
```

## Working rules

- Don't commit or push without an explicit request.
- Don't delete user data irreversibly — soft delete only (`deleted_at`) with an undo window.
- `lib/calc/*` — pure functions covered by unit tests; don't couple them to Dexie/React.
- Secrets (Supabase URL/anon key) — only via environment variables, never hardcoded.
