# Engine-managed loops — the tracked /loop replacement for su sessions
URL: /internal/docs/agent-insights/engine-managed-loops

How a "loop" works — the engine-managed, restart-surviving replacement for Claude Code's built-in /loop for su/interactive agents. Loops vs schedules vs /loop, the after-completion (rebase) semantics, the warm-wake/resume ladder, the failure-streak + cost-cap guardrails, the create+self-assign work-queue convention, observing a loop, and the code map.

## What this is

A **loop** is the engine-managed, tracked replacement for Claude Code's built-in
`/loop` for **su / interactive agents** — the agents a user works with directly. A
user works a plan with an su agent and says "put this on a loop"; the agent keeps
working that plan **warm** (same session/context) on a recurring cadence, but the
recurrence is owned by Papercusp's routines engine instead of the client's
in-context `/loop`. Why move it into the engine: a loop then **survives operator
restarts**, is **observable** (`loop:status` + the work-queue + fire-history), is
**pauseable**, and inherits the engine's **guardrails** — none of which Claude's
`/loop` has (it drifts, dies with the session, and is invisible to the operator).

This is **NOT** the autonomous mug/cup/scout loop. That is a separate system that
already runs on its own machinery (`pot:declare-wake` / `overwatch:declare-wake`)
and is explicitly out of scope — never `loop:arm` from an autonomous-fleet agent
(plan `loop-routines-interval-recurrence-2026-06-20`, D-007).

> Gated by the **`papercusp-loops`** flag — **DEFAULT ON** (WI-612; owner-flipped
> live 2026-06-23, and NOT in `DARK_FLAGS`, so the derived `FLAG_DEFAULTS` inversion
> enables it for fresh hosts too — see `libs/flags/src/types.ts` `LOOPS`). Only if a
> host explicitly turns it OFF does `loop:arm` return `loops_disabled`; `loop:end` /
> `loop:status` always work.

## Three words: plan · schedule · loop

The routines engine fires on a trigger. There are now three recurrence shapes:

| Word         | Cadence                                     | Example                                       |
| ------------ | ------------------------------------------- | --------------------------------------------- |
| **schedule** | a fixed **wall-clock** time (cron / RRULE)  | "every weekday at 9am" → `plans:set-schedule` |
| **loop**     | **N sec AFTER the previous turn COMPLETES** | "keep at it every \~5 min" → `loop:arm`       |
| (one-shot)   | once, at an explicit time                   | a dragged-onto-a-day plan run                 |

Rule of thumb: **"schedule" = fixed clock; "loop" = N sec after the last turn
finished.** A loop is the *third* recurrence kind in `harness_shared.routines`: it
carries neither a cron nor an RRULE, just a `reschedule_interval_sec` and a
`target_owner_id`.

## How a loop runs, mechanically

```text
loop:arm { intervalSec, goal }            ← you, as the LAST thing before ending your turn
        │  writes a routine row: trigger_kind='cron', trigger_config={},
        │  reschedule_interval_sec=N, target_owner_id=<you>,
        │  payload_template.kickoff=<wakeup prompt>, next_fire_at=now()+N
        ▼
[30s routine tick]  claims the due loop  →  claim.ts PARKS it: next_fire_at='infinity'
        │                                   (the in-flight / skip-if-in-flight papercup)
        ▼
fireLoopWake  →  coord:send{wake} to target_owner_id  →  the wake-executor liveness ladder:
        │            • alive + injectable pty   → inject the wake-turn ("press enter")
        │            • process exited           → `claude --resume <sid>` (warm from transcript)
        │            • alive-but-uninjectable    → park + inbox-nudge → resume when the pid dies
        ▼
your warm turn runs (same context!) → you work the iteration → you END YOUR TURN
        ▼
[30s reconcile tick]  your session goes quiescent  →  the completion-rebase re-arms the
                       parked loop: next_fire_at = completed + interval  →  loops back to the tick
```

Three load-bearing pieces make this safe:

* **The `'infinity'` park (claim, B-LOOP-1).** On claim a pure loop is *not*
  deactivated (the one-shot trap) and *not* set to `NULL` (the infinite-refire
  trap). It stays `active=TRUE` and parks `next_fire_at='infinity'::timestamptz` —
  the due-guard `next_fire_at <= now()` never matches infinity, so a loop is never
  re-claimed *while its turn is in flight*. That park IS the skip-if-in-flight
  guard, for free.
* **The completion-rebase (B-LOOP-2, `reconcile-loop-routines.ts`).** A warm loop
  mints **no plan\_run per fire** (D-006), so the "turn done" signal is not
  `plan_runs.finished_at` — it is the **session/turn quiescence** (the pinned
  owner's presence going idle on the 30s reconcile tick). When a parked loop's turn
  settles, the rebase re-arms it to `completed + interval`. Idempotent off the fixed
  completion time, and it only ever moves `next_fire_at` *forward*.
  * Caveat: the settle is observed on the 30s tick, so the **true period is
    `interval` + up-to-30s**. Fine at the 60s floor; sub-minute is intentionally
    unsupported.
* **The warm coord wake (B-LOOP-3, `loop-fire.ts`).** A loop fire does NOT spawn a
  role or run a system action — it delivers a `coord:send{wake}` to the pinned
  `target_owner_id` and rides the **shipped** wake-executor liveness ladder. The
  loop owns *no* resume code (D-005); inject-vs-`--resume` is the executor's call by
  liveness. Transcript growth across iterations is the agent harness's job (Claude
  Code native compaction), not the loop's.

## The wakeup prompt — create + self-assign your work\_items

Each wake injects the loop's **kickoff** (the wakeup prompt) as your turn text. The
default (interpolated with your goal / interval / owner / harness) tells you to:

1. Decide the next concrete unit(s) of work; if the goal is done or there's nothing
   left, `loop:end` and stop — don't spin on empty wakes.
2. **Create + SELF-ASSIGN** this iteration's work in ONE atomic call:
   ```
   work_items:create { kind:'task', title:'…', harness:'<h>', assign_to:'<your ownerId>' }
   ```
   This creates AND claims the item in a single DB write (B-LOOP-4, no create→claim
   race), so the loop's work rides the **work-queue** — it shows in
   `fleet:assignments`, warm + self-owned, never cold-dispatched. Omit `topics` — a
   self-owned loop item needs no topic fanout.
3. Work them; update `work_items:set_state` (in\_progress → completed) and the plan
   as you go.
4. End your turn — the loop re-wakes you \~`interval` sec after it settles.

Why create+self-assign instead of "just keep working in your head": it makes the
loop's progress **legible** without minting a plan\_run per fire. History rides three
existing layers (D-006): routine fire-history (`recordFire`), the work-queue, and
plan progress. (Progress-checkpointing is general — *every* agent should update
progress each turn, loop or not — so it lives in the work-item / plan tools, not in
the loop.)

## Guardrails

Two gates wrap every fire (D-006):

* **Failure-streak fire-gate** (`checkFireGate`, the existing autoloop backoff,
  keyed per-loop by the routine name). A genuinely dead session advances the streak
  and backs the loop off; a *missed* wake (busy/parked session — the inbox row
  persisted) does NOT, so a momentary miss never trips the circuit.
* **Cost-cap** (the one net-new loop guardrail). Pass `costCapCents` to `loop:arm`
  and the fire auto-pauses the loop when cumulative spend crosses it. Best-effort —
  per-session cost attribution for a warm interactive su session is imprecise.

## Using it

```text
loop:arm { intervalSec: 300, goal: "ship the export feature" }   ← arm (≥60s floor)
   … optional: costCapCents (auto-pause), harness, wakePrompt (custom per-wake text)
loop:status                                                      ← active? interval? parked? next/last fire? cost-cap?
loop:end                                                          ← stop (deactivates; history kept)
```

* Arm it as the **LAST thing** before you end your turn (like `pot:declare-wake`).
* `loop:end` the moment the goal is done or you're **blocked** on something external
  — don't burn empty wakes spinning.
* It is per-owner: one loop per pinned session (re-arming upserts the one row).

## Observing a loop

* **`loop:status`** — the targeted read: active, interval, **parked** (turn in
  flight), next/last fire, cost-cap.
* **`fleet:assignments`** — the work the loop is producing (its self-assigned
  `work_items`), warm + self-owned.
* **Routine fire-history / `autoloop:status`** — each wake, plus the failure-streak
  state if the loop has backed off.

## Adoption — the su/interactive personas

The su/interactive persona sources steer recurrence onto the engine loop and away
from the client's native `/loop` (the B-LOOP-5 / B-LOOP-FIN-1 sweep): the live
instance override (`apps/operator/prompts/pot-instances/papercup-pot.su.md`), the
legacy engineer + power playbooks (`papercusp-su-{engineer,power}.tools.md`), and the
Claude client overlay (`papercusp-su.claude.md`, where `/loop` natively lives). The
rule: *to recur on a cadence, declare an engine loop (`loop:arm`); do NOT self-pace
with your client's native `/loop` / `ScheduleWakeup`.* The **autonomous**
mug/cup/scout loop is deliberately **excluded** (D-007) — it is its own system
(`pot:declare-wake` / `overwatch:declare-wake`) and keeps its own
native-scheduler-deny rule. A content test
(`apps/operator/lib/su-persona-loop-sweep.test.ts`) guards the sweep from regressing.

> Editing `papercup-pot.su.md` requires a **re-seed** (`setHiveInstancePromptOverride`
> via the `/settings/pot-customization` editor) for the live persona to pick it up;
> the file-based playbooks + overlay propagate on the next su launch.

## Code map

| Piece                                                                                 | File                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Schema (B-LOOP-1): `reschedule_interval_sec` + `target_owner_id` cols                 | `libs/papercusp/libs/db/sql/323-loop-routines-reschedule-interval.sql`         |
| `RoutineRow` + `upsertRoutine` threading + the `'infinity'` parked-Date papercup      | `libs/papercusp/libs/db/src/routines-runtime.ts`                               |
| Claim third-kind (park at `'infinity'`)                                               | `packages/operator-core/lib/harness/routines/claim.ts`                         |
| Loop row materialization + the wakeup-prompt template (the surface)                   | `packages/operator-core/lib/harness/routines/loop.ts`                          |
| Completion-rebase (B-LOOP-2)                                                          | `packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts`       |
| Warm-wake fire + cost-cap (B-LOOP-3)                                                  | `packages/operator-core/lib/harness/routines/loop-fire.ts`, `loop-cost-cap.ts` |
| Fire dispatch (routes a loop by `reschedule_interval_sec != null && target_owner_id`) | `packages/operator-core/lib/dbos/routines-workflow.ts`                         |
| The verbs                                                                             | `packages/operator-core/lib/agent-tools/loop/{arm,end,status}.ts`              |
| Atomic create+self-assign                                                             | `packages/operator-core/lib/agent-tools/work_items/create.ts` (`assign_to`)    |

Plan: `loop-routines-interval-recurrence-2026-06-20`. Phase C (scale to hundreds of
concurrent loops) is **demand-gated** (D-004) — not built on spec; the
lightweight-fire-record work it implies is exactly the `workflow_status`-bloat risk
surface, so it waits for a concrete load requirement.
