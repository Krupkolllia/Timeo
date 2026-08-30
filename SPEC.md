# Timeo — Specification

Shift tracking and wage calculation app. A replacement for SuperShift, built for one specific person.

This document is the source of truth. Decisions recorded here were made deliberately and must not be
re-invented during implementation. Where a rule looks arbitrary, it is usually the resolution of a
conflict documented elsewhere in this file.

---

## 1. Context

**User.** The author's father. Comfortable with smartphones, not a developer. Currently uses the free
tier of SuperShift on an iPhone 13 Pro.

**Device.** iPhone 13 Pro, portrait orientation, installed to the home screen from Safari. This is the
only target. Wide screens must not break, but are not optimised for.

**Language.** Russian UI. All strings live in a single dictionary file so Polish can be added later
without touching components.

**Currency.** Polish złoty (zł) by default, changeable in settings.

**Name.** Timeo. Same name on the home screen icon.

**Cost.** Zero. Free tiers of Cloudflare, Supabase, GitHub.

**Not required.** Mac, Xcode, Swift, Apple Developer account, App Store, TestFlight. This is a web
application served over HTTPS and installed as a PWA. Development happens on any OS.

---

## 2. Requirements as stated by the client

1. The interface is intuitive and predictable.
2. The base hourly rate is per-month, not global. Changing the rate for one month must never
   recalculate earlier months.
3. The user defines their own rates in currency per hour, and can change them for overtime, weekends
   and holidays.
4. Maximum flexibility. No hard validation. There must always be a way to express an unusual case.

Requirements 1 and 4 pull against each other. The resolution is in section 9: nothing is ever blocked,
but every computed number is explainable on screen.

---

## 3. Decisions

| Question | Decision |
|---|---|
| Storage | Local-first. IndexedDB is primary, Supabase is backup and sync |
| What is calculated | Gross only. No tax, no ZUS, no net |
| Mode | Journal of what happened, not a planner. The bottom figure is money already earned |
| Pay period | Configurable start day, default 1 |
| Period naming | By the month the period ends in. Invertible by a setting |
| Day entry | Duration in hours is primary. Start and end times are optional per day type |
| Day types | Fully user-defined. No hardcoded types with special behaviour |
| Rates | Multiplier and absolute rate are independent fields. A lock detaches a type from the base rate |
| Weekends and holidays | Multiplier is pre-filled, visible on the day screen, editable in one tap |
| Jobs | One. The column exists in the schema, never surfaced in the UI |
| Auth | Email and password, plus Google OAuth |
| Notifications | Evening reminder, only when the day is empty. Requires an account |
| Theme | Toggle, system default |
| SuperShift import | None. Past months are entered manually as totals |

---

## 4. Stack

**Frontend.** React, TypeScript, Vite, Tailwind. Minimal routing. Local component state plus a small
store; no Redux.

**PWA.** vite-plugin-pwa in `autoUpdate` mode. Manifest with `display: standalone`, theme colour,
192/512 icons and an apple-touch-icon. The shell is cached and the app is fully functional offline.

**Local storage.** IndexedDB via Dexie. This is the primary store. Everything the user sees is read
from here. No loading spinners on open.

**Cloud.** Supabase Postgres, built in block 8. The schema mirrors the local one
(`supabase/sql/001_schema.sql`, run by hand in the SQL Editor): same tables, same field names, plus
one column the client cannot write — `server_updated_at`, stamped by a trigger. Row Level Security is
on every table with policies keyed on `auth.uid() = user_id`; there is no `DELETE` policy, because
deletion is soft everywhere. The `anon` role holds no privilege at all.

Sync is background and non-blocking: no screen ever waits for it. One cycle pulls first, then pushes.
The pull is incremental on `server_updated_at` — the server's receipt order, so a device with a wrong
clock cannot hide a row from it. The conflict itself is decided on the client, per row, by
last-write-wins on `updated_at`; a timestamp more than a day ahead of the server is repaired to server
time on the way up, so a fast clock cannot win every conflict until that future arrives. Push
watermarks advance only on the server's acknowledgement, so a failed sync retries and loses nothing.

Sign-in is e-mail and password (block 8) or Google (block 8.1). The Google round trip runs on the
PKCE flow, pinned explicitly rather than left at the library's default of implicit: on iOS the return
from the provider may land in Safari instead of in the home-screen icon, and implicit would hand that
other context a working session with the tokens in the address bar. With PKCE the address carries only
a one-time code, and only the context that started the sign-in holds the verifier that can exchange
it. The app parses the return itself rather than letting supabase-js do it silently: the address is
cleaned with `replaceState` before the exchange, so neither a code nor a token survives in the address
bar or in the history entry behind the back button, and a refusal — a cancelled consent screen, a
return that cannot be completed — reaches the account screen in Russian words, never as the provider's
English message.

Google is only another way to obtain an account, not a second way to sign in for the first time: the
session it produces goes into the same path as the password sign-in, so the `user_id` migration, the
"what to keep" question and the different-account warning are one piece of code with one set of
tests.

**Hosting.** Cloudflare Workers with Static Assets, deployed from a private GitHub repository via
Workers Builds. Not Cloudflare Pages: the same Worker later hosts the push sender and the keep-alive
cron, which on Pages would require a second project.

`wrangler.jsonc` at the repository root:

```jsonc
{
  "name": "timeo",
  "compatibility_date": "2026-08-27",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

Deployment is `git push` to the production branch. There is no local deploy command.

**Notifications.** A PWA cannot schedule a local notification for a future time: Safari exposes no such
API and a service worker does not wake on a schedule. The only working path is Web Push from a server.
Therefore:

- enabling reminders requests permission and stores the push subscription in Supabase
- a Cloudflare Worker cron runs hourly, finds users whose reminder time has arrived
- the Worker checks Supabase for an entry on today's date and sends a push only if there is none
- consequence: **reminders require an account and active sync.** Without them the server knows neither
  the device nor whether the day is filled. The reminder toggle must say so plainly when signed out

**Keep-alive.** A Cloudflare Worker cron pings Supabase daily. Free Supabase projects pause after a
week of inactivity.

**Cache headers.** `index.html` and the service worker file must be served with no-cache. Hashed JS and
CSS assets may be cached indefinitely. A cached `index.html` pins the app to stale asset URLs and makes
updates impossible to deliver.

---

## 5. Data model

Every table carries `id` (uuid v4, generated client-side), `user_id`, `created_at`, `updated_at`,
`deleted_at` (soft delete, required for sync).

**Operation without an account.** The app is fully functional before any sign-in; this is a
requirement, not a temporary simplification. Until sign-in, `user_id` holds a local uuid generated on
first launch. On first sign-in every local row is rewritten to the real `user_id` and pushed — one
atomic transaction over the five tables, and `updated_at` is deliberately not touched (5.4.1). If the
cloud already holds data for that account, the user is asked which side to keep, in the same two modes
and the same words the restore screen uses (8.8). Silent merging is forbidden. Nothing is written
until the answer is given, so closing the app mid-question changes nothing and asks again.

The active `user_id` has exactly one source (`src/store/userStore.ts`): the account id once a first
sign-in has completed on this device, the anonymous uuid until then. Signing out changes neither —
the data stays under the account id and sync simply stops.

### 5.1 `settings`

One row per user.

- `currency` — default `PLN`
- `period_start_day` — 1..28, default 1. Values above 28 are not allowed, because February would make
  some periods start on a date that does not exist
- `period_naming` — `end_month` | `start_month`
- `default_hours` — fallback duration, default 8 h
- `default_base_rate` — base rate used when a period is created with no predecessor, and the
  destination of "apply from next period"
- `default_norm_hours` — same for the hours norm
- `weekend_multipliers` — `{ saturday, sunday, holiday }`
- `theme` — `system` | `light` | `dark`
- `week_starts_on` — Monday
- `reminder_enabled`, `reminder_time`
- `preferred_rate_change_mode` — remembered answer to the rate change dialog
- `seeded_holiday_years` — years whose Polish public holidays have already been seeded (5.5)
- `total_hours_paid_only` — default `true`. Whether 6.5's "total hours" and norm figures are summed
  from paid/worked hours or from total shift time; see 6.5
- `schema_version`

### 5.2 `periods`

The table that implements requirement 2.

- `year`, `month` — stable identity of the period, independent of how it is displayed
- `base_rate` — base hourly rate for this period
- `norm_hours`
- `extra_amount`, `extra_note` — bonuses and deductions for the period as a whole
- `is_closed`
- `closed_totals` — snapshot of hours and money taken at closing
- `is_manual` — a historical period entered by hand; it has no entries

**Isolation mechanism.** When a period is first touched, a row is created by *copying* values from the
previous period. Copying, not referencing. Changing `base_rate` for August cannot physically affect the
July row. If no previous period exists, `default_base_rate` and `default_norm_hours` are used.

**Period of a date.** For a date D and `period_start_day = S`:

```
if day(D) >= S:  period starts in month(D)
else:            period starts in the previous month
```

The period is then named after its start month or its end month according to `period_naming`.
With `S = 1` the two coincide.

### 5.3 `day_types`

A day type is a user template. There are no hardcoded types with special behaviour in code. A handful
are seeded on first launch, but they are ordinary rows: renameable, editable, deletable.

**Appearance**
- `name` — free text, up to 40 characters, not required to be unique
- `color` — one of 12–16 palette values chosen to read in both themes
- `label` — 1 to 3 characters for the badge. Letters, digits or emoji. No icon editor: a coloured
  circle with these characters
- `note` — free description, shown in the type picker

**Time**
- `default_start`, `default_end` — `"HH:MM"` local wall-clock strings, either may be null. Stored as
  strings rather than minutes-from-midnight to match `entries.start_time`/`end_time` and the one parser
  in `lib/calc/duration.ts` that reads both (recorded as a field-name deviation in 5.4.1)
- `default_break_minutes` — meaningful only together with both times; a break has nothing to be
  measured against without a start and an end
- `default_break_paid_minutes` — see "Paid break" below
- `default_hours` — used by types without both times. Fills the role this section originally gave
  `default_duration_minutes`; see 5.4.1 for why no separate field exists

Precedence: if both `default_start` and `default_end` are set, duration derives from them and
`default_hours` is ignored for the derivation (it remains stored and used only as this same fallback
for other types). If times are absent, `default_hours` is used. If that is absent too — it never is,
the field always holds a number — `settings.default_hours` would apply.

**Paid break.** Not part of the original requirements; added because a break is not always unpaid in
practice. `default_break_paid_minutes` is a single number: how many minutes of the break are paid.
`0` reproduces the pre-existing behaviour (break entirely unpaid); a value equal to
`default_break_minutes` pays the break in full; anything in between pays it partially. A single number
was chosen over a `break_pay_mode: unpaid | paid | partial` enum plus a separate amount because it
already expresses all three states by itself and cannot fall out of sync with a second field the way an
enum-plus-number pair could. See 6.1 for the formula and `entries.paid_break_minutes` in 5.4 for the
per-entry equivalent.

**Pay**
- `pay_mode` — `hourly` | `fixed_amount` | `unpaid`
- `rate_mode` — `multiplier` | `pinned`
- `multiplier` — factor applied to the period base rate, 6 decimal places
- `pinned_rate` — absolute hourly rate, used when `rate_mode = pinned`
- `fixed_amount` — per-day amount when `pay_mode = fixed_amount`

**Accounting**
- `counts_as_work` — do these hours enter the "total hours" figure
- `counts_toward_norm` — do they count against the hours norm
- `allow_auto_multipliers` — may weekend and holiday multipliers be substituted for this type

**Housekeeping**
- `sort_order`, `is_archived`

#### 5.3.1 The rate lock

The form shows two adjacent fields, **Multiplier** and **Rate, zł/h**, plus a lock toggle labelled
"independent of the base rate".

The two fields are **independent**. Typing into one never rewrites the other. Which of them is used
is decided by `rate_mode`, never by whether a field happens to hold a value.

Lock open (`rate_mode = multiplier`), the default:

- the type's rate is the base rate of whichever period is on screen; the multiplier applies on top
  of it when the day's amount is computed, per 6.4
- the form shows a read-only preview of the result — "at a base of 30 zł/h that is 45 zł/h an hour"
- when the period base rate changes, the effective rate follows; the multiplier is preserved
- a number left in the rate field is kept but not used; reopening the lock does not silently detach
  the type from the base rate

Lock closed (`rate_mode = pinned`):

- the rate field is authoritative and stored in `pinned_rate`
- **no multiplier is applied at all**, per 6.2 — neither the type's own nor the weekend or holiday
  one. A pinned rate is already the finished number
- changes to the period base rate have no effect on this type

Closing the lock is a deliberate act, never a side effect of typing into the rate field. People often
type a rate they know by heart without meaning to detach it from the base.

**An earlier version of this section derived one field from the other**: a typed multiplier rewrote
the rate as `base_rate × multiplier`, and a typed rate rewrote the multiplier as `rate ÷ base_rate`.
That was the model removed from the day screen in commit `4cc25c5`, which moved the multiplier out
of the rate (see 6.3 and 6.4) — the two documents described two different models at once. The
derivation is unsound under the current formula: both fields end up carrying the same factor and
`amount = hours × rate × multiplier` applies it twice. A hand-typed 50 zł/h at a base of 30
recomputed 400.00 zł into 666.80 zł, and repairing entries already stored that way needed a
dedicated Dexie migration. The read-only preview shows the user the same number without storing a
derived value.

**A day type's rate is always displayed in the context of a period.** The form carries a header line
such as "August 2026, base 30 zł/h". Without it, an absolute number inside a global object is
meaningless: it is one value in July and another in August.

#### 5.3.2 Automatic multipliers

`allow_auto_multipliers` defaults to true for types whose multiplier is 1, and false for types that
carry their own multiplier. If someone created "Weekend shift ×2", they have already expressed what
they are paid; layering Sunday's multiplier on top corrupts the data rather than helping.

When the flag is on and the date is a holiday or weekend, the automatic multiplier **replaces** the
type's multiplier. Multipliers never compound. The source is always labelled on the entry screen.

### 5.4 `entries`

A fact about a date. Multiple entries per date are allowed.

**Links and time**
- `date` — start date of the shift, stored as a `YYYY-MM-DD` local calendar string
- `day_type_id`
- `start_time`, `end_time` — `"HH:MM"` local wall-clock strings, nullable (field-name deviation from
  this section's original `start_minutes`/`end_minutes`, see 5.4.1)
- `break_minutes` — nullable
- `paid_break_minutes` — nullable; how many minutes of `break_minutes` are paid, see 5.3's "Paid break"
  and 6.1. `null` and `0` mean the same thing, matching `break_minutes`' own null-safe convention
- `hours` — final duration, in decimal **hours** (deviation from this section's `duration_minutes`,
  recorded in 5.4.1) and always the **paid/worked** hours: what `pay_mode = hourly` multiplies by the
  rate, and what feeds 6.5's totals when `settings.total_hours_paid_only` is on. The shift's total time
  (including the break) is never stored — it is recomputed on demand from `hours`, `break_minutes` and
  `paid_break_minutes` (`lib/calc/duration.ts:totalShiftMinutesOf`), never from the day type
- `duration_is_manual` — duration typed by hand, no longer derived from times

**Money, snapshot at the time of calculation**
- `multiplier` — the multiplier actually applied
- `rate_per_hour` — the rate actually applied, always populated
- `rate_is_manual` — the rate was set by the user or frozen by the system; excluded from automatic
  recalculation
- `amount` — computed amount in grosze
- `amount_override` — when present, overrides everything
- `rate_source` — describes how the **rate** was produced, not the multiplier. Since `4cc25c5` split
  the two, a new entry only ever gets `period_base` (the rate is the period's base rate),
  `type_pinned` (the day type's own rate, `rate_mode = pinned`), `manual` (typed by the user) or
  `frozen` (fixed by the system when a base rate was applied from a date, 6.6). The values
  `weekend_rule`, `holiday_rule` and `day_type_default` explained the rate under the old model and
  still exist in entries written before that commit; the breakdown screen must keep rendering them,
  but nothing writes them any more. What a weekend, holiday or day type contributed is the
  *multiplier*, and its source is shown next to the multiplier field. Drives the breakdown screen
  and makes bugs diagnosable

**Other**
- `note`

**Snapshot principle.** An entry stores every number its calculation needed. Once saved it is
self-contained. A day type may be edited, archived or re-priced afterwards; existing entries are never
affected. Only cosmetics — name, colour, badge — are read from the type at render time.

### 5.4.1 Accepted deviations of the implementation from this section

Recorded rather than repaired. Each was a deliberate decision; changing any of them now would touch
the calculation layer and every stored row, for no gain the user can see.

- **Money is floating point, duration is decimal hours.** Invariants 16 and 17 call for integer
  grosze and whole minutes. The code stores `number` for money and a decimal `hours` on the entry,
  rounding to the grosz once on the daily amount (18) and to two decimals on stored values. The
  totals reconcile exactly, which is what 19 actually protects.

  6.1 derives duration in **whole integer minutes** — `"HH:MM"` is parsed by hand, no `Date` object
  is built — and converts to the stored decimal `hours` by a single division by 60 that is
  deliberately **not rounded**. Rounding the duration to hundredths would make a 7 h 20 min shift
  store 7.33 and pay 219.90 zł instead of 220.00 at 30 zł/h; 18 rounds once, on the daily amount,
  and pre-rounding the duration breaks that. `lib/format/hours.ts` renders the value (at most two
  decimals) wherever it reaches the screen, which is what invariant 20 describes.
- **Field names.** `day_types` stores `default_multiplier` for 5.3's `multiplier`, `default_rate`
  for `pinned_rate`, and `ignore_auto_multipliers` for the inverse of `allow_auto_multipliers`. The
  UI wording follows this document ("allow"); only the stored key is inverted. `rate_mode` decides
  whether `default_rate` is used — a value left in the field does not by itself pin the type.

  `day_types.default_start`/`default_end` and `entries.start_time`/`end_time` store `"HH:MM"` local
  wall-clock strings, not "minutes from midnight" as this section names them. The single time parser
  in `lib/calc/duration.ts` (`parseTimeToMinutes`) already read strings for entries before this work;
  giving the day type's own times a second representation would have meant two parsers for one
  concept. `default_hours` plays the role this section calls `default_duration_minutes` — no field of
  that name exists, and none is planned; the substitution is exact in meaning ("this type of day lasts
  this long") and is now a permanent naming choice, not a deferred gap.

- **Day type default times are implemented**, including the paid-break concept from 5.3 that this
  document did not originally have. `default_start`, `default_end`, `default_break_minutes` and
  `default_break_paid_minutes` exist and drive the priority ladder in 5.3 and the formula in 6.1;
  invariants 28, 30 (generalised to the *unpaid* portion of the break), 31 and 32 hold for it the same
  way they hold for a day's own times.

- **The shift times are shown by a disclosure in the day sheet, and, since block 7, also by a
  `settings.show_shift_times` toggle on the settings screen (8.4).** The sheet still carries its own
  "Время смены" row and a day whose entry already holds times still opens expanded — the settings
  toggle only changes the default a fresh day starts from.

- **`duration_is_manual` is true on every entry that predates 6.1.** The `version(8)` upgrader sets
  the flag and changes nothing else — no stored `hours`, no `amount`, no `updated_at`, no closed
  period. Nothing in the database was ever derived from the times, so true is the accurate value; false
  would have made the next Save on any day with times rewrite a wage the user had typed by hand.
  Import applies the same default to files written by older versions (invariant 50). Turning
  derivation on for such a day is a visible, per-day act: the "считать по времени" button in 8.2.

- **`paid_break_minutes` is `0` on every entry and `default_break_paid_minutes` is `0` on every day
  type that predates the paid-break work.** The `version(9)` upgrader sets this and changes nothing
  else. Before this work every break was unpaid by construction — `0` is not a cautious default, it is
  a literal description of what already happened to every stored row: `worked = total − break + 0` is
  exactly the pre-existing `duration = raw − break_minutes`. Day types also get
  `default_start = default_end = default_break_minutes = null`, so the derivation-from-times branch
  stays untaken for them and `default_hours` keeps driving new entries exactly as before. Import
  applies the same `0` default to files that predate this field (invariant 50).

- **The manifest's `theme_color` (`vite.config.ts`) stays dark in both themes.** The manifest is
  static and read once at install time, well before `settings.theme` exists to read; the runtime
  `<meta name="theme-color">` (`index.html`) is what block 7's light theme actually updates, live, via
  `useTheme`. `apple-mobile-web-app-status-bar-style` also stays `black-translucent`; whether that
  reads badly under the light theme on-device is a screenshot check, not a code question — recorded
  here as a known risk, not fixed pre-emptively.

- **`reminder_enabled` and `reminder_time` are settable from block 7's settings screen, but nothing
  reads them yet.** No notification is scheduled from either field — that is block 9's work. The
  screen says so plainly rather than implying the toggle already does something.

- **`period_start_day` cannot be changed while any closed period exists** (`setPeriodStartDay`,
  `src/db/settings.ts`). The field is one global number that `periodForDate()` uses to decide which
  period *every* day belongs to; shifting it moves days out of a closed period (whose totals are a
  frozen `closed_totals` snapshot that would not follow them) and into a neighbouring open one (whose
  totals recompute and would pick the same days back up) — the same hours would be paid twice. A
  correct fix needs a piecewise period function — a start-day snapshot per period, or a "day changed,
  effective from" field — which is a rewrite of `lib/calc/period.ts` and every caller, roughly the size
  of the rest of block 7. Deferred to its own block; the settings screen explains the lock and links to
  the list of periods instead of hiding the reason.

- **Block 8, the cloud: what was decided and why.**

  - **`server_updated_at` exists in Postgres and nowhere locally.** Invariant 42 asks for the server's
    receipt order where clocks disagree, and one client-written `updated_at` cannot provide it. The
    column is written by a trigger, the client never sends it, and the incremental pull filters on it.
    Conflicts are still decided by `updated_at` (invariant 41); the server column is the pull cursor
    and the tie-break, never the resolver.

  - **A `updated_at` more than 24 hours ahead of the server is repaired to server time when the row is
    pushed**, locally as well as in the cloud. Nothing but the timestamp changes: no amount, no
    `closed_totals`, no closed period. Without the repair a phone whose clock is a year fast wins every
    conflict for a year — the literal failure invariant 42 names.

  - **The settings row's id in the cloud is the account's `user_id`.** One row per user is a unique
    constraint in Postgres, and two devices would each have created that row with their own random
    uuid, so the second device's push would fail forever. The id is normalised at the start of every
    sync; no field, including `updated_at`, is touched by the normalisation.

  - **No foreign key from `entries.day_type_id` to `day_types.id`.** Invariant 37 is enforced on the
    client — types are applied and pushed before entries, and an entry whose type has not arrived yet
    is held back rather than written. A database-level key would reject the whole push instead, and
    invariant 43 forbids losing local data over it.

  - **Soft-deleted rows are still never purged.** Invariant 38 keeps them "until sync has propagated
    the deletion", and with no device registry there is nothing that can prove propagation. They stay,
    locally and in the cloud, in exchange for a deletion that can never come back. This is why
    `seeded_holiday_years` (5.5) remains the record of what has been seeded.

  - **`push_subscriptions` is created by the block 8 schema although nothing reads it until block 9.**
    It is cloud-only and never part of an export (5.6, invariant 46). Creating it now costs one table
    and saves a schema migration later.

  - **`sync_meta` is a local Dexie table (`version(10)`), not user data.** Pull cursors, push
    watermarks and the last error live there. It is never exported and never uploaded.

  - **First sign-in on a device with nothing but the first-launch seed does not ask.** The question
    exists to stop a silent merge of two sets of *work*; day types, settings and holidays are seeded
    by the app itself on every device. "Meaningful" therefore means periods or entries. With none of
    them locally and data in the cloud, the cloud copy simply becomes this device.

  - **There is no password reset.** The Supabase project has e-mail confirmation off
    (`mailer_autoconfirm`), so no mail is sent at all, and a reset link would need an external SMTP
    provider. Sign-in is e-mail and password only; recovery is the customer's job in the Supabase
    console until an SMTP provider exists.

  - **Foreground sync runs on a 60-second timer, on return to the app, and on regaining the network.**
    Local writes do not announce themselves — screens write to Dexie and know nothing about the cloud,
    which is the point — so a cheap timer is the price of that independence. There is no realtime
    subscription.

  Block 8.1 (Google sign-in) added these:

  - **The flow is PKCE, pinned in the client, and `detectSessionInUrl` is off.** supabase-js defaults
    to implicit, which returns the tokens themselves in the address. On iOS the return can land in
    Safari rather than in the home-screen app, and implicit would leave a working session and its
    tokens in that other context's address bar, tab and history. PKCE returns a one-time code that
    only the context holding the verifier can exchange, so the same misdirected return produces
    nothing instead of a live session in the wrong place. Automatic URL detection is off because the
    app cleans the address and reports the failure itself, and neither can be tested when the library
    does it silently.

  - **The return goes to `/more/account`, and no callback route exists.** That screen is where the
    button was pressed and where all four outcomes already live (signed in, refused, the "what to
    keep" question, the different-account warning). The parsing itself happens at app start, on
    whatever address the app opens on: if the Redirect URLs list in Supabase is ever incomplete,
    Supabase sends the person to the Site URL — the calendar — and the code has to disappear from the
    address there too.

  - **A return that lands in Safari signs the person in inside Safari, and the home-screen app stays
    signed out.** A home-screen web app and Safari do not share storage, and nothing in a PWA can
    force the return back into the icon. The app cannot repair this; it says so in words next to the
    button and asks for another attempt from the icon. Nothing is lost either way — the local database
    is untouched by a failed sign-in.

  - **Whether one address used both with a password and with Google is one account or two is decided
    by the Supabase project, not by this app.** If the project links them, the second sign-in returns
    the same `auth.uid` and nothing happens. If it does not, the `auth.uid` differs and the person
    meets the different-account warning of invariant 44 — a warning with counts and a separate
    confirmation, never a silent erase. The app deliberately does not try to guess which case it is
    in, because both are handled by the same code.

### 5.5 `holidays`

- `date`, `name`, `is_custom`

Polish public holidays are seeded and fully editable: delete what does not apply, add company days off.

**Which years, and when.** The current year and the next, checked at every launch, so next January is
never empty and the window rolls forward on its own. Past years are not seeded: by invariant 51 a
holiday laid over an existing entry changes no stored number, so seeding backwards would add scrolling
and nothing else.

**Seeding is idempotent and atomic**, in one `rw` transaction over `settings` and `holidays` — the
same reason the day type seeder has one: React StrictMode's double effect would otherwise duplicate
every row. The unit of seeding is the *year*, recorded in `settings.seeded_holiday_years`. A year is
never seeded twice, so a holiday the user deleted does not come back. "Already seeded" is deliberately
not inferred from the presence of holiday rows: deletion is soft, but invariant 38 keeps deleted rows
only until sync has propagated them, and after that the app would restore exactly what the user erased.

The four movable holidays (Easter Sunday, Easter Monday, Pentecost = Easter + 49, Corpus Christi =
Easter + 60) come from a pure computus in `lib/calc/easter.ts`; dates are built as local `YYYY-MM-DD`
strings and never serialised through UTC (invariant 27).

### 5.6 `push_subscriptions`

- `endpoint`, `keys`, `device_label`, `last_seen_at`

Cloud only. Never part of an export file.

---

## 6. Calculation

### 6.1 Duration

```
if duration_is_manual:
    worked = hours                    // typed by hand; total is shown for
                                       // display only, computed algebraically
else if start and end are set:
    total       = end − start
    if total <= 0: total += 24 h      // shift crosses midnight
    break       = break_minutes
    paid_break  = paid_break_minutes  // how much of the break is paid, 5.3
    worked      = total − (break − paid_break)
else:
    worked = day_type.default_hours
             or settings.default_hours
```

`worked` is what is stored in `entries.hours`: the paid/worked duration, exactly what `pay_mode =
hourly` multiplies by the rate (6.4) and — by default — what 6.5 sums into "total hours" and the norm.
The shift's total time (`total` above) is never stored; it is always recomputed from `hours`,
`break_minutes` and `paid_break_minutes` for display, and is shown next to the hours field in the day
sheet (8.2) alongside the break itself, so the three related numbers — total time, worked hours, break
— are all visible together.

**Paid break, generalising invariant 30.** A break longer than the shift still yields zero worked hours
and a warning, but the condition is now about the *unpaid* portion: zero and a warning happen exactly
when `total − (break − paid_break) < 0`. At `paid_break = 0` this is the original condition unchanged.
`paid_break` greater than `break` is not rejected (invariant 54): it lengthens the paid time beyond the
shift's total span, the mirror image of a negative `break_minutes` already doing the same from the
other side of the formula.

Duration is wall-clock. Daylight saving transitions are ignored: a shift from 22:00 to 06:00 is always
eight hours, including on the night the clocks change. The alternative produces an hour of unexplained
difference twice a year.

### 6.2 Multiplier

```
if day_type.rate_mode = pinned:
    no multiplier is applied; see 6.3
if allow_auto_multipliers and date is a holiday:
    multiplier = holiday multiplier,   source = holiday
else if allow_auto_multipliers and Sunday:
    multiplier = Sunday multiplier,    source = sunday
else if allow_auto_multipliers and Saturday:
    multiplier = Saturday multiplier,  source = saturday
else:
    multiplier = day_type.multiplier,  source = type_multiplier
```

### 6.3 Rate

```
if rate_is_manual:
    rate = entry.rate_per_hour                    source = manual | frozen
else if day_type.rate_mode = pinned:
    rate = day_type.pinned_rate                   source = type_pinned
else:
    rate = period.base_rate
    entry.rate_per_hour := rate                   // the result is stored on the entry
```

**The multiplier is not part of the rate.** The rate is a rate: the period base rate, or the one
typed by hand, and that is exactly what the rate field shows. The multiplier is a separate
coefficient applied only when the day's amount is computed, see 6.4.

Folding the multiplier into the rate would make it useless in the one case that matters most: on a
period whose base rate is not set yet, `base_rate × multiplier` is zero whatever the multiplier is,
and a rate typed by hand would never be multiplied at all.

### 6.4 Amount

```
if amount_override is set:        amount = amount_override
else if pay_mode = unpaid:        amount = 0
else if pay_mode = fixed_amount:  amount = day_type.fixed_amount
else:                             amount = duration_in_hours × rate × multiplier
```

Rounding to the grosz happens **once**, on the daily amount — that is, on the whole
`hours × rate × multiplier` product. The rate itself is stored rounded, because it is a value the
user sees and edits in a field; multipliers are not rounded in intermediate steps. The period total is the sum of already-rounded daily amounts, with no second
rounding pass.

### 6.5 Period totals

```
duration      = entry.hours                              if settings.total_hours_paid_only (default)
              = total shift time (6.1), incl. the break   otherwise

amount        = Σ entry amounts + extra_amount
total hours   = Σ duration where day_type.counts_as_work
norm hours    = Σ duration where day_type.counts_toward_norm
remaining     = norm_hours − norm hours
```

**"Total hours" is unambiguous: it means paid/worked hours by default.** `settings.total_hours_paid_only`
(default `true`) is what decides it, per-entry, for both `total hours` and `norm hours` alike — there is
no reason for the calendar footer and the remaining-to-norm figure to disagree about what an hour means.
With the default on, this is exactly `entries.hours` summed as before the paid break existed: nothing
changes for anyone until they turn the setting off. With it off, an entry with a paid break contributes
more than `entries.hours` to both figures — see 6.1 for how the total is derived.

For periods with `is_manual = true` no summation occurs; totals come straight from `closed_totals`.

Closing a period writes totals into `closed_totals`, using whatever `settings.total_hours_paid_only`
reads at the moment of closing. After that, no change to settings, rules or rates affects it — flipping
the setting later does not reopen or resum a closed period's snapshot.

### 6.6 Changing a period's base rate

Saving a new `base_rate` presents three choices. The previous answer is preselected but the dialog is
always shown.

**Recalculate the whole period.** Entries of this period only. Recalculated if `rate_is_manual` is
false, `amount_override` is empty, and the day type is not pinned. Everything else is left alone.

**Apply from a given date.** Entries before that date get `rate_is_manual = true` with their current
`rate_per_hour` and `rate_source = frozen`. Entries from that date onward are recalculated.

**Apply from the next period.** No entry in the current period is touched. The new value goes to
`settings.default_base_rate` and is picked up when the next period is created.

Day type rates are not stored anywhere and therefore do not migrate: they are derived from the base
rate of whichever period is on screen. That is why a past month cannot change — it has its own base
rate and its entries already hold frozen numbers.

### 6.7 Editing a day type

Two categories, kept strictly apart.

**Cosmetic.** Name, colour, badge, note, sort order. Applied immediately and everywhere, including
closed periods. They touch no money, so there is nothing to ask.

**Financial.** Multiplier, rate, lock state, `pay_mode`, `fixed_amount`, accounting flags, default
times. They change the behaviour of **future** entries only. Existing entries are never recalculated
automatically.

After a financial change, if the type is already used in the current open period, the app offers:
"Update 4 entries in the current period?" with Update and Leave as is. The default is Leave. Entries
with a manual rate or an amount override are excluded from the count and are not updated even on
consent.

The offer covers the current period only. Past periods are never included. Fixing a past month is done
deliberately, from that period's summary screen.

---

## 7. Invariants

Rules that must hold under every possible sequence of actions. Each one deserves a test.

### 7.1 Period isolation

1. Any single operation modifies entries of at most one period. No action touches two periods at once.
2. A closed period is fully immutable. Adding, editing or deleting an entry inside it is rejected with
   an explanation and an offer to reopen.
3. Reopening a closed period is an explicit action with confirmation. `closed_totals` is preserved
   until the period is closed again, so before-and-after can be compared.
4. `period_start_day` cannot be changed while any closed period exists.
5. A period with `is_manual = true` is never summed from entries; its totals come from
   `closed_totals`.
6. Creating a period never modifies the period it copied from.
7. Navigating the calendar forward creates periods lazily. Jumping to a distant future month must not
   create the intermediate ones; the new period copies from the most recent *existing* earlier period,
   or from settings if none exists.

### 7.2 Snapshots and recalculation

8. An entry with `amount_override` is never recalculated by any operation.
9. An entry with `rate_is_manual = true` is never recalculated automatically.
10. Editing a day type modifies no existing entry. Updating is possible only with explicit consent and
    only within the current period.
11. Deleting a day type is impossible while any entry references it. Archiving is offered instead: it
    disappears from the picker but remains visible on old entries.
12. An archived day type can be unarchived at any time.
13. Recalculating a period twice in a row yields the same result as once. Every recalculation is
    idempotent.
14. Any recalculation is atomic: either every affected entry is updated or none is. A crash mid-way
    must not leave a period half-recalculated.
15. `rate_source` always agrees with how the number was actually produced. It is written by the
    calculation, never by the UI.

### 7.3 Numbers

16. Money is stored as integer grosze. Rates are stored as integer hundredths of a grosz, that is four
    decimal places. Multipliers carry six decimal places. Floating point is never used for money.
17. Duration is stored as whole minutes. Hours exist only for display.
18. Rounding to the grosz happens exactly once, on the daily amount.
19. A period total equals the sum of its daily amounts exactly. A one-grosz discrepancy is a bug.
20. A rounded value shown in an input is never written back to storage in place of the original.
    A multiplier of 1.566666 displays as 1.57 and remains 1.566666.
21. Values are re-derived from stored numbers on every render. Nothing displayed is cached in a way
    that could survive a change to its inputs.

### 7.4 Degenerate values

22. If `base_rate` is zero or unset, typing a rate in the day type form cannot derive a multiplier. The
    lock closes automatically, the value is stored as `pinned_rate`, and an explanation is shown.
23. A multiplier of zero is legal and means an unpaid day. This differs from `pay_mode = unpaid`, which
    ignores hours and rate entirely.
24. Negative rates, multipliers and amounts are legal. A soft warning appears; saving is not blocked.
    This is a legitimate way to record a deduction.
25. Zero duration is legal: a marked day with no hours.
26. Extremely large values do not corrupt layout. Amounts are formatted and truncated with an ellipsis
    rather than overflowing their container.

### 7.5 Time and dates

27. Dates are stored as `YYYY-MM-DD` local calendar strings. A `Date` object is never serialised, and
    no value is ever converted through UTC. Otherwise a user east of Greenwich loses a day at midnight.
28. If end is less than or equal to start, the shift crosses midnight and 24 hours are added to the
    difference.
29. A shift starting 31 August at 22:00 and ending 1 September at 06:00 belongs entirely to August.
    Hours and money are never split across periods.
30. A break longer than the shift yields zero duration and a warning, and still saves.
31. Daylight saving transitions are ignored; duration is wall-clock.
32. Any number of entries per date is allowed. More than 24 hours on one date is allowed with a soft
    warning.
33. The app must behave correctly when the device clock is wrong or the timezone changes mid-session.
    Nothing derives correctness from `Date.now()` other than the definition of "today".
34. Leap days are ordinary days. 29 February needs no special handling anywhere.

### 7.6 Referential integrity

35. Every entry references an existing day type. A type cannot vanish while references exist.
36. Import restores day types under their original identifiers. If an identifier is taken by a
    different type, a new one is created and the imported entries are repointed to it. No orphaned
    entries may exist after an import.
37. Sync can never produce an entry referencing a missing type. On conflict, the version in which the
    type exists wins.
38. Soft-deleted rows are excluded from every query and every total, but are retained until sync has
    propagated the deletion.

### 7.7 Sync and offline

39. The app is fully usable with no network and no account. Sync is an enhancement, never a
    prerequisite.
40. Local writes never wait for the network. The UI reflects the local state immediately.
41. Sync is last-write-wins on `updated_at`, applied per row, never per table. Two devices editing
    different entries in the same period must not overwrite each other.
42. `updated_at` is set from the client clock but sync is ordered by the server's receipt order where
    they disagree. A device with a clock a year fast must not permanently win every conflict.
43. A failed sync is retried and never loses local data. Data is deleted locally only after the server
    has acknowledged it.
44. Signing out does not erase local data. Signing in as a different user does erase it, after an
    explicit warning.
45. Closed periods sync like any other row; closing is not a client-only concept.

**What block 8 actually guarantees, and where it stops.** 39 and 40 hold by construction: no screen
awaits the network, and with no environment variables the app behaves exactly as it did before block 8.
41 holds per row, decided by a pure function with no Dexie and no network in it. 42 holds through the
server-written `server_updated_at` (pull order) plus the repair of far-future timestamps on push. 43
holds for the push: watermarks advance only on the server's acknowledgement, and nothing is ever
hard-deleted locally, so a failed sync retries and cannot lose a row. 44 holds: signing out touches no
row, signing in as a different account erases only behind a warning that names the counts and a
separate confirmation.

45 holds, and its meeting point with invariant 2 is decided explicitly: a closed period arriving from
the cloud is applied like any other row. Invariant 2 governs what the *app* lets a person do to a
closed period — no adding, editing or deleting entries inside it — not whether the same person's own
row may replicate from their other device. `closed_totals` travels with the row, so the frozen numbers
are what arrives; nothing is recomputed on receipt.

**What block 8.1 adds, and where it stops.** Google sign-in changes none of the guarantees above. It
produces an account and hands it to the same code the password sign-in uses, so 44 and 47 hold through
the same branches and are covered by tests that drive them from a Google return as well. Two limits are
named rather than implied. A return from the provider that lands in Safari instead of in the
home-screen app cannot sign that app in — storage is not shared, and no web application can force the
return back into the icon; the app says so and stays usable, and the only recovery is to start the
sign-in again from the icon. And the guarantee about the address — no code and no token left in the
address bar or in the history entry — rests on `history.replaceState`, which is what the tests check;
what a particular iOS version keeps in its own address bar afterwards can only be confirmed on the
device.

Two limits are worth naming rather than implying. The conflict is resolved on the client and the push
is then a plain upsert, so an edit made on another device *between* this device's pull and its push is
overwritten by the winner this device computed; the window is one sync cycle, and the loser's own next
cycle brings the newer row back only if its `updated_at` is later. And a soft-deleted row is never
purged anywhere (38, 5.4.1) — the database only grows.

### 7.8 Export and import

46. Export produces a single JSON file containing `schema_version`, settings, periods, day types,
    entries and holidays. Push subscriptions and auth tokens are excluded.
47. Import offers two modes: replace everything, or add what is missing. Silent merge is never the
    default.
48. Import of a file with a newer `schema_version` than the app is refused with a clear message rather
    than partially applied.
49. Import is atomic. A malformed file leaves the database exactly as it was.
50. An export written by version N must remain importable by every later version. Migrations run on
    import.

### 7.9 Holidays

51. Editing the holiday list never recalculates existing entries. It affects only the multiplier
    proposed for new ones.
52. A holiday added to a date inside a closed period changes nothing there.
53. Two holidays on the same date are allowed. The multiplier and the name shown come from the
    earliest by `created_at`, tie-broken by `id`.

    Originally worded "the first by sort order". `holidays` has no `sort_order`, 8.6 offers no
    reordering, and every holiday resolves to the same `weekend_multipliers.holiday`, so which row
    wins decides only the displayed name — never an amount. A field only creation order could ever
    fill would have bought that name and a migration. The two consumers disagreed until block 5
    (the day sheet took Dexie's `.first()`, 6.7's planner built a map where the *last* row won);
    both now call one pure function.

### 7.10 Interface

54. Nothing is blocked. Every warning is passive and dismissible.
55. Every computed number can be traced to its inputs on the breakdown screen.
56. Every destructive action offers an undo affordance for several seconds. There are no confirmation
    modals except for reopening a closed period, for replacing data on import, and for leaving the day
    sheet with unsaved changes (8.2, agreed with the client after block 6).
57. Values on the day screen that differ from the day type's defaults are marked, so the user can see
    what is non-standard without remembering the template.
58. The app never shows a blank screen. An unhandled error renders a readable panel with the message
    and a reload button; on a phone with no debugger attached this is the only diagnostic channel.
59. Every screen is usable one-handed with the thumb. Primary actions sit in the lower half.

---

## 8. Screens

### 8.1 Calendar, home

Month grid, weeks starting Monday. Each cell shows the day type badge and the hours in small type.
Weekends and holidays are visually distinct.

Header: period name, arrows, tap for a month and year picker.

Above the bottom tab bar: amount and total hours in large type; above them, in small type, the
comparison with the previous period and the remaining hours to norm. Tapping expands the full
breakdown.

**Bottom tab bar, block 7.** Four tabs fixed to the bottom of the screen — Calendar, Period, Settings,
More — replacing the original plan of a settings icon in the calendar header, which had no room left
once the header carried the month picker and the period arrows. `TabBar` is rendered by each of the
four top-level screens themselves, not by a shared layout route: the test suite renders pages directly
in a `MemoryRouter`, and a nested layout route needs `createMemoryRouter`, which trips over
`AbortSignal` under jsdom on this Node version (invariant 58's flat `routes.tsx`, with an
`errorElement` per route, stays as-is for the same reason). The two internal screens that render
inside the bottom sheet or push a full screen (day types, holidays, past periods, export) do not show
the tab bar; they keep their own back button.

### 8.2 Day entry

Opens from a tap on a day as a bottom sheet.

A horizontal row of large circles, one per day type, coloured with its badge. A tap applies the type
with all its defaults. A second tap on the same type clears the entry. The last item is a plus that
leads directly into day type creation: types are most often needed at the moment one is missing.

Once a type is chosen:

- start and end times if the type defines them, otherwise a duration field. A break and how much of it
  is paid (6.1) sit alongside the times
- hours, always visible and always editable by typing — there is no stepper next to it, only the field
  itself (see the deviation below). Editing it by hand sets `duration_is_manual` and marks the link to
  the times as broken, with a button to restore. The total shift time (including the break) is shown
  next to it, purely for reading — it is never itself an input
- a value that differs from what selecting this day type would give right now is marked, per
  invariant 57
- multiplier and rate, linked as in the type form, labelled with the source: "Sunday", "from day type",
  "manual"
- the day's amount, large, recomputed live
- a toggle for entering the amount by hand
- a note

**Deviation.** The hours field no longer has ±0.5 stepper buttons next to it — removed at the client's
request. The field itself stays as freely editable as every other field in the app (requirement 4):
only the two buttons are gone, not the ability to type a number directly.

**Deviation, agreed with the client after block 6.** The entry reaches the database only when the
**Save** button is pressed, not on every field change. Two consequences follow, both accepted
deliberately:

- Choosing a day type no longer creates a row. Until Save is pressed the day holds a draft that exists
  only on screen, and Delete appears only once a row exists.
- Closing the sheet, starting another entry for the day, or switching between the day's entries with
  unsaved changes asks first: **Save changes** or **Do not save**. A tap outside the dialog keeps the
  user in the day and keeps what they typed — a stray tap must not cost a shift.

This is the **third** confirmation dialog in the app where invariant 56 allowed two. The exception is
recorded rather than silently taken: the button introduces the only way to lose typed input that
exists anywhere in this app, and on a phone tested through screenshots a silent loss surfaces weeks
later, if at all.

### 8.3 Period summary

Line by line: date, hours, rate, multiplier, amount. Total at the bottom. The period's base rate and
hours norm are edited here, not in settings. Also here: the extra amount field and the close period
button.

**Block 7.** Reachable two ways now: as the **Period** tab (showing the period of today's date, no
back button — there is nowhere to go back to) and, as before, by tapping the calendar's summary panel
for a specific month (with a back button, and `?year=&month=` in the address). Which one is in play is
told apart by the query parameters, not by a flag: their absence means "opened as a tab".

### 8.4 Settings

Only what is not period-specific: base rate and norm **for new periods**, period start day and naming,
default hours and the total-hours basis, show-shift-times default, currency, theme, reminders, and
links to day types and to holidays (weekend/holiday multipliers). Export/restore and past periods live
on the **More** tab only — Settings holds rules, More holds data and app info.

A specific period's base rate is edited on its own summary screen. Editing it in settings would leave
ambiguous which month is meant and would visually contradict period isolation even where the code
respects it. A note under the new-period fields and a link to the current period's own rate say this
explicitly, so a rate change is not mistaken for something that recalculates already-created months.

**Deviation, block 5.** The three weekend/holiday multipliers ship on the holidays screen (8.6), not
here. Nothing in the app could set them before block 7, and a holiday whose multiplier is fixed at 1
changes no money at all: block 5 would have added a screen listing dates and nothing else. 8.6 is also
where the user is already thinking about them. Block 7 links to that screen rather than duplicating
the fields.

**Period start day is locked while a closed period exists** (5.4.1, invariant 4), with the reason shown
inline and a link to the list of periods. Unlocked, changing it warns that days will move into
different months before the change is written — there is no confirmation dialog (invariant 56), the
warning is simply always visible next to the field while it is editable.

### 8.4.1 More

The fourth tab, added in block 7: data and app info, as opposed to Settings' rules. Past periods and
export/restore live here — and here only, after an early duplicate entry point on the period summary
screen was removed for having two places to find the same thing — plus an About section with the build
version and hash shown large and selectable, since remote testing
(12) identifies a build from a screenshot of exactly this line. The space reserved here in block 7 is now the account: one line of state in
plain words (the signed-in address, "not signed in", or "this build has no cloud") and an entry to the
account screen.

**Account screen (8.4.2).** Signed out: e-mail and password, sign in and create account, sign in with
Google, and the error next to the fields or the button — never a modal (invariants 54 and 58). The
Google button is present only in a build that has the cloud variables; without them the screen says the
build has no cloud and offers no sign-in at all (invariant 39). A Google attempt that ends in a refusal
— the consent screen cancelled, or a return that could not be completed — leaves its explanation under
the button in Russian; the provider's own English message never reaches the screen. Signed in: the address, when the last sync
happened or what went wrong, sync now, and sign out with a line saying plainly that nothing is deleted
from the phone. Two more states live on the same screen: the first-sign-in question (both sides shown
as counts, two modes, nothing preselected) and the different-account warning, which lists what would be
erased as numbers, offers to save a file first, and needs a read-and-confirm checkbox before the erase
button becomes usable. Primary actions sit in the lower half throughout (invariant 59).

### 8.5 Day types

A reorderable list, swipe to archive, with a collapsed Archive section beneath. Each row shows the
badge, the name, and the rate **in the context of the current period** together with the multiplier.
Pinned types carry a lock icon, which distinguishes "60 zł/h because ×2 of thirty" from "60 zł/h
because we said so".

The create button opens the same form as editing, with sensible defaults: multiplier 1, no times,
hourly pay, counted as work and toward norm.

### 8.6 Holidays

Grouped by year. Add and delete. Deletion is soft, with an undo bar.

At the top, the three weekend and holiday multipliers from 8.4, with a line saying what they do *not*
do: existing entries are never recalculated (invariant 51), only what is proposed for new ones.

Reached from the day sheet, next to the multiplier: a holiday date shows its name and leads to the
list; any other date offers to mark it, opening the add form with that date filled in. Both carry a
`return` parameter back to the day, as the day type plus does. Nothing else navigates below
`/settings` until block 7.

### 8.7 Past periods

Manual historical entry: pick a month, type hours and amount, save as a closed period. No day entries
are created.

### 8.8 Export and restore

Save everything to one JSON file, and load such a file back. A backup with no restore path is
pointless, and section 12 relies on this one for protection against iOS clearing storage.

---

## 9. Flexibility and validation

Requirement 4 is implemented as follows.

- **No field blocks saving.** 26 hours in a day, negative amounts, a zero rate, several entries on one
  date, holiday leave on a Sunday — all allowed.
- **Warnings instead of errors.** A grey line reading "more than 24 hours, is that right?" which can be
  ignored. No red borders, no modal dialogs.
- **Every computed value is overridable.** Duration, rate, multiplier, the day's amount, the period
  total.
- **Predictability comes from transparency, not prohibition.** The summary always shows what the number
  is made of, line by line.
- **Nothing disappears instantly.** Deletion shows an undo bar for several seconds.

---

## 10. Out of scope

- Taxes, ZUS, net pay
- Statutory holiday pay computed from average earnings
- Planning future schedules, rotations, week templates
- Multiple jobs in the UI
- SuperShift import, `.ics` parsing, EventKit — unavailable to a PWA by design
- Widgets, Apple Watch, App Store distribution
- Sharing, multi-user access

---

## 11. Work plan

Blocks are ordered so any of them can be the last one without breaking what came before. Commit and
deploy after each.

**Block 0 — foundation.** Private repository, `.claude/settings.json` with denials for destructive
commands, `CLAUDE.md`, Vite + React + TS + Tailwind skeleton, `wrangler.jsonc`, PWA manifest and icons,
error boundary panel, deployment through Workers Builds.

**Block 1 — storage and calendar.** Dexie schema, month grid, period navigation, seeded day types.

**Block 2 — day entry and calculation.** The entry sheet, section 6 in full.

**Block 3 — periods and rates.** Period creation by copying, the rate change dialog, closing a period.

**Block 4 — day types.** The full editor, the multiplier and rate fields, the lock, archiving.

**Block 5 — holidays and automatic multipliers.**

**Block 6 — summary, export, restore, past periods.**

**Block 7 — settings.** Everything in 8.4.

**Block 8 — cloud.** Supabase schema, RLS, e-mail sign-in, two-way sync, local data migration, the
account screen.

**Block 8.1 — Google sign-in.** The second sign-in method promised in section 3, carved out of block 8
because the OAuth round trip leaves the app on iOS and its return is the most fragile point of the
cloud (section 4, 5.4.1).

**Block 9 — notifications and keep-alive.** Push subscription, the sender Worker, the cron ping.

**Device check.** The first install on the father's iPhone happens right after block 0, before the rest
of the work, so installation problems surface on an empty page rather than after a day of coding.

---

## 12. Risks

**iOS may clear local storage.** Home-screen apps are not formally subject to Safari's seven-day rule,
but Apple guarantees nothing. Mitigated by cloud backup and the export file. `navigator.storage.persist()`
is called but not relied upon; in Safari it may do nothing.

**Supabase pauses after a week of inactivity.** Data survives, the project needs a manual resume.
Mitigated by the keep-alive cron and by the app working fully offline.

**Notifications cannot be verified remotely.** They require installation to the home screen and an
explicit permission grant. The permission prompt appears once; iOS will not show it again, and it
resets only by deleting and reinstalling the icon. Do not request it before block 9.

**Testing happens through an intermediary.** The developer cannot see the screen or press a button.
Every fix cycle is bounded by how fast screenshots come back. The error panel from block 0 exists
precisely to make that cycle survivable.

**Service worker staleness.** With `autoUpdate` and correct cache headers, a relaunch picks up the new
version. Without them the app can pin itself to an old build indefinitely. A version number is shown in
settings so the installed build can be identified from a screenshot.
