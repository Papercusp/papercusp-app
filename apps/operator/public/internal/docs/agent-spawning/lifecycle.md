# Lifecycle
URL: /internal/docs/agent-spawning/lifecycle

>-

:::caution\[`cup:spawn` REFUSES — the launch verb below is retired]
The Mug · Kettle · Cup/nursery **role tier** was **retired 2026-08-09** (owner-directed);
`cup:spawn` and `fleet:place_batch` now refuse. Launch with **`fleet:launch-on-plan`**
(N agents on a plan) or **`capability:launch-agent`** (one flexible launch/resume/fork).
See [the Mug · Kettle · Cup tier is retired](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired).

The rest of this page is **still accurate and still load-bearing** — the status
transitions, cross-restart durability, orphan reclaim and parent-wake behaviour describe
the one spawn engine every launch path shares, including the live ones above.
:::

## The three tools

Every spawn flows through the `fleet:*` surface — launch with `cup:spawn` (**retired — use
`fleet:launch-on-plan`**), watch with `fleet:tree`, abort with `fleet:cancel`.

```
                       ┌──────────────────────────┐
                       │  cup:spawn             │
                       │  → returns spawn_id      │
                       │  → status='running'      │
                       └──────────┬───────────────┘
                                  │
                                  │ background spawnInvokeOnce()
                                  ↓
                       ┌──────────────────────────┐     ┌──────────────────────────┐
parent  ─ fleet:tree → │  status: running         │ ←── │  child agent runs        │
        ─ fleet:tree → │  status: running         │     │  (invoke-once subprocess)│
        ─ fleet:tree → │  status: done|failed     │ ←── │  child exits             │
                       └──────────────────────────┘     └──────────────────────────┘
                                  │                                   │
        ─ fleet:cancel → abortController.abort()         (parent woken on child death —
                       SIGTERM (then SIGKILL after 2s)    wakeParentOnChildDeath)
                       status flips to 'cancelled'
```

Unlike a poll loop, a parent doesn't have to keep checking: when a child reaches a terminal status, `wakeParentOnChildDeath` fires the parent's inbox-wake key (with the death notice + output tail), so a sleeping parent re-wakes on its own. `fleet:tree` is for on-demand inspection of the subtree, not mandatory polling.

## `cup:spawn { harness?, role, feature?, chunk?, brief?, extras? }`

What happens server-side (in `spawnAgentInHarness`):

1. **Role sanity + pre-launch guards.** The role must be a known `AGENT_ROLES` member or a plugin-namespaced role (`group:role`); a typo fails loud before booting an agent. `role="worker"` requires a `chunk` (spawn a scoper first to chunk the feature). Two more fail-loud guards live at this same role-admission chokepoint: a `role="overwatch"` spawn is **rejected** unless the `papercusp-overwatch` flag is on (default OFF — the role is registered but dark), and a brief still containing the un-substituted `{item}` / `brief-NN` template placeholder is **refused** (EI-249 — an upstream substitution step was skipped). All of these are recorded as `status='failed'` nursery rows.
2. **Harness resolution.** An explicit `harness` slug wins; with none, a single-harness workspace is the unambiguous default. Anything ambiguous or unregistered fails loud. The project dir must exist on disk.
3. **Orphan reclaim, then concurrency check.** Stale-heartbeat rows from a dead operator host are reclaimed (freeing the ceiling) before the live `running`/`restarting` count is compared against the fleet concurrency ceiling (`maxSimultaneousAgents`). That ceiling is **host-derived, not a fixed 16**: its default is seeded from the resource profile (`round(cores * (embeddedPg ? 0.25 : 0.5))`, then clamped down by free RAM at \~0.5 GiB/agent, halved on battery, finally clamped to `[1, 16]`). A laptop sharing an embedded PG can seed as low as 1; only a large server seeds the 16 cap. 16 is the upper clamp, not the default — and the user's persisted live config (PG `operator_rate_limit_config`) overrides the seed entirely. Over the ceiling is a **queue+await**, not a silent drop: the result carries an `await_event` key the caller sleeps on (`events:await`), ending its turn and retrying the spawn when a slot frees.
4. **PG row written** to `harness_shared.spawned_agents` with `status='running'`, `session_owner = spawnId`, and the child's lock `coordination_domain`. Indexed for fast lookups + the reclaim sweep.
5. **AbortController registered** in this host's module-level `Map<spawnId, AbortController>` (`localSpawnAborts`), and the heartbeat loop is started so the row's `heartbeat_at` stays fresh while the child lives.
6. **`spawnInvokeOnce()` fires in the background** as a Promise — *not awaited*. The caller gets the spawn result back immediately.
7. **The promise's `.then`/`.catch`/`.finally`** flips the PG row to `done`/`failed`/`cancelled`, announces the freed slot, and wakes the parent.

The spawn's umbilical: the durable `s-…` spawnId is threaded into the child's env (`PAPERCUSP_SPAWN_ID`) so its signed MCP URL carries a stable `client=`/owner — the same id recorded as `session_owner`, so a cup's coord messages, its file-lock owner, and `fleet:cancel`'s release target all line up.

Return result:

```json
{
  "ok": true,
  "spawn_id": "s-1778408605532-16080170",
  "harness": "sheets",
  "project_dir": "/path/to/project",
  "error": null,
  "next": "fleet:tree { spawn_id } to watch; fleet:cancel { spawn_id } to abort."
}
```

An over-ceiling rejection returns `ok:false` with `error` and an `await_event` key. A pre-launch failure (unknown role/harness, cap) is **recorded** as a `status='failed'` nursery row (the failed `spawn_id` is returned) rather than silently dropped.

There is also a third, success-shaped outcome: **idempotent dedupe**. If the caller passes an `idempotency_key` (e.g. a retry after a route timeout) that matches an earlier spawn, no second agent is launched — the result comes back `ok:true` with `deduped:true` and the **original** `spawn_id`. The dedupe is checked inside the same atomic admission transaction (right after orphan reclaim, before the concurrency count), so concurrent retries are race-safe via a partial unique index on `idempotency_key` (migration 219).

## `fleet:tree { spawn_id }`

Reads the durable subtree rooted at a node directly from `spawned_agents` (via `getSubtree`) — every descendant with its status, owner, role, and the work it serves — plus the completion gate (`can_complete` / `open_children`: whether the root has any live child).

Status field is the single source of truth:

| Status       | Meaning                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `running`    | Promise hasn't resolved yet. AbortController is live (on the launching host).                                      |
| `restarting` | Supervised restart in flight (one\_for\_one / one\_for\_all / rest\_for\_one). Counts as ACTIVE.                   |
| `done`       | Promise resolved, child subprocess exited with code 0.                                                             |
| `failed`     | Non-zero exit code, the invoke threw, OR a stale-heartbeat orphan was reclaimed.                                   |
| `cancelled`  | Aborted via `fleet:cancel` (or the subtree flip).                                                                  |
| `reaped`     | Legacy terminal status for a startup-swept orphan; today orphans are reclaimed to `failed` by the heartbeat sweep. |

Each node also carries `feature`, `plan_item`, `owner` (`session_owner`), and `restart_strategy`. Per-node `depth` is the lineage depth within the queried subtree (root = 0). Terminal-row detail (`exit_code`, `output_tail`, `error_message`) lives on the `spawned_agents` row directly — query it or read it off the death-notice payload the parent is woken with.

`fleet:tree` also flags wedges. A node that is **alive + heartbeating but stream-silent** past `WEDGE_SILENT_MS` (10 min) — cups stream partial messages, so a long silence with a live process means hung, not thinking — is annotated `possibly_wedged: true`. That annotation is display/triage only. The flag-gated reaper (`WEDGE_AUTO_REAP`, default ON — D-006, 2026-06-11) takes the next step: it cancels a *local* spawn that has been stream-silent past `WEDGE_REAP_SILENT_MS` (30 min) through the same durable `cancelSubtree` engine `fleet:cancel` uses — so a wedged `running` cup becomes `cancelled`, a real terminal transition. Only the host holding the spawn's handle reaps it, and a spawn that has never produced output is never reaped (absence of signal ≠ a wedge).

## `fleet:cancel { spawn_id, reason? }`

A single transitive cancel — there is no in-memory-vs-PG fork in the tool contract. Cancelling a node fans cancellation **down the entire subtree**:

1. **Durable half** (`cancelSubtree`). This runs in two phases. **Phase 1** is the atomic transaction: every active descendant's row is flipped to `status='cancelled'` and each one's work-item / plan-item *claims* are released — all in one `sql.begin`. **Phase 2** runs *after* that commit as fail-open best-effort effects: the file/resource *locks* and the parent cancel notice. The locks are deliberately **not** in the Phase-1 transaction — they are efficiency-class, so a missed release simply falls back to its lease rather than waiting minutes for N leases to expire independently.
2. **In-process half** (EI-40). For each cancelled spawn this host launched, the held `AbortController` is triggered: SIGTERM the child's process group, then SIGKILL after a 2-second grace if it hasn't exited. Spawns launched by *another* operator process aren't locally tracked — their rows are still flipped, and the heartbeat-staleness sweep reclaims the orphaned OS process when its host stops heartbeating.

The result reports `cancelled` (the spawn ids), `processes_aborted`, `already_terminal`, and the released-claim/lock counts.

## Status transitions

```
   ┌─────────────┐  ←→  ┌──────────────┐
   │   running   │      │  restarting  │  (supervised restart; still ACTIVE)
   └──┬───┬───┬──┘      └──────────────┘
      │   │   │
   .then  .catch  abort()
      │   │   │
   ┌──↓─┐ │   ┌─↓─────┐
   │done│ │   │failed │ ← also: stale-heartbeat orphan reclaimed here
   └────┘ │   └───────┘
          │
       ┌──↓──────┐
       │cancelled│
       └─────────┘
```

`running` and `restarting` are the two ACTIVE statuses; `done | failed | cancelled | reaped` are terminal. Once a row is terminal it stays there — no re-runs (a supervised restart is a fresh attempt, not a terminal-row revival). `reaped` is a legacy terminal status: today an orphaned row is reclaimed to `failed`, not `reaped`.

## Cross-restart durability

| Action            | Pre-restart spawn (this host)                             | Post-restart spawn (prior host)                                                                |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `fleet:tree`      | ✅ reads the PG row                                        | ✅ reads the PG row (the nursery is fully durable)                                              |
| concurrency count | ✅ counted live                                            | ✅ counted until reclaimed                                                                      |
| `fleet:cancel`    | ✅ durable flip **+** real SIGTERM (local AbortController) | ⚠️ durable flip only — no local handle to kill the OS process; the heartbeat sweep reclaims it |

A `running` row whose launching operator host died is no longer left to zombie forever. The live host heartbeats `heartbeat_at` for its in-flight spawns; once a row's heartbeat goes stale past `RECLAIM_STALE_MS` (5 min), the reclaim sweep (`reclaimOrphanedSpawns`, run opportunistically on each spawn and periodically) flips it to `status='failed'` with an explanatory `error_message` and frees the concurrency ceiling. That sweep also wakes the dead child's parent.

Reclaim is **not** purely heartbeat-age, though (EI-85): a stale-heartbeat row whose recorded OS pid is still alive on `/proc` on the **same** host is deliberately **left running** — the host was only briefly paused, not dead, and its row just gets its heartbeat bumped. Only a genuinely-gone process (or a row on a *different* host, which this one can't liveness-check) is reclaimed. The recorded pid + launcher host land on the row via migration 228.

## What runs in the child

`spawnInvokeOnce` (`packages/operator-core/lib/dbos/orchestrator-runner.ts`) launches the child as a detached subprocess (its own process group, so a group-kill reaps the wrapper + invoke-once + agent together on cancel/timeout) — the same invoke-once code path the harness uses. The engine threads:

| Passed to the child         | Source                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `project.path` (cwd)        | `resolveProject(harness)` — the registered harness's project dir                          |
| `role`                      | the spawn input's `role`                                                                  |
| `extras[]`                  | the input's `extras`, with `FEATURE_ID=<id>` / `CHUNK_ID=<id>` appended when set          |
| `PAPERCUSP_SPAWN_ID`        | the durable `s-…` spawnId (the umbilical — becomes the child's stable MCP `client`/owner) |
| `PAPERCUSP_PARENT_SPAWN_ID` | the parent's spawnId, when this spawn has a parent (lineage)                              |
| `QUEEN_BRIEF`               | the spawn input's `brief`, when set (P-060) — injected into the cup's prompt              |
| pipeline env                | `buildPipelineExtraEnv` (workspace, harness, idempotency key, PG DSN)                     |

The orchestrator's `spawn-mcp.ts` writes a per-child, HMAC-signed `.mcp.json` (`packages/operator-core/lib/spawn-signing.ts`) with the per-spawn URL params, including `parent_spawn` set to the parent's spawnId — so any tool calls the child makes carry `parent_spawn_id` automatically. (See [Schema](/internal/docs/agent-spawning/schema#url-plumbing--the-spawn-params) for the full param list.)
