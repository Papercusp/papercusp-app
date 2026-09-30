# Scheduled & recurring plans
URL: /internal/docs/spec/scheduled-plans

Plans that recur on a schedule and expire — the engine, the model, the tools, and the autonomy gate. (scheduled-recurring-plans-2026-06-16)

Coding plans complete and finish; other work recurs forever or until an expiration
("monitor our social-media campaigns"). A **scheduled plan** is a normal plan that
optionally carries a schedule — there is no separate "routine" entity. This page is
the spec for how that works end-to-end. Source plan: `scheduled-recurring-plans-2026-06-16`.

## The model: template → runs → instances

A scheduled plan is a **template** — the durable definition. It is never mutated by
running it. A schedule **mints a run** per fire; each run is realized as an ephemeral
**instance plan** (slug `<template>@run-<token>`, a content copy), and recorded as a row in
the `harness_shared.plan_runs` **ledger** (D-002 / D-003). The `<token>` is the *fire token*,
not the `plan_run` id: a scheduled/event fire uses the routine's `last_fired_at` epoch-ms
(stable across DBOS step replay, so a re-executed step is a no-op rather than a double-mint);
a manual `run-now` fire uses a module-monotonic counter. The `plan_runs` row id is allocated
separately by the `RETURNING id` insert, *after* the slug is built (EI-1369).

* The **template** is the stable identity (by slug) — the only row in the plan list and
  the Calendar's recurring-event row. It carries the schedule.
* `plan_runs` is the **occurrence ledger**, keyed by `plan_slug` = the template, so
  "all runs of X" is one query. Each row names its instance via `instance_plan_slug`.
* Instance plans carry an indexed `template_slug` back-pointer and are hidden from
  `plans:list` by default (reached via the template's run history).

The run is the unit of work-item identity, not the plan — so re-runs produce fresh,
distinct work items and audit trails, with idempotency *within* a run (a crash-replay
resumes the same run, never double-mints).

## Recurrence is RRULE, computed to next\_fire\_at — never converted to cron

The authored recurrence is stored on the plan's `schedule` column as an iCalendar
**recurrence set**: `DTSTART` / `tzid` + `RRULE` + `RDATE` (one-off additions) + `EXDATE`
(exclusions). RRULE is the calendar-native standard (it maps 1:1 to a Google-Calendar
recurrence editor and is the interop lingua franca); `cron` is an alternate input dialect.

Crucially, RRULE is **never converted to cron** — cron is strictly less expressive (no
interval-from-anchor, COUNT, UNTIL, or nth-weekday). The DBOS routines engine schedules
on the `next_fire_at` *timestamp*, and the recurrence rule only *computes* that timestamp
(`computeNextFire` in `harness/routines/schedule-next.ts`, the RRULE branch beside the
existing `computeNextFireAt` cron one — D-004).

Per-plan **tzid** recurrence is evaluated in a DST-correct floating frame (luxon): a
`BYHOUR=9` rule means 9am **wall-clock in the zone** (13:00 UTC in summer, 14:00 UTC in
winter), not 09:00 UTC. This is a deliberate workaround (EI-1370) for the `rrule` lib's
own `tzid` handling, which mis-maps an absolute-instant `DTSTART`; non-tz schedules keep
the plain UTC behavior.

Three orthogonal time concepts, all nullable columns on the plan:

* `schedule` (the RRULE set) — repeated runs.
* `scheduled_at` — a one-shot future run (drag-onto-a-day), then it deactivates.
* `expires_at` — stored, and bounds the **calendar display window** (it clamps the
  occurrence expansion in `scheduled-occurrences.ts`). It is **not yet enforced as a
  firing cutoff**: no firing-path code (`claim.ts`, `materialize-plan-schedule.ts`,
  `arm-plan-schedule.ts`, `plan-run-action.ts`) reads it, so a recurrence keeps firing
  past `expires_at` unless the RRULE itself carries `UNTIL`/`COUNT`. (`expires_at` is a
  separate column, deliberately NOT mapped to iCal `UNTIL` — D-020.) The plan is not
  deleted on expiry. Deactivation-on-expiry is intended but unbuilt — see the source plan.

## The engine: one seam onto the existing routines engine

Arming a schedule materializes a `harness_shared.routines` row whose `target_role` is
`system:plan-run` — mirroring how a blueprint's `triggers.schedule` materializes
`bp-schedule-*` rows. The shipped 30s DBOS routine tick claims a due row
(`claim.ts`, now RRULE-aware) and fires the `system:plan-run` action, which mints the run.

Because the engine schedules on `next_fire_at` and advances it to the *next future*
occurrence, **catchup-on-launch** falls out for free (D-005): an overdue routine (the
desktop app was closed past a fire time) fires **once** on the first post-boot tick, then
returns to cadence — missed slots collapse to one. Overlap policy
(`queue` / `skip` / `cancel-prev`) is the routine's `concurrency` (default `skip`, D-014).

### Run-scoping (D-016)

A run's work items are minted into the harness frontier by `system:plan-run`, stamped
with `source_plan_slug` = the **template** (so the Mug's frontier filter works
unchanged) and `payload.plan_run` = the run (`runId` / `runSeq` / `instancePlanSlug` /
`templateSlug`). The Runs-tab rollup reads `payload.plan_run.runId` (indexed). This
avoided surgery on the `work_items` union view + INSTEAD-OF trigger.

### Calendar & occurrence expansion

The Calendar tab and the Mug's eligible-routines pane are driven by **backend-computed
occurrences** — one source of truth in `harness/routines/scheduled-occurrences.ts`
(`listPlanSchedules` / `gatherScheduledOccurrences`), which expands the RRULE set over a
window via `expandOccurrences` (`schedule-next.ts`). The calendar UI lib stays swappable
because it consumes the expanded list, not the rules. `expires_at` takes effect *here*
(clamping the display window end), not in the firing path.

Expansion is **capped** (default 500 occurrences per plan per window) to bound a
pathological sub-minute cadence, complementing the author-time sub-15-min frequency
warning — the warning catches the cost at authoring; the cap protects the calendar/Mug
expansion at render.

## Authoring & lifecycle tools

* `plans:set-schedule` — author/edit/clear the schedule columns (validates the RRULE;
  warns on a sub-15-min cadence). Does NOT arm. Carries `executorKind` (D-006): the
  frontier `item_kind` each run mints — default `feature` (coding spine), or `research-task`
  for a lighter non-coding executor.
* `plans:arm-schedule` / `plans:disarm-schedule` — arm (start firing) / pause. Arming is
  autonomy-gated (below). Disarming keeps the authored schedule.
* `plans:run-now` — fire one run by hand (trigger=`manual`), independent of cadence.
* `plans:runs` — the enriched run history (outcome, duration, trigger, per-run work-item
  rollup, cost) + `computePlanRunRollup` (success rate, median duration, regression flags).

## Arming is autonomy-gated

Authoring a schedule is harmless; **arming** it starts autonomous recurring spend +
action, so it routes through the Mug autonomy policy. A 14th, NON-protected category
`schedule-arm` (seeded `never-auto`, but graduatable — distinct from the permanently
protected `system-control`) gates `plans:arm-schedule`: the Mug escalates to the owner
until that category graduates; the owner arms directly (D-010 / D-017).

## Self-governance & safety

* **Completion** — when a run's work items terminate, a reconcile settles its `outcome`
  (`success` / `partial` / `failed`) + `finished_at`.
* **Failure auto-pause** (D-011) — a template whose last K (default 3) runs all failed is
  auto-disarmed (the disarmed state is the notification).
* **Cost** (D-012 / D-018) — a per-plan `costCapCents` is stored + a frequency warning at
  author time; aggregate spend is bounded by the existing global/per-plugin budget caps.
  Hard per-run pause-on-breach is implemented (D-018): a settled run's spend is attributed
  (work\_items → `spawned_agents` → `agent_usage_samples`, SUM `cost_usd`) and a run whose
  cost exceeds `costCapCents` auto-disarms the schedule — the cost sibling of the
  failure-streak pause, both run in `reconcileAndGovern` (routine tick + `plans:runs` read).
* **Retention** (D-015) — the `plan_runs` ledger is kept forever; each old run's heavy
  artifacts (instance plan, transcript, work items) are GC'd past the last-N / older-than-T
  bound.

## The master flag

The whole execution path is gated by the `papercusp-scheduled-plans` flag, which ships
**default-ON** (D-019). The autonomy gate — not the flag — is the real safety boundary:
arming a schedule routes through the `schedule-arm` category (seeded `never-auto`), so
nothing fires autonomously until the owner arms it or that category graduates. The flag
exists as a kill switch: with it off, `system:plan-run` no-ops and `plans:arm-schedule`
refuses. (It ships ON rather than dark because the deployed flag registry doesn't yet
know the key, so a post-deploy MCP flip isn't possible — the in-code default is the only
lever, and the autonomy gate already holds the line.)

## Where it lives

* Schema: `libs/papercusp/libs/db/sql/299` (schedule + plan\_runs columns) + `300` (rollup index).
* Engine: `packages/operator-core/lib/harness/routines/{schedule-next, claim, materialize-plan-schedule, plan-run-action, arm-plan-schedule, reconcile-plan-runs, gc-plan-runs}.ts`.
* Tools: `packages/operator-core/lib/agent-tools/plans/{set-schedule, run-now, arm-schedule, disarm-schedule}.ts`;
  the `plans:runs` tool is `runs-list.ts`, over the enriched `runs.ts` DAL (`computePlanRunRollup` / `listPlanRuns`).
* Calendar/occurrences: `packages/operator-core/lib/harness/routines/scheduled-occurrences.ts` (the Calendar + Mug pane source).
* Autonomy: `packages/operator-core/lib/autonomy/{categories, action-surface, capability-category-map}.ts`.

See also [Routines](/internal/docs/spec/routines) (the engine this rides) and
[Plan format](/internal/docs/spec/plan-format) (the plan model).
