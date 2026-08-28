# Timeo

Source of truth for product and architecture — [SPEC.md](SPEC.md). All decisions there
are agreed with the customer and must not be reinvented without an explicit instruction. Read it
before any work on functionality.

## Who the user is

The end user is not a developer, and tests changes remotely on an iPhone 13 Pro through an
intermediary (the customer). Hence: don't break the production deploy without extreme necessity,
changes are verified with screenshots, not guesses.

## Invariants that must not be violated

* Changes in one period (`periods`) never affect totals in another period — section 6.3.
* No input field blocks saving (no hard validation) — section 8.
* Multipliers do not multiply together, one rule wins — section 6.2.
* The local database (Dexie/IndexedDB) is the primary data source, the screen doesn't wait on the network.
* Changing `period_start_day` is forbidden while closed periods exist.

## Stack

React + TypeScript + Vite, Tailwind v4, Dexie (IndexedDB), Zustand, react-router-dom,
vite-plugin-pwa, Supabase (Postgres + Auth, from block 7), Cloudflare Pages/Workers.

## Structure

```text
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

* Commit, push, create pull requests, and perform related Git operations when the work is complete. Do not wait for an additional request.
* Do not commit or push unfinished or broken work.
* Do not delete user data irreversibly — soft delete only (`deleted_at`) with an undo window.
* `lib/calc/*` — pure functions covered by unit tests; don't couple them to Dexie/React.
* Secrets (Supabase URL/anon key) — only via environment variables, never hardcoded.

## Git and Pull Request Rules

* **All Git-related text must be in English:** commit messages, branch names, PR titles, PR descriptions/bodies, comments, and related Git messages.
* Use concise, descriptive commit messages. Follow conventional commits where appropriate, e.g. `fix: prevent cross-period recalculation`.
* Keep commits focused. Do not create unnecessary commits for trivial changes.
* After completing and verifying a change, commit and push it automatically.
* Create a pull request after pushing when the task is a meaningful change.
* **PR descriptions must be short.** Do not write large AI-generated summaries or repeat the implementation details.
* A PR body should normally contain only:

  * **What changed** — 1–3 short bullet points.
  * **Verification** — tests/checks that were actually run.
  * **Notes** — only if there is something important for the reviewer/customer.
* Do not include long sections such as "Why", "What changed" with detailed implementation history, "Invariants", "Manual verification" logs, or a full list of fixes unless explicitly requested.
* Do not paste large diffs, code, logs, or implementation details into PR descriptions.
* If the change is straightforward, a PR body of **2–6 lines is preferred**.
* Do not add unnecessary emojis, marketing language, or phrases such as "This PR delivers a robust..." to GitHub content.
* Never claim tests or checks were run unless they were actually run.
* Keep GitHub communication factual and concise.
* If the repository has existing Git/GitHub conventions, follow them unless they conflict with these rules.

### Default PR format

```markdown
## Changes
- Brief description of the main change.
- Brief description of any important secondary change.

## Verification
- `npm test`
- `npm run build`
```

Only include commands that were actually executed.

