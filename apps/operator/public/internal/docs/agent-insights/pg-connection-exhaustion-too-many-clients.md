# "sorry, too many clients already" — PG connection exhaustion under agent load
URL: /internal/docs/agent-insights/pg-connection-exhaustion-too-many-clients

When psu / dev:pg_* / the whole MCP surface fail with "sorry, too many clients already", PostgreSQL has hit max_connections. On a big box the cause is stock max_connections=100 + adaptive pool sizing (pgPoolMax up to ~52 PER org pool, ×2 pools, ×N operator processes). Fix is the host autodetector (resource-profile deriveDatabaseTuning), not a concurrency cap. Diagnose at the OS level because the DB tools are themselves locked out.

import { Aside } from '@astrojs/starlight/components';

## Symptom

Every DB-backed tool fails at once:

```
MCP error -32603: sorry, too many clients already
MCP error -32603: remaining connection slots are reserved for roles with the SUPERUSER attribute
psu: sorry, too many clients already
```

`papercusp-su`, `dev:pg_*`, the owner's psu, and most operator routes are all
locked out simultaneously. It tends to appear "when lots of agents run at once",
and a `:3070` restart only helps for a while. PostgreSQL has exhausted
`max_connections` — including the superuser-reserved slots.

You usually can't query PG to diagnose this — the diagnostic tools need a
connection too, and there are none. **Diagnose at the OS level.**

## Diagnose (OS level — the DB tools are down)

```bash
# How many TCP connections are pinned on PG, and which processes hold them?
ss -tn state established '( dport = :5432 )' | wc -l
ss -tnp state established '( dport = :5432 )' \
  | grep -oP '"\w[^"]*",pid=\d+' | sort | uniq -c | sort -rn | head

# The ceiling + memory (stock defaults are the tell)
grep -iE '^\s*(max_connections|shared_buffers)' /etc/postgresql/18/main/postgresql.conf

# Superuser can still get in via reserved slots (until those are gone too):
sudo -n -u postgres psql -p 5432 -tAc \
  "select count(*), (select setting from pg_settings where name='max_connections') from pg_stat_activity;"
```

A connect **storm** (not a steady trickle) shows as a big accept-backlog on the
listen socket: `ss -ltn | grep :5432` → `Recv-Q` near `Send-Q`.

## Root cause (the arithmetic, on a big box)

Two compounding facts:

1. **Stock `max_connections = 100`** (and `shared_buffers = 128MB`) — the
   PostgreSQL defaults, sized for a laptop, never raised. On a 128-core / 252 GiB
   box that is a laptop-sized ceiling and 0.05%-of-RAM buffer cache.
2. **Adaptive pool sizing applied without raising the ceiling.** The app sizes
   each org pool via `resolveOrgPoolMax()` → `getResourceProfile().pgPoolMax`
   (`libs/papercusp/libs/db/src/connection.ts`, `resolveOrgPoolMax`). On this host
   that derives to **52**, and there are **two** org pools (`getOrgPg` admin +
   `getOrgPgApp` app/RLS) → **up to \~104 connections from a single operator
   process**, before per-harness pools, the admin-pg-cache (8), the 5 LISTEN
   connections, and su-lock (in DB `papercusp_su` but on the **same instance**, so
   it counts vs the server-wide cap). With ≥2 operator processes (`:3070` release +
   `:3170` staging) you blow past 100 instantly. (`resolveOrgPoolMax` now ALSO
   applies `boundedOrgPoolMax` — see the structural-hardening bullet below — so a
   fixed/patched install no longer reproduces this arithmetic; this section
   describes the root-cause scenario the fix was built for.)

This is the regression trap from `operator-scalability-event-loop-2026-06-16`:
P4-3 (size the pool from `resource-profile`) shipped in code while its
prerequisite P4-2 (raise the ceiling / front a pooler) did not. The pool grew to
fit the beast; the DB ceiling stayed at the laptop default.

Note: **spawned agents do not open their own PG connections** — they call the
operator over HTTP/MCP and the operator owns the pools
(`packages/agent-mcp/src/server.ts:104` → `withWorkspace` → `getOrgPgApp`). So the
operator is the multiplexing point; the fix is at the server, not per-agent.

## Fix — autodetect the limits from the host (do NOT hardcode, do NOT cap concurrency)

The server knobs are derived from detected cores/RAM in one place —
`deriveDatabaseTuning()` / `databaseTuningToSettings()` in
`libs/generic/resource-profile/src/index.ts` (exposed as
`ResourceProfile.database`). Two apply arms:

* **Native PG** (dev box / dedicated server):
  ```bash
  npx tsx scripts/pg-autotune.ts            # --print: show derived settings, change nothing
  npx tsx scripts/pg-autotune.ts --apply    # write conf.d drop-in + restart PG + verify (auto-rollback)
  ```
  It writes `/etc/postgresql/<v>/main/conf.d/10-papercusp-autotune.conf` and
  restarts. On this box that takes `max_connections` **100 → 512** and
  `shared_buffers` **128MB → 64GB**. Delete the drop-in + restart to revert.
* **Embedded PG** (the shipped desktop): `apps/operator/bin/serve.ts` passes
  `databaseTuningToSettings(deriveDatabaseTuning(detectResourceSignals({ embeddedPg: true })))` to
  `startEmbeddedPostgresServer({ extraPostgresSettings })`, which merges them into
  the postmaster `-c` flags — autoadjusts at boot, no config. (`detectResourceSignals`
  now sits between the two calls — it probes the actual cores/RAM signals that
  `deriveDatabaseTuning` sizes the settings from, rather than `deriveDatabaseTuning`
  probing them itself.)

Raising the ceiling is the immediate relief and is *correct for the hardware* —
not a band-aid. The structural hardening shipped in plan
`backend-connection-scaling-2026-06-17`:

* **`boundedOrgPoolMax`** (resource-profile) caps the org pools so `(2 pools × N
  operator processes) + overhead` can't exceed the ceiling — the guard the
  regression lacked; CI-asserted across 126 host shapes.
* **PgBouncer** transaction-pooling for true thousands-of-agents multiplexing,
  gated `PAPERCUSP_PGBOUNCER` (LISTEN connections bypass — session-bound).
* **Per-transaction `search_path`** via `withWorkspace` + `withHarnessSchema` /
  `harnessQuery`, so pooling never resolves the wrong schema.
* **Connection-pressure watch** (periodic-workflows) warns past 85% saturation
  with the top `application_name` holders — the early signal this outage lacked.

Validated end-to-end: **300 concurrent callers → 5 backends, 0 rejected** (the
bounded pool queues the excess instead of exhausting PG).

## A SECOND exhaustion class (2026-07-10, WI-3816): the ClientWrite zombie

Raising the ceiling and bounding the pools (above) fixes exhaustion from too many
*legitimate* connections. There is a structurally different way to run out of
slots even with a correctly-sized, bounded pool: a backend whose **query already
completed** but whose **client is gone / not reading** (a dead network peer, a
killed agent process, a stalled MCP transport) is not the same as a hung query —
`pg_cancel_backend` does nothing to it (there is no in-flight query to cancel),
so it sits at `ClientWrite` in `pg_stat_activity` and **holds its pool slot
forever**, until an operator manually `pg_terminate_backend`s it. This was the
root cause of a **4-hour fleet-wide MCP-timeout outage** (the aftermath of
WI-3792): the pool wasn't oversubscribed by count, it was full of zombies.

The fix (`buildConnectionOptions` / `buildClient` in
`libs/papercusp/libs/db/src/connection.ts`) sets **`client_connection_check_interval`**
(default 30s, `PAPERCUSP_DB_CLIENT_CHECK_INTERVAL`-overridable, seconds) on every
non-pooled connection — a `PGC_USERSET` GUC settable as a libpq startup param (no
`postgresql.conf` edit needed), which makes the backend **itself** poll its socket
and notice/abort when the client is gone, instead of waiting for an operator to
find and kill it by hand. It defaults to **off (0)** on every stock PG install
(embedded or native), so it must be set explicitly — this incident is exactly why.
Alongside it, the same non-pooled path now tightens the OS-level TCP keepalive
probe (`tcp_keepalives_idle=30`, `_interval=10`, `_count=3`) so a **network-level**
dead peer (not just an app-level unresponsive one) is caught quickly too — PG's own
default keepalive idle time (2h) is far too slow to matter for this failure mode.

**Diagnostic signal to add to the OS-level checklist above:** a `pg_stat_activity`
row stuck in `state = 'idle'` / `wait_event_type = 'Client'` (or `ClientWrite`) for
an implausibly long time, with **no corresponding live TCP peer** in the `ss -tnp`
output from the diagnose section, is this class — not a hung query, not a raw
count-exhaustion. `pg_terminate_backend(pid)` on that pid recovers the slot
immediately if you're mid-outage on an unpatched install.

## Gotcha — don't write a plan as a raw file during the outage

While PG is down the `plans:*` tools fail too. If you write a plan `.md` straight
to `apps/operator/docs/plans/` to work around that, it is an **orphan** (not
registered in the PG plans table) and a plans reconciler **deletes it** once PG
recovers. Code files survive (git-sync commits them); unregistered plan files do
not. Re-create the plan via `plans:new` + `plans:set-content-chunk` once the DB is
back — and note `set-content` content must include the YAML frontmatter or commit
fails with `would_orphan_frontmatter`.
