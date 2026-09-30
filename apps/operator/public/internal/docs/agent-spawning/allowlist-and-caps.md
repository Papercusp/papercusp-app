# Admission & the concurrency ceiling
URL: /internal/docs/agent-spawning/allowlist-and-caps

>-

:::caution\[The role gate below still runs — but `mug` / `cup` / `kettle` are retired roles]
The Mug · Kettle · Cup/nursery **role tier** was **retired 2026-08-09** (owner-directed).
`cup:spawn` refuses outright, and `RETIRED_TIER_ROLES = {mug, kettle, cup}` is checked
*after* `canonicalCoordRole`, so the aliases `bee→cup`, `queen→mug`, `overwatch→kettle`
are caught too. See
[the Mug · Kettle · Cup tier is retired](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired).

So read the filter below as **how role admission is computed**, not as a live roster:
the mechanism (one chokepoint, admission by role, the concurrency ceiling) is unchanged
and still governs `fleet:launch-on-plan` and `capability:launch-agent` — but the specific
claim that "**`mug`** … **can** call `cup:spawn`" is no longer true of either role.
:::

## Who may call `cup:spawn`

There is no per-role *allowlist matrix* (caller-role → set-of-spawnable-roles).
That layered rule budget lived in the retired `@papercupai/orchestrator-spawn`
plugin; the live path is `packages/operator-core/lib/fleet/operator-spawn.ts`
behind the `cup:spawn` tool.

`cup:spawn` is role-gated to a **filtered subset** of `COORD_ROLES`, not the
full set. The full coordination role set the `coord:*` and `locks:*` tools use
is `scoper`, `architect`, `worker`, `validator`, `reviewer`, `debugger`,
`operator`, `documenter`, `curator`, `cup`, `mug`, `papercup`, `overwatch`.
`cup:spawn` takes `COORD_ROLES.filter((r) => r !== 'cup' && r !== 'papercup'
&& r !== 'overwatch')` — placement is the **Mug's** surface (D-002,
`cup-capability-expansion-2026-06-08`), so:

* **`mug`** is the registered placement decider and **can** call `cup:spawn`
  (alongside `operator` and the pipeline coding roles).
* **`cup`**, **`papercup`**, and **`overwatch`** are explicitly **excluded** —
  the cup *works*, the papercup *watches* and the overwatch *nudges*; none of
  them place. (The cup joined `COORD_ROLES` for `coord:*`/`issues:*`, which
  inadvertently leaked this placement tool to it; filtering it back out turns
  "only the brain spawns" from convention into a gate.)

A **superuser** caller (a `psu` session, the loopback admin door) bypasses the
role gate entirely. So "who can spawn whom" is no longer a static edge list;
it's *admission* (below) plus the one concurrency ceiling.

The child role itself is only sanity-checked, not allowlisted against the
caller: it must be a known `AGENT_ROLES` id (`packages/agent-mcp/src/role-config.ts`)
or a plugin-namespaced `<plugin>:<role>`, and `role='worker'` requires a
`chunkId` (workers window their quotas on `chunk:<id>`). A `cup` carries no
chunk requirement.

## Admission is the brain's judgment, not a rules budget

The model (`unify-agent-spawn-chokepoint-2026-06-06`) is: **any** coordination
agent may *initiate* a spawn request, but whether it actually launches is the
**brain's** call, informed by live spawn headroom and open work — not a static
per-role quota.

* **`new_subagent:request`** — any agent asks the brain to spin up a sub-agent.
  It routes a typed, brain-only-approvable request and returns an
  `await_event`; the requester `events:await`s the grant, ends its turn, and on
  wake (`choice === 'approve'`) calls `cup:spawn`. The response surfaces the
  live headroom (`running/ceiling`, free slots) so the brain decides informed.
* **`new_subagent:approve`** — **brain-only**: approve or deny a pending
  request and wake the requester. The "only the brain decides" rule is enforced
  at the **dispatch layer**, not by prompt convention: `requireRoles: [BRAIN_PRINCIPAL_ROLE]` is a fail-closed RBAC gate (the operator/brain
  principal carries the `brain` role; a spawned worker/scoper/etc. carries none
  → denied), with `agentRoles: ['operator']` as defense-in-depth. A superuser
  bypasses both.
* **Pre-granted stream budget** — the brain can grant a requester's stream a
  spawn budget up front (`fleet:governor { op: 'grant_credits', scope_key, n }`
  — or `op: 'set_credits'` to seed a pool; consumed by `tryConsumeSpawnCredit`).
  While budget remains,
  `new_subagent:request` **auto-approves** with `via: 'budget'` and no brain
  round-trip; only an exhausted (or never-granted) budget routes to the brain.

The operator/brain itself doesn't request — it allocates directly via
`cup:spawn`. Already-decided pipeline work admits its own role progression
(the harness autoloop dispatches it), and a human-initiated `psu` session needs
no request at all.

## The one cap: a fleet-wide concurrency ceiling

There is a **single** deterministic safety floor (P-007), not separate
depth / children / concurrent caps. The old hardcoded `MAX_CONCURRENT_SPAWNS=10`
and the orchestrator dispatch cap were folded into one live-editable value:
`operator:rate_limit_config`'s **`maxSimultaneousAgents`**, read live by
`spawnConcurrencyCeiling()`. The governor's global gate, the orchestrator
dispatch ceiling, and the await pump all draw from the same number. It is
clamped to **`RATE_LIMIT_MAX_CEILING = 64`**
(`packages/operator-core/lib/rate-limit-config.ts`).

The default is **not a fixed 16** — it is *seeded from the host's resource
profile* (`operator-scalability-event-loop-2026-06-16`):
`DEFAULT_RATE_LIMIT_CONFIG.maxSimultaneousAgents` is a getter delegating to
`getResourceProfile().maxSimultaneousAgents`, which is core- and RAM-derived
(`clamp(onBattery ? round(agentsBudget/2) : agentsBudget, 1, 16)`, where
`agentsBudget = min(round(cores × (embeddedPg ? 0.25 : 0.5)),
floor(freeGiB / 0.5))`). **16 is the upper clamp**, not the default — a laptop
sharing an embedded PG seeds a small cap (as low as 1), a big-core server seeds
the ceiling. This is only the *seed*: the user's persisted live config (PG
`operator_rate_limit_config`) still wins over it.

The effective **admission** ceiling is lower still: `effectiveSpawnCeiling(workspaceId)`
takes the system `spawnConcurrencyCeiling()` and clamps it **down** by the
owner's per-pot `max-cups` steering knob (`mug-steering-panel-2026-06-15`
P-006 / D-005). The owner can only *lower* it, never raise it past the system
cap. Both `getSpawnHeadroom` and the atomic admission read this reduced value —
so when the owner throttles the fleet, the brain sees (and admission enforces) a
ceiling below `maxSimultaneousAgents`. A steering-read failure fails soft, leaving
the system ceiling in effect.

The count is **per-workspace and durable**: `countRunning()` counts every
`harness_shared.spawned_agents` row with `status IN ('running', 'restarting')`
for the workspace — so it holds across operator restarts and a dead host's
orphaned rows are reclaimed (P-011) before the count, so they can't wedge the
ceiling.

The depth/children fan-out limits are gone. There is **no** `MAX_DEPTH` and
**no** `MAX_CHILDREN_PER_PARENT`. Fan-out shape is the brain's allocation
decision (informed by `getSpawnHeadroom`), not a static cap.

## How a rejected spawn fails

There are **no** five typed `spawn_*` error codes. A spawn that can't run
resolves in one of three admission outcomes (`SpawnAdmission` kinds):

### Validation / resolution failure → a recorded `failed` row

Missing role, unknown role, `worker` without `chunkId`, an unregistered or
missing harness — all `fail()` with a plain-text `error_message` and are
**recorded durably** as a `status='failed'` nursery row (via
`recordFailedAttempt`), so the rejection is visible in `fleet:tree` / the Brew
tab rather than a silent `console.warn`. Two more validation refusals join this
class: `role='overwatch'` is refused while the **`papercusp-overwatch`** flag is
OFF (the role ships dark until staged), and a brief still holding an
un-substituted `{item}` / `brief-NN` placeholder is refused (EI-249 — a missed
template substitution would otherwise boot a mis-briefed cup). Example messages:

```text
spawn rejected: unknown role "wroker" — known roles: scoper, architect, worker, …
spawn rejected: role="worker" requires a chunk id (spawn a scoper first to chunk the feature)
spawn rejected: harness "sheets" is not a registered project (registered: …)
spawn rejected: role="overwatch" is gated behind the papercusp-overwatch flag …
spawn rejected: brief contains an un-substituted placeholder "{item}" … (EI-249)
```

### Over-ceiling → queue + await (never a silent drop)

When `running >= cap`, the spawn is **not** dropped and **not** a hard error —
it returns a wake key the caller sleeps on (D-004):

```text
spawn rejected: 16 spawns already running (fleet ceiling 16 — maxSimultaneousAgents).
Do not drop or busy-wait: events:await { event: "spawn-slot:freed:<workspace>" },
end your turn, and retry this spawn on wake (a slot-free wakes you) — or fleet:cancel one.
```

The result carries `awaitEvent = spawn-slot:freed:<workspaceId>`. Every freed
slot — a spawn completing (`done`/`failed`/`cancelled`) or the reclaim sweep
freeing orphaned rows — broadcasts that event, waking all waiters, which
re-check the ceiling on retry (re-check-on-wake fairness, not a granted ticket).

### Idempotent replay → the original spawn, deduped (no second agent)

A retry that carries the **same `idempotency_key`** as a spawn that already
landed (e.g. after a route timeout, EI-73) is the third admission outcome
(`SpawnAdmission` kind `duplicate`): it returns the **original** `spawn_id` with
`deduped: true` and `ok: true`, and launches **no** second agent. The dedupe is
atomic inside the admission transaction, backstopped by migration 219's partial
unique index — so even a racing retry can't slip a duplicate through.

## How the gates compose

The full sequence when an agent calls `cup:spawn(role: 'worker', feature:
'F-001', chunk: 'F-001-1')`:

```
1. Framework: tool exists?                          ✓ (registered)
2. Framework: caller role in the spawn subset?      ✓ (COORD_ROLES minus
                                                       cup/papercup/overwatch;
                                                       or superuser bypass)
3. Engine: role known (AGENT_ROLES or <plugin>:…)?  ✓
4. Engine: worker has chunkId?                       ✓
5. Engine: role!='overwatch' OR flag ON?             ✓ (else failed row)
6. Engine: brief fully substituted (no {item})?      ✓ (else failed row, EI-249)
7. Engine: harness resolves to a real project dir?   ✓
8. Engine: idempotency_key not already seen?         ✓ (else dedupe → original id)
9. Engine: reclaim orphans, then running < ceiling? ✓ (else queue+await)

   → SpawnRecord allocated, PG row written (status='running'),
     spawnInvokeOnce fires in the background; finishSpawn flips
     the row to done/failed on exit.
```

If 1-2 fail you get a framework dispatch error. If 3-7 fail you get a recorded
`failed` row with a plain-text reason. If 8 matches you get the original
`spawn_id` back with `deduped: true`. If 9 is over-ceiling you get the
queue+await wake key. There are no typed `spawn_*` codes — the engine speaks in
recorded `error_message` strings and the one await rail.

## Headroom the brain reads

`getSpawnHeadroom(workspaceId)` returns `{ ceiling, running, headroom }` after
reclaiming orphaned rows, so the count reflects live spawns only. The `ceiling`
it reports is the **effective** ceiling (`effectiveSpawnCeiling` — the system
cap clamped down by the owner's `max-cups` knob), the same value admission
enforces. This is the read the brain-as-allocator consults — and what
`new_subagent:request` surfaces to the brain — before deciding a spawn is worth
it. The ceiling is the hard backstop; the worth-it allocation above it is
judgment, not a quota table.
