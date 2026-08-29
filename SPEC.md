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

**Cloud.** Supabase Postgres. Schema mirrors the local one. Sync is background and non-blocking. Row
Level Security on every table, policies keyed on `auth.uid() = user_id`. Conflict resolution is
last-write-wins on `updated_at`.

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
first launch. On first sign-in every local row is rewritten to the real `user_id` and pushed. If the
cloud already holds data for that account, the user is asked which side to keep. Silent merging is
forbidden.

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
- `default_start`, `default_end` — minutes from midnight, either may be null
- `default_break_minutes`
- `default_duration_minutes` — used by types without times

Precedence: if both `default_start` and `default_end` are set, duration derives from them and
`default_duration_minutes` is ignored. If times are absent, `default_duration_minutes` is used. If that
is absent too, `settings.default_hours` applies.

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
- `start_minutes`, `end_minutes`, `break_minutes` — nullable
- `duration_minutes` — final duration
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
- **Field names.** `day_types` stores `default_multiplier` for 5.3's `multiplier`, `default_rate`
  for `pinned_rate`, and `ignore_auto_multipliers` for the inverse of `allow_auto_multipliers`. The
  UI wording follows this document ("allow"); only the stored key is inverted. `rate_mode` decides
  whether `default_rate` is used — a value left in the field does not by itself pin the type.
- **Day type default times are not implemented.** 5.3's `default_start`, `default_end`,
  `default_break_minutes` and `default_duration_minutes` do not exist; `default_hours` covers the
  working path. 6.1's derivation of duration from start and end (and invariants 28 and 30) is not
  implemented either, so a default time on a type would drive nothing. Deferred together with it.

### 5.5 `holidays`

- `date`, `name`, `is_custom`

Polish public holidays are seeded and fully editable: delete what does not apply, add company days off.

### 5.6 `push_subscriptions`

- `endpoint`, `keys`, `device_label`, `last_seen_at`

Cloud only. Never part of an export file.

---

## 6. Calculation

### 6.1 Duration

```
if duration_is_manual:
    duration = duration_minutes
else if start and end are set:
    raw = end − start
    if raw <= 0: raw += 24 h          // shift crosses midnight
    duration = raw − break_minutes
else:
    duration = day_type.default_duration_minutes
               or settings.default_hours
```

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
amount        = Σ entry amounts + extra_amount
total hours   = Σ durations where day_type.counts_as_work
norm hours    = Σ durations where day_type.counts_toward_norm
remaining     = norm_hours − norm hours
```

For periods with `is_manual = true` no summation occurs; totals come straight from `closed_totals`.

Closing a period writes totals into `closed_totals`. After that, no change to settings, rules or rates
affects it.

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
53. Two holidays on the same date are allowed; the first by sort order supplies the multiplier.

### 7.10 Interface

54. Nothing is blocked. Every warning is passive and dismissible.
55. Every computed number can be traced to its inputs on the breakdown screen.
56. Every destructive action offers an undo affordance for several seconds. There are no confirmation
    modals except for reopening a closed period and for replacing data on import.
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

Fixed bottom bar: amount and total hours in large type; above them, in small type, the comparison with
the previous period and the remaining hours to norm. Tapping expands the full breakdown.

### 8.2 Day entry

Opens from a tap on a day as a bottom sheet.

A horizontal row of large circles, one per day type, coloured with its badge. A tap applies the type
with all its defaults. A second tap on the same type clears the entry. The last item is a plus that
leads directly into day type creation: types are most often needed at the moment one is missing.

Once a type is chosen:

- start and end times if the type defines them, otherwise a duration field
- duration, always visible. Editing it by hand sets `duration_is_manual` and marks the link to the
  times as broken, with a button to restore
- multiplier and rate, linked as in the type form, labelled with the source: "Sunday", "from day type",
  "manual"
- the day's amount, large, recomputed live
- a toggle for entering the amount by hand
- a note

### 8.3 Period summary

Line by line: date, hours, rate, multiplier, amount. Total at the bottom. The period's base rate and
hours norm are edited here, not in settings. Also here: the extra amount field and the close period
button.

### 8.4 Settings

Only what is not period-specific: base rate and norm **for new periods**, weekend and holiday
multipliers, period start day, currency, theme, default hours, reminders, export and import, account.

A specific period's base rate is edited on its own summary screen. Editing it in settings would leave
ambiguous which month is meant and would visually contradict period isolation even where the code
respects it.

### 8.5 Day types

A reorderable list, swipe to archive, with a collapsed Archive section beneath. Each row shows the
badge, the name, and the rate **in the context of the current period** together with the multiplier.
Pinned types carry a lock icon, which distinguishes "60 zł/h because ×2 of thirty" from "60 zł/h
because we said so".

The create button opens the same form as editing, with sensible defaults: multiplier 1, no times,
hourly pay, counted as work and toward norm.

### 8.6 Holidays

Grouped by year. Add and delete.

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

**Block 8 — cloud.** Supabase schema, RLS, email and Google sign-in, sync, local data migration.

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
