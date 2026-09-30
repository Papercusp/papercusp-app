# 6. Orchestrator + pending_events
URL: /internal/docs/spec/orchestrator



Papercusp uses a centralized orchestrator rather than per-agent heartbeats. Why:

Implemented (with evolution). The single all-deciding LLM "orchestrator" role of this
design shipped as a split: the orchestrator is now the deterministic code selector
(`packages/operator-core/lib/dbos/orchestrator-loop.ts`) that starts a durable per-feature pipeline, and the
per-feature LLM decider keeps the distinct name director (the legacy
`prompts/orchestrator.md` persona is dead — no blueprint uses `spine.decider: orchestrator`,
so the only live decider is `director`). External events still land in
`harness_shared.pending_events` (NOTIFY/LISTEN via `pending-events-listener.ts`), but the scheduled-tick
path is the DBOS routines engine (see §9): a cron routine now fires the
`system:blueprint-run` action directly rather than enqueuing a `pending_events` row for the orchestrator to
consume. The decision verbs below are real (`NEXT_WORKER`, `NEXT_VALIDATOR`, …); each blueprint declares its
own vocabulary in `spine.edges`.

No wasted wakeups — only the orchestrator polls. The other agents stay asleep until summoned.
Centralized auditing — every decision is one orchestrator output you can trace.
Cheap state visibility — the orchestrator sees the whole feature frontier in one deterministic pass.
Drift control — sequential decisions, predictable order.

External events (cron, webhook, API) write to a `pending_events` queue, which the concierge
Operator observes via NOTIFY/LISTEN (it never consumes rows). The orchestrator does not read
`pending_events` — on each tick it reads the deterministic feature frontier (its actual inputs):

```
     pending_events
     (queue)
        ▲
        │ inserts from:
        ├── webhook handlers
        ├── API triggers
        └── completion-delta hooks (e.g. feature→passed → notify reviewer)
        │
        ▼ (observed by the concierge Operator via NOTIFY/LISTEN — never consumed here)


  ┌───────────────────────────────────────────────────────┐
  │  ORCHESTRATOR (1 global, shared across all             │
  │                harnesses / workspaces)                 │
  │                                                        │
  │  the deterministic CODE selector — no LLM, no verbs    │
  │  reads (per tick):                                     │
  │    - features (work_items frontier:                    │
  │        status / feature_order / source_plan)           │
  │    - feature blocked_by edges                          │
  │    - the durable-owned (in-flight) feature set         │
  │    - started-plan priority                             │
  │    - issues (I-STUCK signal; open issue → F-FIX)       │
  │                                                        │
  │  picks the ready, unblocked, not-in-flight features    │
  │  and starts ONE durable pipeline per feature           │
  │  (up to the harness's concurrency cap)                 │
  └─────────┬──────────────────────────────────────────────┘
            │ ensureFeaturePipeline(slug, featureId, …)
            ▼
  ┌────────────────────────────────┐
  │  DIRECTOR (per-feature decider, │
  │  inside the durable pipeline)   │
  │                                 │
  │  emits each turn:               │
  │    NEXT_WORKER | NEXT_VALIDATOR │
  │    | NEXT_<role> | DONE         │
  │    | ESCALATE | IDLE            │
  └─────────┬───────────────────────┘
            │
            ▼ (deriveNext maps the verb → the named role)
```

Tick triggering is two independent paths — no `pending_events` row is enqueued for the
orchestrator to consume (that hop is retired, `git-sync-auto-commit` D-006):

Scheduled — the orchestrator registers its own DBOS scheduled workflow
(`DBOS.registerScheduled`, `*/30 * * * * *`) that calls `runOrchestratorTick()` directly every 30s.
It's armed unless the operator explicitly opts out.
On-settle refill — when a feature pipeline settles it immediately re-dispatches
just that harness (`refillHarnessOnSettle` → `dispatchOneHarness`), filling the freed slot without
waiting for the next 30s tick; the periodic tick is the backstop.
Cron routines — a due `system:blueprint-run` (or other `system:<action>`) routine is
dispatched by the DBOS `routinesTick` inline, as one durable step, straight to its registered
handler — not through a `pending_events` consumer (see §9).

Deterministic frontier selection

The orchestrator is a deterministic frontier selector — it carries no LLM and emits no decision verbs.
Each tick it computes the ready set with the shared readiness predicate: a feature is ready iff its
status is dispatchable, it isn't already owned by a live pipeline (in-flight), and every `blocked_by` edge
is satisfied (terminal or absent). Ready features are ordered by started-plan priority (`op_priority`,
then `started_at`) and, within a plan, by `feature_order`, then filled greedily up to the harness's
concurrency cap. When dispatchable work remains but nothing is ready, it raises a single persistent
`I-STUCK` issue (auto-cleared when work frees up); it also auto-promotes qualifying open issues to
`F-FIX` features before selecting.

Concurrency & dispatch policy

Concurrency is per-harness and blueprint-driven: each harness's effective blueprint
declares a `dispatch:` section (`concurrency`, `costCapUsd`, `readiness`, `safetyCeiling`) refined by the
per-install config (`resolveDispatchPolicy`). The coding-factory blueprint declares
`dispatch.concurrency: 4`. The effective cap is clamped by an imperative safety ceiling
(`PAPERCUSP_DBOS_MAX_PIPELINES`) and the fleet-wide `maxSimultaneousAgents`. A missing or corrupt
blueprint falls back to a safe `cap: 1`.

Gating & scope

The orchestrator is default-on for every Started pot. `PAPERCUSP_DBOS_ORCHESTRATOR`
registers the workflow; `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES` (alias
`PAPERCUSP_DBOS_DISPATCH_HARNESSES`) scopes which harnesses are swept — unset or `*` means all,
`none`/`off` opts out, and a comma list is an allowlist. The 30s tick is armed unless that env is an
explicit opt-out. Placement is additionally gated on the Start-Pot bit: a stopped or never-started
pot's backlog is skipped, so the orchestrator only places work for pots that are Started.

For idle harnesses, this is strictly better than per-agent heartbeats: zero wakeups when there's nothing to do.
