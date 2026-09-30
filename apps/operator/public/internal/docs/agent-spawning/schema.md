# Schema
URL: /internal/docs/agent-spawning/schema

The two PG tables that back the spawn primitive — `spawned_agents` (the durable mirror) and `tool_invocations_spawn_tree` (the recursive lineage view).

## `harness_shared.spawned_agents` — baseline + supervision/durability/observability migrations

One row per spawn launch — the durable nursery. Written by the spawn engine (`recordSpawn` / `finishSpawn`); read by `fleet:tree`, the concurrency-ceiling count, and the Intel panel.

The table is defined in `000-baseline.sql`; `146-fleet-supervision.sql` added the supervision columns (`session_owner` … `cancelled_at`) and `174-spawned-agents-heartbeat-reclaim.sql` the durability `heartbeat_at`. Several **later migrations** keep extending it — `203` (`session_id`), `213` (a column-targeted change-notify trigger), `219` (`idempotency_key`), `228` (`pid` / `launcher_host`), `229` (`model_spec` / `model_tier`), `230` (`brief`), `233` (`last_output_at`), `339` (`launcher_boot_id`), `475` (`fleet_slug`) — so the live table is wider than the baseline. The full set of columns the engine reads is in `SELECT_COLS` (`pg-stores.ts`).

```sql
CREATE TABLE harness_shared.spawned_agents (
  -- baseline columns
  spawn_id              TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  harness_slug          TEXT NOT NULL,
  parent_spawn_id       TEXT NULL,
  parent_role           TEXT NOT NULL,
  child_role            TEXT NOT NULL,
  feature_id            TEXT NULL,
  chunk_id              TEXT NULL,
  run_id                TEXT NOT NULL,
  status                TEXT NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ NULL,
  duration_ms           BIGINT NULL,
  exit_code             INT NULL,
  output_tail           TEXT NULL,
  error_message         TEXT NULL,
  cancel_requested      BOOLEAN NOT NULL DEFAULT false,
  -- 146-fleet-supervision: structured-concurrency / supervision
  session_owner         TEXT NULL,          -- coord/lock owner (== spawn_id for fleet spawns)
  coordination_domain   TEXT NOT NULL DEFAULT 'default',
  plan_slug             TEXT NULL,
  item_id               TEXT NULL,
  restart_strategy      TEXT NOT NULL DEFAULT 'one_for_one',  -- one_for_one|one_for_all|rest_for_one
  restart_count         INT NOT NULL DEFAULT 0,
  restart_window_start  TIMESTAMPTZ NULL,
  cancel_reason         TEXT NULL,
  cancelled_at          TIMESTAMPTZ NULL,
  -- 174-spawned-agents-heartbeat-reclaim: orphan reclaim
  heartbeat_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- later migrations (ALTER TABLE ADD COLUMN, all NULL-able)
  session_id            TEXT NULL,          -- 203: native resume id for a CLAUDE cup (claude --resume)
  idempotency_key       TEXT NULL,          -- 219: caller key → (workspace_id, key) dedupes retried spawns
  pid                   INT NULL,           -- 228: child OS pid (reclaim /proc liveness)
  launcher_host         TEXT NULL,          -- 228: host that launched it (same-host liveness gate)
  model_spec            TEXT NULL,          -- 229: per-spawn resolved model spec, if overridden
  model_tier            TEXT NULL,          -- 229: tier the spec resolved from
  brief                 TEXT NULL,          -- 230: mug-authored situational brief (QUEEN_BRIEF)
  last_output_at        TIMESTAMPTZ NULL,   -- 233: last stdout/stderr the supervisor observed (wedge signal)
  launcher_boot_id      TEXT NULL,          -- 339: launcher's boot id — reclaim disambiguation across a host restart (a pid is not stable across reboot; EI-2186)
  fleet_slug            TEXT NULL           -- 475: named-fleet slug stamped at spawn → reliable per-fleet cup count (WI-1813)
);
```

### Status values

`running | restarting | done | failed | cancelled | reaped`

`running` and `restarting` are ACTIVE (counted against the concurrency ceiling); the rest are terminal. Orphaned active rows are reclaimed to `failed`; `reaped` is a legacy status no current path writes.

### Indexes

```sql
spawned_agents_parent_idx           -- (workspace_id, parent_spawn_id) — child enumeration + recursive joins
spawned_agents_recent_idx           -- (workspace_id, harness_slug, started_at DESC) — Intel panel feed
spawned_agents_running_idx          -- (workspace_id, status) WHERE status='running'
spawned_agents_session_owner_idx    -- (workspace_id, session_owner) — owner→spawn lookup for cancel/release (146)
spawned_agents_active_heartbeat_idx -- (heartbeat_at) WHERE status IN ('running','restarting') — orphan-reclaim sweep (174)
spawned_agents_session_id_idx       -- (session_id) WHERE session_id IS NOT NULL — native-resume lookup (203)
spawned_agents_idempotency_key_uq   -- UNIQUE (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL — spawn dedupe (219)
spawned_agents_fleet_slug_running_idx -- (workspace_id, fleet_slug) WHERE fleet_slug IS NOT NULL AND child_role='cup' AND status IN ('running','restarting') — deterministic per-fleet cup count (475)
```

A check constraint (`spawned_agents_restart_strategy_chk`, added by migration 146) restricts `restart_strategy` to `one_for_one | one_for_all | rest_for_one`.

:::note
`spawned_agents_running_idx` is partial on `WHERE status='running'` only — it predates the `restarting` active status (added by 146). The active-count query now matches `status IN ('running','restarting')` (`countRunning` / `openChildren`), so the partial index only *partially* covers it; the `restarting` slice falls back to a wider scan.
:::

### Change-notify trigger (migration 213)

`emit_change_notify_trg` fires the `sync_invalidate` NOTIFY the SSE bridge listens on, but it's **column-targeted on purpose**: `AFTER INSERT OR DELETE OR UPDATE OF status, exit_code, error_message, session_id`. A running cup takes a `heartbeat_at` write every minute; a bare row trigger would re-fire the joined sync queries on every beat. Scoping the UPDATE leg to the outcome columns the projection actually reads keeps invalidation volume at one-per-lifecycle-transition instead of one-per-heartbeat.

### RLS

Same workspace-scoped policy as every other `harness_shared` table — `spawned_agents_workspace_isolation`: reads/writes require the `app.workspace_id` GUC to match the row's `workspace_id` (`USING`/`WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`). The GUC is set **per transaction** by the dispatch/route layer (`set_config('app.workspace_id', $1, true)` — the `true` makes it transaction-local), not by the pooled client. `getOrgPg`'s connection only sets `search_path`, `idle_in_transaction_session_timeout`, and `application_name` at connect time.

### Lifecycle hooks on the row

| When                                                  | What                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `spawnAgentInHarness` records a spawn (`recordSpawn`) | `INSERT` with `status='running'`, `session_owner`, `coordination_domain`                |
| Background invoke resolves (`finishSpawn`)            | `UPDATE` with status (`done`/`failed`), duration, exit\_code, output\_tail              |
| Background invoke rejects / aborts                    | `UPDATE` with status='failed' (or 'cancelled' if the signal aborted), error\_message    |
| `fleet:cancel` subtree flip (`cancelSubtree`)         | `UPDATE` every active descendant to status='cancelled' (one txn) + release claims/locks |
| Live host heartbeat (`heartbeatSpawns`)               | `UPDATE heartbeat_at = now()` for in-flight spawns, every 60s                           |
| Orphan reclaim sweep (`reclaimOrphanedSpawns`)        | Stale-heartbeat active rows → `status='failed'` + reason, freeing the ceiling           |

### `heartbeat_at` + reclaim — the durability mechanism

A `running`/`restarting` row whose launching operator host dies would otherwise count against the concurrency ceiling forever. The reclaim sweep un-wedges it:

1. The live host bumps `heartbeat_at` every `SPAWN_HEARTBEAT_INTERVAL_MS` (60s) for its in-flight spawns.
2. A row un-heartbeated past `RECLAIM_STALE_MS` (5 min) is a reclaim *candidate* (launching host presumed dead).
3. The reclaim sweep — opportunistic on each spawn + periodic — flips qualifying candidates to `status='failed'` with a reason and frees the ceiling slot (and wakes the dead child's parent).

The sweep is **not** purely heartbeat-driven. Migrations 228 + the `pid` / `launcher_host` columns feed a liveness check (EI-85): for a **same-host** stale candidate, `reclaimOrphanedSpawns` runs `isSpawnProcessAlive(pid)` — a Linux `/proc/<pid>` probe (cmdline-hardened against PID reuse) — and **only reclaims a child it proves dead**. A child that is still alive (its host was merely paused for GC or a restart) is left alone and re-heartbeated. A different-host or pid-less candidate can't be probed, so it falls back to the heartbeat-stale reclaim. **Ahead of the pid probe**, migration 339's `launcher_boot_id` (EI-2186) short-circuits the cross-restart case: a same-host candidate whose `launcher_boot_id` is present but **differs from the current process's boot id** survived a host/operator restart, so its `pid` was reassigned by the reboot and the `/proc` probe would falsely read it ALIVE — it is *provably orphaned* and reclaimed **without** the pid check (`sameHost && c.launcher_boot_id != null && c.launcher_boot_id !== LAUNCHER_BOOT_ID`). Rows predating the column (`launcher_boot_id IS NULL`) fall back to the pid probe. This is a liveness gate, not a SIGTERM-by-pid watcher: nothing signals the child by pid — the reclaim only edits the row.

`cancel_requested` survives in the schema but is informational; it is the reclaim path (heartbeat + pid liveness), not a pid watcher, that frees the ceiling cross-restart.

### Wedged vs generating — `last_output_at` (migration 233)

A fresh `heartbeat_at` only proves the *supervisor* is alive, not that the cup is making progress. Migration 233 adds `last_output_at`; `heartbeatSpawns` stamps it in the same tick as `heartbeat_at` whenever the supervisor observes the child emit stdout/stderr. That distinguishes:

* a **generating** cup — heartbeat fresh **and** `last_output_at` moving; and
* a **wedged** cup — heartbeat fresh but `last_output_at` stale past `WEDGE_SILENT_MS` (10 min), i.e. alive-but-silent (hung network call, stuck rate-limit loop).

`isPossiblyWedged` flags the latter for display/triage. A flag-gated **wedge-reaper** (`reapWedgedLocalSpawns`, `PAPERCUSP_WEDGE_REAP_MS`, default 30 min) cancels such a spawn — it routes through `cancelSubtree`, so the row lands at `status='cancelled'` (claims + locks released), not `'failed'`. A spawn that has emitted **no** output is never flagged by this path — absence of signal is not evidence of a wedge (see the EI-8839 second signal below for the one exception: a never-streamed row is reclaimed when its recorded child process is separately proven dead).

### Ceiling-jam reclaim — two signals (`reclaimCeilingJamDebits`, EI-7204 + EI-8839)

A periodic sweep, separate from the heartbeat/`pid` orphan reclaim above, frees `spawned_agents` rows stuck `running`/`restarting` behind a reused-pid false-alive (a genuinely dead child whose `pid` was recycled by another live process, so the heartbeat/proc-liveness sweep reads it as alive forever). `classifyCeilingJamRow` judges each old-enough, "supervised bee" candidate row against two independent signals and reclaims (`status='failed'`) on either:

* **`stream-silent`** (the original EI-7204 signal) — the row DID stream output once (`last_output_at` is set) but has gone silent past `CEILING_JAM_SILENT_MS`.
* **`proc-dead`** (EI-8839, 2026-07-09) — the row has **never** streamed (`last_output_at IS NULL`, previously left alone entirely per EI-8528) but is same-host with a recorded `pid` that `isSpawnProcessAlive` proves is `/proc`-confirmed dead. This closes an orphaned-admission-debit jam without waiting for the next operator restart's boot reconcile, while still leaving a genuinely-live never-streamed cup (the EI-8528 case) or a row that can't be liveness-checked locally (different host, no recorded `pid`) untouched.

Each verdict writes its own `error_message` reason (`spawn-ceiling-jam — no stream activity...` vs `spawn-ceiling-jam — recorded child process confirmed dead...`) so the two paths stay distinguishable in the row history.

### Idempotent spawn admission — `idempotency_key` (migration 219)

A fleet spawn that times out at the route layer gets retried by the caller; without a dedupe key each retry launched another agent. Migration 219 adds `idempotency_key` + the partial unique index `spawned_agents_idempotency_key_uq` on `(workspace_id, idempotency_key)`. A caller-supplied key makes the `(workspace_id, key)` pair single-spawn even if two requests race past the application-level check — admission returns a `{ kind: 'duplicate', spawnId }` verdict and reuses the existing spawn instead of launching a second one.

## `harness_shared.tool_invocations_spawn_tree` — baseline view

A view, not a table. Recursive CTE over `tool_invocations` joining each row to its ancestors via `parent_spawn_id`.

```sql
CREATE VIEW harness_shared.tool_invocations_spawn_tree AS
WITH RECURSIVE chain AS (
  -- Roots: spawns with no parent
  SELECT
    id, workspace_id, harness_slug, plugin_name, tool_name, role,
    feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
    window_key, invoked_at, duration_ms, status,
    output_ref, output_size, error_message,
    0 AS depth,
    spawn_id::text AS root_spawn_id
  FROM harness_shared.tool_invocations
  WHERE parent_spawn_id IS NULL OR parent_spawn_id = ''
  UNION ALL
  -- Children, joined via parent → ancestor's spawn_id
  SELECT
    t.*, c.depth + 1, c.root_spawn_id
  FROM harness_shared.tool_invocations t
  JOIN chain c
    ON t.parent_spawn_id = c.spawn_id
   AND t.workspace_id = c.workspace_id
   AND c.depth < 16
)
SELECT * FROM chain;
```

### What's in vs what's not

This view is **per-tool-call**, not per-spawn. Each row is one MCP tool invocation; the view tells you "tool X was called by spawn Y, whose root is spawn Z, at depth N."

It's not the same as `spawned_agents`:

|                                       | `spawned_agents`                                                                  | `tool_invocations_spawn_tree`                     |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| Granularity                           | One row per spawn launch                                                          | One row per tool call by a child agent            |
| When written                          | At `spawn()` call time + on resolve                                               | When child makes any MCP tool call                |
| Includes spawns that called no tools? | ✅                                                                                 | ❌                                                 |
| Cross-spawn `depth`                   | derived at query time from `parent_spawn_id` (`getSubtree`) — not a stored column | ✅ in-view (recursive lineage)                     |
| Used by                               | `fleet:tree`, the concurrency count, durability                                   | `intel:spawn_tree` / Intel panel's Spawns sub-tab |

You query `spawned_agents` to answer "what spawns happened?". You query `tool_invocations_spawn_tree` to answer "what did each spawn DO?".

### Joining the two

To get every spawn launch with its child tool calls flattened:

```sql
SET app.workspace_id = 'default';

SELECT
  s.spawn_id,
  s.child_role,
  s.status                                    AS spawn_status,
  s.duration_ms                               AS spawn_dur_ms,
  count(t.id)                                 AS tool_calls,
  count(t.id) FILTER (WHERE t.status='ok')    AS tool_calls_ok,
  count(t.id) FILTER (WHERE t.status='error') AS tool_calls_err
FROM harness_shared.spawned_agents s
LEFT JOIN harness_shared.tool_invocations t
  ON t.parent_spawn_id = s.spawn_id
 AND t.workspace_id   = s.workspace_id
WHERE s.harness_slug = 'sheets'
  AND s.started_at > now() - interval '24 hours'
GROUP BY s.spawn_id, s.child_role, s.status, s.duration_ms
ORDER BY s.started_at DESC;
```

That's the canonical "what happened to each spawn" feed.

## URL plumbing — the spawn params

When a spawn fires, the orchestrator's `spawn-mcp.ts` writes a per-child `.mcp.json` with these query params on the operator URL — and HMAC-signs them (`spawn-signing.ts`) so the dispatcher can verify the envelope:

| Param          | Required | Source                          | Purpose                                                      |
| -------------- | -------- | ------------------------------- | ------------------------------------------------------------ |
| `workspace`    | ✅        | `ctx.workspaceId`               | RLS scoping for everything                                   |
| `role`         | ✅        | child role                      | Tool quota windows + role gating                             |
| `run`          | ✅        | parent's `runId`                | Inherited; per-run quota windows                             |
| `spawn`        | ✅        | new `spawnId`                   | Unique per-spawn telemetry attribution                       |
| `harness`      | optional | `ctx.harnessSlug`               | Path resolution + telemetry attribution                      |
| `feature`      | optional | spawn input `featureId`         | Feature attribution in tool\_invocations                     |
| `chunk`        | optional | spawn input `chunkId` (workers) | Worker chunk-window quotas                                   |
| `parent_spawn` | optional | parent's `spawnId`              | The lineage edge — this is what makes the spawn-tree work    |
| `client`       | optional | UI client id / spawn owner      | Default `ui:dispatch` target when invoked from a browser tab |

(The signature also covers an `exp` expiry param.) Required vs optional is enforced by `parseRequestContext`, which throws `InvalidRequestContextError` only when `workspace`, `role`, `run`, or `spawn` is missing. `harness` is **optional** on the receiver: a missing `harness` defaults to the `'*'` unscoped papercup (a workspace-level role session — operator/planner launched without a harness). The orchestrator always sends it, but the receiver does not require it.

The agent process loads this `.mcp.json` and every MCP request it makes thereafter carries those params. The framework parses them with `parseRequestContext` (`packages/agent-mcp/src/spawn-context.ts`), which takes the request `URL`, populates `ctx.parentSpawnId`, and the dispatcher records it as `parent_spawn_id` on every `tool_invocations` row. (The HTTP transport has a sibling helper, `buildHttpSpawnContext` from `@papercusp/tooldef-http`, which reads the same context from `{ headers, searchParams }` — a different function in a different package, not an alias of `parseRequestContext`.)

That's the entire mechanism. No agent code needs to know about spawning; the URL params do all the work.
