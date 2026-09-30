# Green-checkpoint reaped at 25m — the executor-reaper no-output window must exceed the suite runtime
URL: /internal/docs/agent-insights/green-checkpoint-reaped-by-executor-window

>-

## Symptom

`release:deploy op:status` shows the gate RED with a high `consecutiveReds` and
`lastGreenAt` many hours ago; `main` is frozen so no fleet deploy lands. The
green-checkpoint routine metadata (`harness_shared.routines` where
`name = 'green-checkpoint'`) shows:

```
last_error: "DBOS routineFire produced no DBOS operation output; executor reaper
             cancelled the stuck fire and requeued the routine"
last_error_source: "dbos-executor-reaper"
```

and `harness_shared.pipeline_events` shows a long run of `green_checkpoint` rows that
are `skipped-locked` (never a real `not-green`/`advanced` verdict). The `flake_history`
is stale — this is **not** a test failure.

## Root cause

The `green-checkpoint` action (`release-actions.ts`) runs the whole suite as a single
`await runScript('green-checkpoint.ts', …)` bounded by `GREEN_CHECKPOINT_SUITE_TIMEOUT_MS`
(\~55m). From DBOS's view that routineFire records **no `operation_outputs` row with
`function_id > 0`** until it completes — it is one long opaque await with no intermediate
DBOS step checkpoint.

The `dbos-executor-reaper` (a 2-min process-level sweep, NOT a DBOS workflow) cancels any
`routineFire` that is still non-terminal, has a live queue row, and has produced no
operation output for `DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS`. That constant was **25m**,
tuned only for Scout's 20-min first step. Once the green-checkpoint suite grew to \~55m,
**every checkpoint that ran longer than 25m was cancelled mid-suite** before it could emit
a verdict; a checkpoint that happened to finish under 25m was the only way the gate ever
went green. A cancelled run also left its 65-min run-lock stale-held, so the next fires
came back `skipped-locked` — a self-sustaining wedge (here: \~64h, blocking all deploys).

## Fix

Raise `DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS` above the suite's full runtime so a healthy
long checkpoint reaches a terminal (non-reapable) status before the window elapses. The
cross-file invariant (the constants live in separate files because operator-core cannot
import the apps/operator tier — same convention as the result MARKERs):

```
GREEN_CHECKPOINT_SUITE_TIMEOUT_MS          (120m, release-actions.ts)
  <  SELF_WATCHDOG_MS                      (180m, green-checkpoint.ts)
  <  DEFAULT_STALE_ROUTINE_FIRE_NO_OUTPUT_MS (185m, dbos-executor-reaper.ts)
  <  CHECKPOINT_LOCK_STALE_MS              (190m, green-checkpoint.ts)
```

The fast orphan path and the dead-executor path (5-min liveness) are unchanged, so this
longer window only delays the rare live-executor-with-no-output case — never the common
wedge classes.

## It happened AGAIN — the recurrence, and the two traps behind it (WI-6112, 2026-07-26)

The 2026-06-29 fix was correct and still silently inverted. When the suite budget was
raised **55m → 120m** (EI-7553, because full-fleet load pushed real runs to 60–90m), the
reaper window stayed at **60m** — so the reaper became the *tightest* link and resumed
cancelling healthy runs, now with a 60m guillotine on a 120m-budgeted suite. Two traps
made that invisible, and both are worth knowing before you retune anything here:

**Trap 1 — the constant's NAME lies about what it measures.** `NO_OUTPUT` reads like a
*silence* timer ("reaps a fire that has gone quiet for 60m"), which invites the plausible,
comforting, and **false** conclusion that a chatty run can never trip it. The predicate is
a **wall-clock cap from workflow CREATION**:

```sql
created_at < ${staleRoutineFireNoOutputAt}   -- NOT started_at, NOT updated_at
AND NOT EXISTS (SELECT 1 FROM dbos.operation_outputs op
                 WHERE op.workflow_uuid = … AND op.function_id > 0)
```

`created_at` is deliberate (DBOS recovery refreshes `started_at`/`updated_at` on a row it
has still not checkpointed, and that heartbeat must not keep a wedged dedup pin alive).
And the "output" is a **DBOS step checkpoint**, not stdout: green-checkpoint writes to its
log file continuously for the whole run and records *nothing* here until its single step
returns. So the real invariant is **the run's TOTAL runtime must fit inside the window** —
continuous logging buys you nothing. When a claim hinges on what a mechanism measures, read
the comparison operator, not the constant name (or the prose next to it).

**Trap 2 — a cross-file "whoever retunes one must retune the other" comment is not a
guard.** Three files in two workspaces each carried that note (operator-core cannot import
from apps/operator, so the constants must live apart), and every one of them was obeyed
right up until someone edited a *fourth* place. The self-watchdog was also missing from the
chain the notes described.

**The durable fix** is therefore not the new number — it is
`apps/operator/lib/release/release-timing-invariants.test.ts`, which imports all four
constants (apps/operator *can* import operator-core) and asserts the chain is strictly
monotonic, with enough margin above the reaper's 2-min sweep that the ordering cannot hold
on paper and invert in practice. It also feeds its own inversion detector the historical
broken configuration, so an always-green detector fails loudly instead of quietly ceasing
to protect the gate. Retune any link and the test tells you, at edit time, which others
must move.

## Activating the fix

The reaper runs in the **bg-host** (`papercup-bg-host.service`, executor `bg-host-3270`,
from the `papercupai-workspace/papercusp` dev tree), NOT the `:3070` release operator. The
constant is read at boot, so the change takes effect only after
`systemctl --user restart papercup-bg-host.service` (its watchdog restarts it routinely, so
this is safe). After restart the boot-reap clears the stale dedup and the next checkpoint
runs to completion.

## How to diagnose next time

1. `release:deploy op:status` → gate red + stale lastGreen.
2. Query the routine metadata `last_error` / `last_error_source` — `dbos-executor-reaper`
   means a WEDGE (cancelled fire), not a test failure.
3. `ps -ef | grep green-checkpoint.ts` and check `~/.papercusp/checkpoint-logs/*.log`: if a
   suite is actively running but keeps getting cancelled near a round-number minute mark,
   suspect the reaper window. The newest *completed* log shows the real test verdict (the
   four deterministic failures here were already fixed at HEAD — the wedge was the blocker).
