# Papercusp memory-footprint audit — 24 September 2026

> Owner directive #440: "audit our papercusp app. How can we bring down the
> memory usage without hurting the functionality." This is a **RAM/footprint**
> audit — the complement to the 2026-09-23 *latency* audit
> (`application-performance-audit-2026-09-23.md`, F1–F12), which did not cover
> resident memory. Author: su-2d61b (tool-disconnected session — findings are
> from `ps`/`/proc`/`free`/code inspection; the MCP coordination layer was
> unavailable, so nothing here was cross-checked against live plan/order state —
> re-confirm ownership before acting).

## Verdict

Memory is dominated by **process and connection SPRAWL**, not by a single leak.
For **8 live agents** the box is carrying **204 `claude` processes (26.9 GB
PSS)**, **94 `node` processes (16.3 GB PSS)**, and **466 postgres backends (174
on the app DB, 163 of them idle)**. The system has 251 GB RAM with 88 GB
available but **is actively swapping (348 GB of swap in use)** — i.e. real,
episodic pressure. The largest *safe* wins are reaping dead/parked fleet
processes and idle DB connections; both are transparent to functionality by
definition (they serve no traffic).

## Measurement method + the RSS trap (read this first)

**Do not audit this from `ps` RSS.** A naive `ps -eo rss --sort=-rss` reports
~1.3 TB for postgres — this is an **artifact of shared-memory double-counting**:
every backend's RSS includes the shared_buffers pages it has touched, so the
shared segment is counted once per backend. The real shared segment is **~39 GB**
(`free -g` → `shared`), counted physically once.

Authoritative figures below use **PSS** (proportional set size, from
`/proc/<pid>/smaps_rollup`), which splits shared pages across sharers. Caveat:
postgres runs as the `postgres` user, so this session could not read its
`smaps_rollup` — **postgres real unique memory is UNMEASURED here** and the
biggest open probe (see M2/M3).

Snapshot (`free -g`): total 251 · used 163 · free 40 · buff/cache 95 · available
88 · **swap used 348**.

| family | PSS (real, GB) | procs | note |
|---|---|---|---|
| claude | 26.9 | 204 | agent fleet + subprocesses — for 8 live agents |
| node | 16.3 | 94 | operator sidecars + node children |
| code (VS Code) | 10.7 | 50 | dev tooling, not the app |
| chrome | 3.6 | 103 | dev, not the app |
| postgres | *unreadable* (shared ≈39 GB + Σ private) | 466 | different OS user; needs a postgres-side probe |

## Findings (prioritized by safe reclaimable memory)

### M1 — Fleet process sprawl: 204 `claude` + 94 `node` procs for 8 live agents  [OBSERVED]
Roster at audit time: 155 agents (8 live, 27 parked, 26 ended, 116 recorded),
yet 204 `claude` (26.9 GB PSS) + 94 `node` (16.3 GB PSS) processes are resident.
Ended/recorded agents and warm-dead loops leave processes holding RSS long after
they stop taking turns — consistent with the fleet's known lingering-process
class (coord feed cited **WI-6639**: armed loops producing no turn for 37–158 h;
auto-disarm exists but reaps the *loop*, not necessarily the *process*).
- **Reclaim (safe):** reap the OS processes of ended/recorded/warm-dead agents;
  a session whose `sessionState` is `ended`/`recorded` should own no live PID.
  This is transparent — those agents are not working.
- **Probe before acting:** `processes:list { live:true }` (per-agent confinement
  + cgroup) vs `coord:presence` live set; for each `claude`/`node` PID map to a
  coord owner and confirm `sessionState` before `kill`. Do NOT blanket-kill by
  name (subprocess trees, the operator itself).
- **Est. impact:** the single largest *measurable* lever — a large fraction of
  the 43 GB (claude+node) PSS is attributable to non-live agents.

### M2 — Idle Postgres connection sprawl: 163 idle backends (of 174), oldest idle ~33 h  [OBSERVED]
174 app backends (`harness_admin papercusp`), **163 idle**, only 11 active; 167
distinct client ports (≈ pool connections); oldest idle backend ~119,000 s
(~33 h). Each idle backend holds private memory (relcache/catcache, prepared
statements, any peak `work_mem` not released) on top of the shared segment.
- **Reclaim (safe):** add/verify an **idle-connection reaper** (release pooled
  connections idle > N min; postgres-side `idle_session_timeout`). Idle
  connections re-establish on demand — transparent to functionality. Verify the
  existing `pool·procs ≤ max_connections` machinery (`cluster-fork.ts`,
  `apps/operator/bin/hono-host.ts`, `scripts/pg-autotune.ts`) actually bounds the
  *live* total and that per-process pool `max` isn't over-provisioned for parked
  agents.
- **Probe:** `SHOW max_connections` on the app PG; `SELECT state, count(*),
  max(now()-state_change) FROM pg_stat_activity GROUP BY state`; per-backend
  private via `pg_backend_memory_contexts`. `[inferred]` that private-per-idle is
  ~10–40 MB → ~2–6 GB reclaimable; confirm with the query above.

### M3 — Postgres shared segment (~39 GB) may exceed the working set  [INFERRED — needs probe]
The ~18 GB per-backend RSS *floor* and `free`'s `shared:39` indicate the app's
own host-tuned PG (NOT the system `/etc/postgresql/18/main` cluster, which is the
default 128 MB / max_connections=100) runs a **large shared_buffers**, derived
from host RAM by `apps/operator/bin/serve.ts` (host-tuning: max_connections /
shared_buffers / effective_cache_size from detected cores/RAM). The live DB
working set is modest — largest tables `substrate_outbox` 5.6 GB,
`route_invocations` 2.9 GB, `tool_invocations` 1.4 GB; whole DB on the order of
~15 GB.
- **Reclaim (one-time, shared):** if shared_buffers ≫ working set, cap it at a
  fraction of *actual DB size* rather than host RAM. This is shared memory
  (recovered once, not ×backends), but at ~39 GB it is a large single lever.
- **Probe:** `scripts/pg-autotune.ts` prints live `shared_buffers` /
  `max_connections`; compare to `pg_database_size('papercusp')` and buffer-cache
  hit ratio before trimming (don't starve the cache). `[inferred]`, unverified —
  do not change blind.

### M4 — High-churn tables inflate cache + backend temp pressure  [OBSERVED]
`route_invocations` 2.9 GB / **13.5 M rows**, `tool_invocations` 1.4 GB / 2.2 M
rows, `substrate_outbox` 5.6 GB / 36 k rows (≈150 KB/row — large payloads or
bloat). High-churn append tables enlarge the hot set and per-backend temp/sort
memory.
- **Reclaim (safe):** time-based **retention/pruning** on the log/outbox tables
  (these are append-heavy telemetry/outbox, not durable domain state); `VACUUM
  (FULL/repack)` `substrate_outbox` if the row-size implies bloat. Standard for
  telemetry tables; confirm no consumer needs the full history first.
- **Probe:** `SELECT n_dead_tup, n_live_tup FROM pg_stat_user_tables` for bloat;
  confirm outbox drain is keeping up (36 k rows suggests a backlog, tie to the
  latency audit's background-failure findings).

### M5 — Gym-loop throwaway PG provisions `max_connections=500`  [OBSERVED]
`serve.mjs` gym-loop launches its provisioned container with
`postgres -c max_connections=500` while its own pools are `max:4`/`max:2`. High
ceiling reserves per-connection resources needlessly. Minor (throwaway, only
during gym runs) — lower to the actual pool need. Low priority.

## Recommended execution order (safe → higher-verification)

1. **M1** reap non-live fleet processes (biggest measurable reclaim, zero
   functional risk) — but via the process/coord mapping, never blanket kill.
2. **M2** idle-connection reaping + verify pool bounds (transparent).
3. **M4** retention on `route_invocations` / `tool_invocations` / drain
   `substrate_outbox` (confirm no consumer needs full history).
4. **M3** re-tune shared_buffers to working set (measure hit-ratio first; largest
   single lever but needs care not to starve cache).
5. **M5** lower gym provision `max_connections`.

## Open probes (this session could not run them — MCP + postgres-user access absent)
- postgres real PSS: `sudo -u postgres` read of `/proc/<backend>/smaps_rollup`,
  or `pg_backend_memory_contexts` — M2/M3 depend on it.
- `SHOW shared_buffers/max_connections` on the **app** PG (not the 18/main
  system cluster) — M3.
- `pg_stat_activity` state histogram + idle age — M2.
- `processes:list` vs `coord:presence` live set to size the M1 reclaim.

## Provenance
Measured facts (`ps`, `/proc/*/smaps_rollup`, `free`, table sizes from an earlier
`pg_table_sizes` read) are `[OBSERVED]`. Mechanisms not directly measured
(shared_buffers value, per-backend private size, bloat) are tagged `[INFERRED]`
with their probe — re-run the probe before filing or acting, per the technical-
claim provenance discipline. RSS figures are explicitly NOT used as memory
evidence (shared-segment double-counting).
