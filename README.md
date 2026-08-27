# Timeo

Shift-tracking and payroll app. A PWA, added to the iPhone home screen through Safari.
Full technical specification — [TIMEO-SPEC.md](TIMEO-SPEC.md).

## Stack

React + TypeScript + Vite + Tailwind v4, Dexie (IndexedDB, primary storage), Zustand,
react-router-dom, vite-plugin-pwa. Cloud — Supabase (block 7), reminders and keep-alive —
Cloudflare Workers (blocks 8–9). Hosting — Cloudflare Pages.

## Development

Requires Node.js 20+.

```bash
npm install
npm run dev
```

The app opens at `http://localhost:5173`. Verifying the home-screen install only works on a
real device through Safari (see `TIMEO-SETUP.md`, step 3) — the desktop preview won't show it.

## Environment variables

```bash
cp .env.example .env
```

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are only needed from block 7 onward — before
that the app works fully offline without them. In Cloudflare Pages the same variables are set
in the project settings (Settings → Environment variables), not in a file.

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
  pages/        screens (spec section 7) — Calendar, DayScreen, PeriodSummary,
                Settings, DayTypes, Holidays, PastPeriods, ExportRestore
  components/   reusable UI components
  db/           Dexie schema, local user_id before sign-in
  store/        Zustand stores
  lib/calc/     calculation logic (spec section 6) — pure functions
  lib/sync/     Supabase client, sync (block 7)
  lib/export/   JSON backup and restore (block 5)
  i18n/         text dictionary (ru; pl to be added later without touching components)
  types/        data model (spec section 5)
public/         PWA icons, static files
supabase/sql/   Postgres schema and RLS policies (block 7)
workers/        Cloudflare Workers: reminders (block 8), keep-alive (block 9)
```

## Deployment

Cloudflare Pages, auto-deploys from this repository on push to `main`. Build command —
`npm run build`, output directory — `dist`.

## Status

Block 0 (foundation) — project skeleton, PWA manifest and icons are in place. Next up —
section 10 of TIMEO-SPEC.md.
