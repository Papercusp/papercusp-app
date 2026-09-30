# The orchestrator worker subprocess reads PAPERCUSP_DATABASE_URL — pin it or it hits the wrong DB
URL: /internal/docs/agent-insights/orchestrator-pg-bootstrap-dsn

The orchestrator's pg-bootstrap.defaultDsn resolves PAPERCUSP_DATABASE_URL > ~/.papercusp/embedded-pg.json > hardcoded :5432/papercusp — it does NOT read DATABASE_URL/HARNESS_ADMIN_DATABASE_URL. A spawned invoke-once worker pointed at a non-:5432 DB (e.g. the harness gym) silently connects to the live dev DB → UPDATE harness_features 42P01. SHOW search_path is a false reassurance.

import { Aside } from '@astrojs/starlight/components';

## TL;DR

When you spawn the orchestrator (`invoke-once` → `bootstrapOrchestratorPg`) against a
database that is **not** the dev box's native `localhost:5432/papercusp`, you must set
**`PAPERCUSP_DATABASE_URL`** in the spawned process's env. The orchestrator's
`pg-bootstrap.defaultDsn()` (`libs/papercusp/packages/orchestrator/src/pg-bootstrap.ts`)
resolves its DSN as:

```
PAPERCUSP_DATABASE_URL  >  ~/.papercusp/embedded-pg.json  >  hardcoded localhost:5432/papercusp
```

It **does not read `DATABASE_URL` or `HARNESS_ADMIN_DATABASE_URL`** — the keys
`getHarnessAdminUrl()` (the operator-side resolver) consults. So pinning only those two
leaves the worker subprocess to fall through to `embedded-pg.json` or the hardcoded
`:5432/papercusp` — i.e. the **live dev DB**.

The worker throws `relation "harness_features" does not exist` (`42P01`,
`routine=parserOpenTable`) on an `UPDATE harness_features …` — even though the
per-harness `harness_<slug>.harness_features` view exists and the bootstrap log shows
`search_path=harness_<slug>,harness_shared,public`. The view exists *in your DB*; the
worker is looking *in a different DB* where that per-harness schema was never created.

## Why `SHOW search_path` lies to you

`pg-bootstrap` verifies the connection with `SHOW search_path` and logs it looking
correct. **This is a false reassurance.** Postgres happily accepts a `search_path` that
names a schema which does not exist in the connected database — it just silently skips
the missing entry during name resolution. So a log line reading
`search_path=harness_gymXXX,harness_shared,public` proves only that the *string* was
set, **not** that `harness_gymXXX` exists on that connection's database. Don't trust the
search\_path log to tell you which DB you're on; check `current_database()` /
`to_regclass('harness_features')` instead.

## Why the live fleet never hit this

Live harnesses live **in** `localhost:5432/papercusp` — which is exactly
`defaultDsn()`'s hardcoded fallback. So the divergence (ignoring `DATABASE_URL`) was
latent: every live worker fell through to the fallback and landed in the right DB by
coincidence. The **harness gym** (`packages/operator-core/lib/gym/`) is the first caller whose
target DB is a *separate* database (a dedicated gym PG, per D-018), so it was the first
to connect to the wrong DB and surface the bug.

## The fix

Two complementary, live-safe fixes (commit `7eb79a46d`):

1. **Pin it where you build the boot env.** The gym's `boot-spec.ts` now sets all three
   DSN keys to the gym DB:
   ```ts
   DATABASE_URL: cfg.gymDatabaseUrl,            // getHarnessAdminUrl() (operator side)
   HARNESS_ADMIN_DATABASE_URL: cfg.gymDatabaseUrl,
   PAPERCUSP_DATABASE_URL: cfg.gymDatabaseUrl,  // pg-bootstrap (worker subprocess)
   ```
2. **Make the spawn helper mirror the resolved DSN.** `buildInvokeOnce`
   (`packages/operator-core/lib/harness-invoke-once.ts`) already set `DATABASE_URL` "so the agent
   hits the SAME Postgres the operator uses" — but `pg-bootstrap` doesn't read
   `DATABASE_URL`. It now also sets:
   ```ts
   PAPERCUSP_DATABASE_URL:
     process.env.PAPERCUSP_DATABASE_URL || process.env.DATABASE_URL || getHarnessAdminUrl(),
   ```
   For the live fleet this equals `DATABASE_URL` (= the DB the fallback already resolved
   to), so it's a no-op there; for any caller whose DB ≠ `:5432/papercusp` it closes the
   gap.

Any time you spawn `invoke-once` (or otherwise boot the orchestrator's `pg-bootstrap`)
against a database other than the dev box's native `:5432/papercusp`, set
`PAPERCUSP_DATABASE_URL`. Setting `DATABASE_URL` alone is **not** sufficient — that var
feeds `spawn-mcp` (the signed MCP URL), not the orchestrator's state connection.

## A THIRD DSN var: `HARNESS_DATABASE_URL` (the org-pg APP resolver)

As of 2026-07-02 (`gym-unwedge-scout-novelty-2026-07-02`, GYM-1 layer-2), pinning
`DATABASE_URL`/`HARNESS_ADMIN_DATABASE_URL`/`PAPERCUSP_DATABASE_URL` is **still not enough**
for a hermetic gym operator: `libs/db`'s `connection.ts` app-pool resolver
(`resolveAppUrl` — see `libs/papercusp/libs/db/src/connection.ts`) consults
**`HARNESS_DATABASE_URL` first and never falls back to `DATABASE_URL`**. Left unpinned, every
`getOrgPg()` consumer (the org-pg app connection, distinct from the admin/orchestrator
connections the rest of this doc covers) fell through to the hardcoded
`harness_app:harness_app_pwd@localhost:5432` default and hit the **live native PG** with the
wrong credentials — `password authentication failed` on boot. This was the real error behind a
12-day `gym-cycle:error` streak (masked by a detail-dropping recorder, fixed alongside it).
`buildGymOperatorBootSpec` (`packages/operator-core/lib/gym/boot-spec.ts`) now also pins
`HARNESS_DATABASE_URL: cfg.gymDatabaseUrl` — a **fourth** DSN key alongside the three above, not a
replacement for any of them. **Rule of thumb, extended:** when hermetically sandboxing an
orchestrator/gym boot, pin all four — `DATABASE_URL`, `HARNESS_ADMIN_DATABASE_URL`,
`PAPERCUSP_DATABASE_URL`, **and** `HARNESS_DATABASE_URL` — each is read by a different resolver
with its own fallback chain, and any one left unpinned falls through to a live-DB default.

The same GYM-1 pass also found two adjacent hermeticity leaks worth knowing about even though
they aren't DSN vars: `PAPERCUSP_PGBOUNCER` (`maybePgbouncer()` defaults pooling ON for
server-class hosts and silently rewrites even a correctly-pinned DSN's host to the live `:6432`
pooler — pin `PAPERCUSP_PGBOUNCER: '0'` to force the hermetic sandbox to dial its container
directly) and `PAPERCUSP_MCP_PROXY_BASE` (leaks through the `...process.env` spread from the
spawning bg-host and out-ranks the spawning process's own port when the orchestrator signs a
child's `.mcp.json` URL, pointing every gym eval agent at the **live** `:3070` operator instead
of the hermetic one — blank it explicitly).

## How it was isolated

A reproduction in `packages/operator-core/lib/gym/smoke.ts` built a client with the *exact* `pg-bootstrap`
config (`postgres(gymUri, { max: 4, connection: { search_path } })`) and fired 8
concurrent probes (`current_setting('search_path')` + `to_regclass('harness_features')`

* `pg_backend_pid()`). All 8, across 4 distinct backends, resolved the view and the
  `UPDATE` executed — proving the connection config and the view were fine, and isolating
  the failure to the worker connecting to a **different database**. The decisive signal
  was that the *config* worked against the gym DB while the *worker* (resolving its own
  DSN) did not.
