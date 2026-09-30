# Overview
URL: /internal/docs/agent-spawning/overview

>-

:::caution\[The launch verb on this page is retired — `cup:spawn` REFUSES]
The Mug · Kettle · Cup/nursery **role tier** was **retired 2026-08-09** (owner-directed).
While `papercusp-mug-kettle-system` is OFF — which is the delivered end state, not a
pending flip — **`cup:spawn` and `fleet:place_batch` refuse**, and no Mug exists to place
or supervise anything. See
[the Mug · Kettle · Cup tier is retired](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired).

**Use instead:** `fleet:launch-on-plan` for N agents on a plan, or
`capability:launch-agent` for a single flexible launch/resume/fork.

This page is **kept, not retired**, because everything *around* the launch verb is still
live and still correct: the one spawn chokepoint and its guards, the fleet concurrency
ceiling, `fleet:tree` / `fleet:cancel`, `parent_spawn_id` lineage, and the durable
`spawned_agents` nursery table. Read `cup:spawn` below as *the shape of a spawn call*,
not as a verb you can issue.
:::

## The one-line version

One agent launches another via the `fleet:*` MCP tools — `cup:spawn` to launch (**retired —
use `fleet:launch-on-plan`**), `fleet:tree` to watch, `fleet:cancel` to abort — and the parent gets a `spawnId` back immediately. The child runs to completion in the background; the parent inspects the tree later or moves on (and is woken on the child's death — see [Lifecycle](/internal/docs/agent-spawning/lifecycle)). Lineage threads through `parent_spawn_id` so the Intel panel shows the full tree.

## Why this exists

Before Phase 9, the orchestrator was the only thing that could launch agents. Every architect→worker, scoper→validator, debugger→validator step ran through the orchestrator's sequential decision turn. (That sequential run loop — `runMainLoop` / `main-loop.ts` — has since been retired to `libs/papercusp/_retired/orchestrator-run-loop/` under plan `archive-legacy-orchestrator-deadcode-2026-06-06`. The contrast below is still the right mental model, but those identifiers are dead code, not the live counterpart.) That funnel is right for the canonical lifecycle, but two patterns kept hitting the wall:

* **Architect fan-out.** "These three features are independent — let's run F-001, F-002, F-003 in parallel" — required either three orchestrator iterations in series or a custom branch in the run loop. Now: three `cup:spawn` calls, return immediately, inspect with `fleet:tree` later.
* **Reviewer kicking a re-architect.** Reviewer notices an architectural mismatch mid-review. Pre-Phase 9: write an issue, hope architect picks it up next iteration. Post-Phase 9: `cup:spawn { role: 'architect', extras: ['REVIEW_NOTE=...'] }` — synchronous-looking, no orchestrator round-trip.

## How it differs from the orchestrator's run loop

The table below contrasts the spawn primitive with the orchestrator's old sequential run loop. That run loop (`runMainLoop` / `main-loop.ts`) is **retired** — moved to `libs/papercusp/_retired/orchestrator-run-loop/` — so the left column is a historical reference, not a live counterpart. The contrast is still the right way to understand what the spawn primitive is *for*.

|              | Retired run loop                                        | spawn primitive                                                                                            |
| ------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Driver       | `runMainLoop` decision-turn → invoke                    | A `cup:spawn` tool call from any allowlisted coord role                                                    |
| Sync?        | Sequential (one role at a time)                         | Parallel (multiple spawns concurrent, up to the fleet concurrency ceiling)                                 |
| Duration cap | Per-role timeout in `invoke()`                          | Same per-spawn (`PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS`, default 2,700,000ms / 45min) — but parent doesn't wait |
| Context      | Walked an in-memory decisions batch, computed next verb | Caller passes `role` + `feature` + `chunk` directly                                                        |
| Telemetry    | in-memory decisions batch + `tool_invocations`          | `spawned_agents` (durable nursery) + `tool_invocations` (with `parent_spawn_id`)                           |

The orchestrator still owns the canonical "what should this harness do next" decision. `cup:spawn` is the lower-level primitive an agent reaches for when it knows what it wants to launch and just needs to launch it.

## Where you read about how it works

* [Lifecycle](/internal/docs/agent-spawning/lifecycle) — spawn → inspect → cancel; status transitions; cross-restart durability + orphan reclaim via PG
* [Allowlist & caps](/internal/docs/agent-spawning/allowlist-and-caps) — who can spawn whom; the concurrency ceiling
* [Schema](/internal/docs/agent-spawning/schema) — `spawned_agents` + `tool_invocations_spawn_tree` (baseline + migrations 146/174)
* [Observability](/internal/docs/agent-spawning/observability) — Intel panel's Spawns sub-tab; useful PG queries for the tree
* [Limits](/internal/docs/agent-spawning/limits) — what the spawn primitive doesn't do, what's deferred

## Where it lives in code

| Component                                                                                                                                                                                                                   | File                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn engine (the one chokepoint for all three launch paths — chat `<spawn>`, `cup:spawn`, `place_batch`; its guards — role admission, brief-substitution refusal, ceiling admission, idempotency dedupe — apply uniformly) | `packages/operator-core/lib/fleet/operator-spawn.ts`                                                                                                                                                                                                                                                                |
| `cup:spawn` / `fleet:tree` / `fleet:cancel` tools                                                                                                                                                                           | `packages/operator-core/lib/agent-tools/fleet/{spawn,tree,cancel}.ts`                                                                                                                                                                                                                                               |
| Durable nursery read/write (`recordSpawn`, `finishSpawn`, `getSubtree`)                                                                                                                                                     | `packages/operator-core/lib/fleet/{spawn-tree,pg-stores}.ts`                                                                                                                                                                                                                                                        |
| Background child invoke (subprocess + SIGTERM/SIGKILL)                                                                                                                                                                      | `packages/operator-core/lib/dbos/orchestrator-runner.ts:spawnInvokeOnce`                                                                                                                                                                                                                                            |
| Wake-parent-on-child-death                                                                                                                                                                                                  | `packages/operator-core/lib/fleet/parent-wake.ts`                                                                                                                                                                                                                                                                   |
| Orphan reclaim + heartbeat (concurrency ceiling)                                                                                                                                                                            | `packages/operator-core/lib/fleet/spawn-reclaim.ts`                                                                                                                                                                                                                                                                 |
| `spawned_agents` table + spawn-tree view (DDL)                                                                                                                                                                              | `libs/papercusp/libs/db/sql/000-baseline.sql` (+ migrations `146-fleet-supervision.sql`, `174-spawned-agents-heartbeat-reclaim.sql`)                                                                                                                                                                                |
| Per-spawn params (parse)                                                                                                                                                                                                    | `packages/agent-mcp/src/spawn-context.ts:parseRequestContext` (MCP-transport URL parser); the HTTP transport has its own `buildHttpSpawnContext` in `libs/generic/tooldef-http/src/http-projection.ts` (re-exported via `packages/agent-mcp/src/index.ts`) — same per-spawn params, two independent implementations |
| `.mcp.json` writer + HMAC signing                                                                                                                                                                                           | `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts` + `packages/operator-core/lib/spawn-signing.ts`                                                                                                                                                                                                             |
