# workers

One Cloudflare Worker, not two. It hosts the built app (`assets` in `wrangler.jsonc`) and carries the
block 9 cron jobs. Section 4 of [SPEC.md](../SPEC.md) decides this explicitly: on Cloudflare Pages a
cron would have required a second project, which is why hosting is Workers in the first place.

```text
index.ts      fetch (static assets) + scheduled (cron dispatch by expression)
keepalive.ts  the daily Supabase ping
env.ts        worker environment variables
runtime.ts    the few Cloudflare runtime types used here
```

## Cron

| Expression  | Task       | Why                                                                  |
| ----------- | ---------- | -------------------------------------------------------------------- |
| `17 3 * * *` | keep-alive | A free Supabase project pauses after a week without requests (SPEC 12) |

Cloudflare tells the handler which schedule fired by passing the expression itself, so the strings in
`wrangler.jsonc` and the constants in `index.ts` must match — a test asserts they do.

The reminder sender (hourly) is the remaining half of block 9 and is not built yet.

## Environment

Runtime variables of the Worker (`wrangler secret put`), never committed. These are **not** the
`VITE_SUPABASE_*` values: those are inlined into the bundle at build time and live in the Workers
Builds *build* environment, which the runtime never sees.

| Name                | Used by    | Notes                                              |
| ------------------- | ---------- | -------------------------------------------------- |
| `SUPABASE_URL`      | keep-alive | `https://<project>.supabase.co`                     |
| `SUPABASE_ANON_KEY` | keep-alive | anon is enough: the ping reads no row               |

With neither of them set the cron does nothing and says so, and the Worker still serves the app
(invariant 39).

## Tests

`workers/**/*.test.ts` run in the `workers` Vitest project (`vitest.workspace.ts`) under the **node**
environment, without the frontend's jsdom setup — the Worker has no `document` and no IndexedDB.
No test reaches the network: `fetch` is always passed in as an argument.

```bash
npx vitest run --project workers
```

## Deploy

`git push` to the production branch; Workers Builds runs the build and `wrangler deploy`. There is no
local deploy command (SPEC 4).
