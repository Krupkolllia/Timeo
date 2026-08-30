# Timeo

Shift-tracking and payroll app. A PWA, added to the iPhone home screen through Safari.

## Stack

React + TypeScript + Vite + Tailwind v4, Dexie (IndexedDB, primary storage), Zustand,
react-router-dom, vite-plugin-pwa. Cloud — Supabase. Reminders and keep-alive —
Cloudflare Workers. Hosting — Cloudflare Workers (static assets, see `wrangler.jsonc`).

## Development

Requires Node.js 20+.

```bash
npm install
npm run dev
```

The app opens at `http://localhost:5173`. Verifying the home-screen install only works on a
real device through Safari — the desktop preview won't show it.

## Environment variables

```bash
cp .env.example .env
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` drive sync (block 8). Left empty, the app
still works completely — it simply never syncs, and the account screen says so (invariant 39).
Only the `anon` key belongs here; `service_role` must never reach the client.

In Cloudflare they must be set as **build** variables in Workers Builds, not as runtime worker
secrets: Vite inlines `VITE_*` when the bundle is built, so a runtime secret never reaches it.
The Supabase project also needs the production domain and `http://localhost:5173/**` in
Authentication → URL Configuration, and the SQL in `supabase/sql/` run once by hand.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Local dev server |
| `npm run build` | Type-check and production build into `dist/` |
| `npm run preview` | Locally preview the built `dist/` |
| `npm run lint` | ESLint |
| `npm run typecheck` | Type-check without building |
| `npm run test` | Run the test suite (Vitest) |

## Structure

```
src/
  app/          routing and app root
  pages/        screens — Calendar, DayScreen, PeriodSummary, Settings,
                DayTypes, Holidays, PastPeriods, ExportRestore
  components/   reusable UI components
  db/           Dexie schema, local user_id before sign-in
  store/        Zustand stores
  lib/calc/     calculation logic — pure functions
  lib/sync/     Supabase client, sync
  lib/export/   JSON backup and restore
  i18n/         text dictionary (ru; pl to be added later without touching components)
  types/        data model
public/         PWA icons, static files
supabase/sql/   Postgres schema and RLS policies
workers/        Cloudflare Workers: reminders, keep-alive
```

## Deployment

Cloudflare Workers (Workers Builds), auto-deploys from this repository on push to `main`.
Build command — `npm run build`, assets directory — `dist` (`wrangler.jsonc`).
