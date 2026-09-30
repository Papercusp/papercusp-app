# 9. Routines
URL: /internal/docs/spec/routines



A routine is a scheduled event source. The durable DBOS tick (`routinesTick`, every \~30s) claims a due routine and enqueues a per-routine durable fire that dispatches the action directly — a `system:&lt;action&gt;` handler inline, an agent role via the harness invoke route, or a warm `coord` wake for a loop. The legacy "routine → `pending_events` → orchestrator" hop is retired for cron routines.

Implemented (with evolution). The routines engine shipped as a durable DBOS scheduled
workflow (`packages/operator-core/lib/dbos/routines-workflow.ts`) reading the
`harness_shared.routines` table (the schema below). The default tick is `*/30 * * * * *` (every 30s,
skip-missed) with a concurrency-4 fire queue. A routine's `target_role` now dispatches one of two ways:
`system:<action>` runs a registered handler inline (the live `system:git-sync`,
`system:green-checkpoint`, `system:release-trigger`, `system:blueprint-run`, … actions —
`packages/operator-core/lib/harness/routines/register-system-actions.ts`), and an agent role spawns that
role via the harness invoke route. The legacy "routine → `pending_events` → orchestrator" hop is retired
for cron routines: a cron routine fires its action directly. The per-plugin/system cost caps and the
`audit.routine_fires` / `audit.system_pressure` telemetry tables in §9.4 below are design intent —
the shipped fire telemetry is the autoloop `recordFire` / `checkFireGate` error-backoff
(`packages/operator-core/lib/autoloop.ts`), not a dedicated `audit` schema.

```
CREATE TABLE harness_shared.routines (
  id                      text NOT NULL,
  install_slug            text NOT NULL,
  name                    text NOT NULL,
  trigger_kind            text NOT NULL,    -- only 'cron' is dispatched today; webhook/api are an unused annotation
  trigger_config          jsonb NOT NULL,   -- { cron: '0 9 * * MON' } | { rrule: 'FREQ=WEEKLY;...', dtstart, tzid, rdate, exdate }
  target_role             text NOT NULL,    -- 'system:<action>' (e.g. system:git-sync, system:blueprint-run) | an agent role
  payload_template        jsonb,            -- additional context to pass to the target
  concurrency             text NOT NULL DEFAULT 'queue',     -- 'queue' | 'skip' | 'cancel-prev'
  catchup                 text NOT NULL DEFAULT 'skip-old',  -- 'skip-old' | 'run-all-backlog'
  active                  boolean NOT NULL DEFAULT true,
  last_fired_at           timestamptz,
  next_fire_at            timestamptz,
  reschedule_interval_sec integer,          -- loop kind: re-fire N sec AFTER the previous turn completes
  target_owner_id         text,             -- loop kind: the coord ownerId of the warm session the loop wakes
  metadata                jsonb,
  workspace_id            text NOT NULL,    -- CHECK (workspace_id <> '')
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

Recurrence kinds. A routine recurs one of three ways: cron (a 5/6-field
crontab in `trigger_config.cron`), rrule (an RFC 5545 RRULE set in `trigger_config.rrule`
with optional `dtstart`/`tzid`/`rdate`/`exdate` — computed natively, never converted to cron), or
loop (the dedicated `reschedule_interval_sec` + `target_owner_id` columns). The engine
computes `next_fire_at` from whichever recurrence is present (`schedule-next.ts`; RRULE takes precedence
over cron when both appear). A cron-kind routine carrying neither a cron nor an rrule nor a loop
interval is a one-shot: it fires once at its explicit `next_fire_at` and is deactivated
(`active = FALSE`) on claim — used for self-declared wakes (e.g. `pot-wake`, a plan-schedule fire, the
pot's `pot-wake`); a plan-schedule one-shot also un-arms its owning plan. The loop kind is
the engine-managed replacement for Claude `/loop`: instead of spawning a role or running a system action,
its fire delivers a warm `coord` wake to a pinned session, and the routine parks at
`next_fire_at = 'infinity'` while its turn is in flight, re-arming `reschedule_interval_sec` seconds after
the turn completes. (`trigger_kind` itself is always `'cron'` today — the engine hard-filters
`trigger_kind = 'cron'`; the `webhook`/`api` annotation has no live receipt path.)

### 9.1 Lifecycle

Register — a harness blueprint declares `triggers.schedule` (materialized into `harness_shared.routines` on `harness:create`) OR a routine is upserted directly
Tick — the durable DBOS `routinesTick` runs every \~30s (default `*/30 * * * * *`, skip-missed), lists due cron routines across every workspace
Claim — each due routine is claimed with a conditional `next_fire_at` advance (so two racing ticks can't both fire it): a recurrence advances to its next time, a one-shot deactivates, a loop parks at `'infinity'`
Fire — the claim enqueues a per-routine durable `routineFireWorkflow` that dispatches the target directly — `system:&lt;action&gt;` runs its registered handler inline, an agent role spawns via the harness invoke route, and a loop delivers a warm `coord` wake. No `pending_events` insert, no orchestrator pickup.

Durable-fire model. Fires run on a `WorkflowQueue('routines')` with concurrency 4 and a
per-routine dedup ID `routine:&lt;id&gt;` — this collapses an overlapping fire while the previous one is
still running (single-fire + natural back-pressure). A `ROUTINE_FIRE_TIMEOUT_MS` of 2h is the dead-executor
release valve: a fire wedged on a crashed executor would otherwise hold the dedup ID forever (the routine
looks alive but never runs), so DBOS cancels it at the deadline to free the dedup.

Opt-in. The DBOS routines engine only runs when `dbosRoutinesActive()` is true
(`PAPERCUSP_DBOS_ROUTINES=1`) and the workflow module is imported by `bootstrap.ts`. While the engine is
new, a host restart never auto-fires stale routines unsupervised. (The legacy `fireRoutine()` /
`insertPendingEvent()` helpers still exist in `routines-runtime.ts` but the engine no longer calls them.)

### 9.2 What routines replace

The legacy per-harness `.papercusp/director-config.json` `autoLoop:true` enablement (and its in-process / DBOS ticker twins) is gone. Cadence now rides the blueprint: a harness blueprint declares `triggers.schedule`, materialized into `harness_shared.routines`, and the tick fires `system:blueprint-run` (→ the blueprint's decider) or an agent role directly.
Scheduled work (weekly briefings, daily cost reports, hourly health checks) is first-class — authored as cron or rrule recurrence on a routine.
An agent that needs to re-run interval-after-completion (the old Claude `/loop`) becomes a loop routine — engine-managed, tracked, and crash-recoverable.

### 9.3 Why this matters

Without routines, the orchestrator's prompt has to know about every scheduled thing. With routines, scheduling is data, not prompt-engineered. Plugin authors can ship a complete "weekly briefings" feature as a single manifest entry — they don't write any cron-parsing or webhook-receiving code.

### 9.4 Cost containment & kill switches

Routines are dangerous: a routine that registers `cron: '* * * * * *'` (every second) and spawns an LLM
call per fire can drain a budget overnight. The backstops that ship today are the failure-streak
error backoff / circuit breaker (§9.4.3) and the concurrency-4 fire queue (§9.4.5). The per-routine rate
floor, per-plugin and global budget caps, and the dedicated audit telemetry described below are
design intent, flagged per section.

9.4.1 Per-routine rate limit (design intent — unimplemented)

Not built. There is no `min_interval_seconds` column or per-routine rate-limit floor in the
engine, and no `routines:rate-limit-bypass` capability enforcement in operator-core. A cron (or rrule)
expression is honored as authored — `claimDueRoutine` computes `next_fire_at` straight from the recurrence
with no min-interval clamp. The intended design below is retained as a future direction; the live backstop
against a runaway fire is the failure-streak fire-gate in §9.4.3, not a frequency floor.

Intended design: every routine would carry a `min_interval_seconds` (default 60) regardless of what
the cron expression says, so a routine asking for `cron: '* * * * * *'` would fire at most once per minute,
with a tighter limit gated behind a `routines:rate-limit-bypass` capability the user approves at install
time.

9.4.2 Per-plugin budget cap (design intent — unimplemented)

Not built. There is no per-plugin `$5/day` daily LLM-spend cap, no `budget:daily:&lt;n&gt;-usd`
capability, and no `plugin.budget-exhausted` event in operator-core. The intended design below is retained
as a future direction.

Intended design: each plugin would have a daily LLM-spend budget enforced by the substrate's budget
guard (§3.7), default $5/day, raisable via a `budget:daily:&lt;n&gt;-usd` capability. On
hitting the cap, all of the plugin's routines and role invocations would pause for the remainder of the UTC
day, and the substrate would emit a `plugin.budget-exhausted` event other plugins (or the UI) could react to.

9.4.3 Kill switches

The user can pause any routine immediately:

```
papercusp routines pause briefings/weekly-summary
papercusp routines resume briefings/weekly-summary
papercusp routines pause-plugin briefings        # all routines from briefings
papercusp routines stats                          # see which plugins fired what, and what cost
```

UI surface: each plugin's settings page shows live routine activity (last fired, fires/hr, $ spent today) with a one-click pause toggle.

Error backoff & circuit breaker (live). The shipped backstop against a repeatedly-failing
fire is the autoloop fire-gate, not a hard pause. Each consecutive error backs off the next fire
exponentially (`base * 2^(N-1)`, default base 60s, capped at 1h); at the circuit threshold — 8
consecutive errors (`PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD`, default 8) — the circuit OPENS and the
role degrades to \~one probe per cap window instead of full cadence. It is not a hard pause and does
not require manual resume: a single successful fire (or `autoloop:control { op:'reset-errors' }`)
resets the counter to 0 and closes the circuit. The gate is consulted by the agent-role fire and the
`system:blueprint-run` decider fire; the fire is withheld, not the routine deactivated.

9.4.4 Telemetry the substrate guarantees (design intent — unimplemented)

Not built as described. There is no `audit.routine_fires` table. The live fire telemetry
is the autoloop `recordFire` / `checkFireGate` state on `harness_shared.autoloop_state` (last fired, last
status, consecutive errors per workspace/slug/role), plus a `routines.metadata.last_error` key a wedged
`system:&lt;action&gt;` writes for the improvement watchdog to read. The dedicated per-fire audit schema below
is design intent.

Intended design: every routine fire would be recorded in `audit.routine_fires` with routine id,
plugin name, fire timestamp, target role, dispatch outcome, total LLM cost, and total wall time — so users
and the UI could answer "which plugin is consuming my budget?" without per-plugin instrumentation.

#### 9.4.5 System-wide caps and back-pressure

Per-plugin caps (§9.4.1, §9.4.2) catch a single misbehaving plugin.
They don't protect against aggregate overload — twenty
well-behaved plugins each within their own caps can collectively
exhaust LLM rate limits, DB connections, or wall-clock concurrency.
One system-wide cap ships today; the rest are design intent:

Concurrent routine fires (live, default 4). The fire queue (`WorkflowQueue('routines', { concurrency: 4 })`) runs at most 4 routine fires at once; further fires wait. This prevents 50 cron expressions all firing at minute :00 from spawning 50 simultaneous fires.
Global daily LLM budget (design intent — unimplemented). Intended: a default `$50/day` cap across all plugins that pauses every plugin's routines until UTC rollover when exhausted, with the user's own non-plugin calls taking priority past 80%.
Per-minute LLM call rate (design intent — unimplemented). Intended: a default 60/min cap across all plugins; on breach, routines would be deferred (next-fire-at slips) rather than failed.

Not built: there is no `audit.system_pressure` table, no global daily/per-minute LLM
budget, and no "system at 87% of daily budget" UI indicator. The intended design was for all system caps to
emit pressure metrics to `audit.system_pressure` so operators could see when they regularly run close to a
limit and a UI could surface stress.

Intended: per-plugin caps would interact with system caps multiplicatively, not additively — a plugin could hit either ceiling first, and authors should size per-plugin caps assuming the (unbuilt) system cap might constrain them earlier than their own.

### 9.5 Routine groups

Partially implemented. This section is a CHARTER (WI-5019,
owner-directed 2026-07-15) — the
membership + governance rules for one named group. The GROUP MECHANICS
(group metadata on the routines registry, group-scoped list/rollup/pause) are
tracked separately as WI-5018 and are not yet built; until they land, "group"
membership below is a roster this doc maintains by hand, not a queryable
field.

A routine group is a named, stewarded collection of routines
that share a purpose — grouped so they can be reasoned about, reviewed, and
(once WI-5018 lands) paused/rolled-up together, rather than as N unrelated
cron entries an operator has to rediscover one at a time.

#### 9.5.1 The `self-improvement` group

Owner-chartered 2026-07-15 ("i want to create a self improving group for the
routines"). Purpose: every routine whose JOB is to OBSERVE the live system
and FILE improvement candidates — as opposed to a routine that does the
system's actual work (git-sync, green-checkpoint, blueprint dispatch, …).

Day-one members (pre-existing, scattered under this
charter — the group has real members from day one, it is not aspirational):

rubric-staleness-watchdog (packages/operator-core/lib/rubric-staleness-watchdog.ts) — flags rubrics whose scoring signal has gone stale.
scorecard-emission-pulse (packages/operator-core/lib/scorecard-emission-pulse.ts) — periodic scorecard-freshness emission.
the recipes sweep + candidates miners (packages/operator-core/lib/agent-tools/recipes/sweep.ts, candidates.ts) — mine code:run call patterns into reusable recipes.
the knowledge\_packs sweep — mines durable knowledge-pack candidates from repeated agent findings.
the improvements watchdog + auto-policy (packages/operator-core/lib/agent-tools/improvements/watchdog-status.ts, digest.ts, learning-loops.ts) — the auto/human triage tiering for filed observations.
dark-flag expiry (DARK\_FLAGS\_REVIEW\_BY on KNOWN\_DARK\_FLAGS, libs/flags/src/production-defaults.test.ts) — surfaces a dark flag that has outlived its review-by date.
the test-quarantine auto-mechanism (3-strikes-in-7-days) — files a de-quarantine follow-up when a flake self-resolves or lingers.

New members, tracked as their own work items: the
invalid-args miner (aggregates tool\_invocations invalid-input
rows into candidates — WI-5017); auto-audit of issue closes populating
engineer\_issues.auditVerdict; auto-checkpoint-nudge at HIGH
contextPressure (both surfaced by the 2026-07-15 leader session audit). A
routine joins this group by being a self-improvement SENSOR per the
principle below and getting listed here (until WI-5018's group metadata
makes membership a field instead of a roster).

Two design principles (binding on every member, present and future):

Sensors, not actuators. A self-improvement routine
OBSERVES and FILES (improvements:capture /
work\_items:create); it never self-modifies the system
directly. The actuator stays the existing improvements pipeline — its
blueprint, its tests, its release-manager gate. That pipeline IS the
safety boundary; a member routine that reaches around it (writing code,
flipping a flag, editing config) is out of charter and must be pulled from
the group.

The group prunes itself. Every member records its yield —
candidates filed vs. accepted vs. shipped. A steward review (cadence: to
be set once WI-5018's group metadata carries a
review\_cadence field; interim default is quarterly, tracked
by hand) drops or retunes low-yield miners. Without this, the
self-improvement group becomes exactly the unbounded-growth problem it
exists to manage — self-improvement includes the willingness to kill your
own low-value routines.

Steward: unassigned — the owner has not yet named one;
until then this charter's upkeep (adding new sensor members, running the
yield review) defaults to whichever agent next touches a member routine, per
the reuse-first / extend-don't-fork discipline.
