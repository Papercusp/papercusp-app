/**
 * The routine-claim primitive — carved out of `dbos/routines-workflow.ts` so the
 * claim semantics are testable without importing the DBOS workflow module (which
 * registers workflows + system actions at load).
 *
 * Atomically claim a due routine: advance `next_fire_at` to its next cron time
 * ONLY if it is still active + due and the captured `next_fire_at` is unchanged.
 * The null-safe compare-and-swap fence prevents a stale tick snapshot from
 * overwriting a newer `routines:set` retune, even when that retuned timestamp is
 * already due. The `WHERE active AND (next_fire_at IS NULL OR next_fire_at <= now())`
 * guard means exactly one racing tick wins the claim; a loser sees zero rows
 * updated and skips.
 *
 * A cron-kind routine with neither a cron nor an rrule expression is a ONE-SHOT (a self-declared
 * wake at an explicit `next_fire_at` — the pot's `pot-wake` routine,
 * autoloop-pot-operator-rebuild D-002): claiming it DEACTIVATES it. Setting
 * `next_fire_at = NULL` while leaving it active would make it due again on the
 * very next tick — an infinite refire loop.
 *
 * A LOOP (loop-routines-interval-recurrence-2026-06-20 P-003) is the THIRD recurrence
 * kind: it has NEITHER a cron NOR an rrule, but it DOES carry `reschedule_interval_sec`
 * — it re-fires N sec AFTER its previous turn completes (the engine-managed replacement
 * for Claude /loop). Claiming a loop must NOT deactivate it (the one-shot trap above) and
 * must NOT set next_fire_at=NULL (the infinite-refire trap above). Instead, on claim it
 * stays active=TRUE and PARKS at `next_fire_at = 'infinity'::timestamptz`: the claim guard
 * `next_fire_at <= now()` never matches infinity, so the loop is not re-claimed while its
 * turn runs — that IS the skip-if-in-flight guard, for free. The completion-rebase (P-002)
 * re-arms it to a real time (completed_at + interval). A routine carrying BOTH a cron and a
 * loop interval (cron+loop) is recurrence (it has a cron), so it takes the normal cron-advance
 * branch below — staying active and advancing to cron-next; P-002 then folds in the loop
 * re-arm by taking the SOONER of cron-next and completed_at+interval.
 */
import type { Sql } from 'postgres';
import type { RoutineRow } from '@papercusp/db-org';
import { computeNextFire } from './schedule-next';
import { routineStorageSlug } from '../../pot-membership';
import { recordLoopTransition } from './loop-transition-log';

/**
 * WI-6978 — the slug `harness_plans` rows are actually STORED under for this routine.
 *
 * harness_plans is Hive-scoped: the plans:* write path collapses a member harness to
 * its Hive home (resolvePlanScope → potHomeSlugForHarness), so filtering by the
 * routine's RAW `installSlug` matches ZERO ROWS whenever the routine is installed
 * under a member harness or a workspace-global label. Here that silence is
 * particularly bad: every use below is an UPDATE un-arming `schedule_active`, so the
 * miss leaves a plan reading "armed" forever behind a routine that is already dead —
 * exactly the EI-1371 symptom those writes exist to prevent.
 *
 * Resolved LAZILY (only inside the two plan-schedule branches) because claimDueRoutine
 * is the hot per-tick path and the overwhelming majority of routines are not
 * plan-schedules. Fails open to the literal slug.
 */
const planSlugFor = (routine: RoutineRow): Promise<string> =>
  routineStorageSlug(routine.installSlug, routine.workspaceId);

/**
 * The minimum captured routine shape needed to fence a durable fire at dispatch
 * time. A recurring fire is admitted by claimDueRoutine while the row is active,
 * but it may wait in the DBOS queue long enough for an operator to pause the
 * routine before the fire workflow starts. The queued workflow's captured
 * RoutineRow is then stale: re-read the writer-owned `active` flag before any
 * side effect.
 *
 * One-shots are deliberately different. claimDueRoutine atomically sets their
 * row active=FALSE as part of a successful claim, so treating that state as a
 * pause would suppress every valid one-shot. Pure loops carry an interval and
 * therefore use the recurring fence even without cron/rrule configuration.
 */
export interface ClaimedRoutineDispatchRef {
  id: string;
  triggerConfig: Record<string, unknown>;
  rescheduleIntervalSec: number | null;
}

export async function claimedRoutineDispatchAllowed(sql: Sql, routine: ClaimedRoutineDispatchRef): Promise<boolean> {
  const hasRecurrence = !!(routine.triggerConfig.cron || routine.triggerConfig.rrule);
  const isLoop = routine.rescheduleIntervalSec != null;
  if (!hasRecurrence && !isLoop) return true;

  const rows = await sql<{ active: boolean }[]>`
    SELECT active
      FROM harness_shared.routines
     WHERE id = ${routine.id}
     LIMIT 1
  `;
  // Missing is fail-closed: a deleted recurring routine must not leave an
  // already-enqueued workflow free to perform its captured side effect.
  return rows[0]?.active === true;
}

export async function claimDueRoutine(sql: Sql, routine: RoutineRow): Promise<boolean> {
  const cfg = routine.triggerConfig;
  // The due-list query hands us a snapshot. `routines:set` can replace both the
  // cron config and next_fire_at before this claim runs; do not let this stale
  // snapshot consume the new schedule. `IS NOT DISTINCT FROM` is intentional:
  // NULL is a valid due value and must compare equal to the captured NULL.
  const capturedNextFireAt = routine.nextFireAt ?? null;
  // WI-40883 — the comparison MUST be millisecond-granular, and this is not a style
  // choice: it is the difference between a routine that fires and one that is
  // permanently dark. PostgreSQL `timestamptz` stores MICROSECONDS; `capturedNextFireAt`
  // has already round-tripped through a JS `Date`, which holds only MILLISECONDS. So for
  // any row whose next_fire_at was written by SQL `now()` (every `INSERT ... next_fire_at,
  // now())` seeder), the captured value differs from the stored value in the µs digits a
  // Date cannot represent, a bare `next_fire_at IS NOT DISTINCT FROM $captured` is FALSE
  // FOREVER, this UPDATE matches 0 rows, and routinesTick's `if (!claimed) continue;`
  // skips the routine silently on every tick for the life of the row.
  //
  // MEASURED 2026-08-23 on the live operator DB: 11 active/due routines had NEVER fired —
  // green-checkpoint for three pots (hotel-reservations dark ~36h, so those pots' release
  // gate had never once run), cross-hive-outbox-drain for three, external-trigger-dispatch,
  // both Google pollers, the Facebook vault poller, and gc-desktop-sessions. The census was
  // a clean 2x2 with zero exceptions: all 11 never-fired rows carried sub-millisecond
  // precision, all 162 firing rows did not. Positive control isolating the row from the
  // code: `green-checkpoint` fired normally for 8 other pots off this same handler and cron.
  //
  // date_trunc keeps the optimistic-concurrency intent intact — a real reschedule
  // (`routines:set`, a cron advance) moves next_fire_at by seconds or minutes, never by the
  // sub-millisecond sliver this tolerates — while making the guard immune to the precision
  // floor. NULL survives it too: date_trunc(NULL) IS NOT DISTINCT FROM NULL is TRUE, so a
  // legitimately-NULL due value still compares equal. Migration 906 additionally narrows the
  // column to timestamptz(3) so PG cannot store what JS cannot read; this guard is the
  // defence-in-depth for any writer that migration does not cover.
  //
  // Pinned by claim-precision.integration.test.ts — do not inline a bare comparison here.
  const nextFireUnchanged = sql`date_trunc('milliseconds', next_fire_at) IS NOT DISTINCT FROM ${capturedNextFireAt}`;
  // Recurrence = a cron OR an rrule (scheduled-recurring-plans P-007).
  const hasRecurrence = !!(cfg && (cfg.cron || cfg.rrule));
  // A loop carries an interval (re-fire N sec after the turn completes). A PURE loop
  // (interval set, no cron/rrule) is the THIRD kind; a cron+loop is recurrence (below).
  const isLoop = routine.rescheduleIntervalSec != null;

  // THIRD KIND — pure loop: keep active=TRUE and PARK at 'infinity' (the in-flight
  // sentinel). NOT deactivate, NOT NULL, NEVER touch harness_plans (a loop is not a
  // plan-schedule one-shot). The completion-rebase re-arms it after the turn settles.
  if (isLoop && !hasRecurrence) {
    const rows = await sql<{ id: string }[]>`
      UPDATE harness_shared.routines
         SET last_fired_at = now(),
             next_fire_at = 'infinity'::timestamptz,
             updated_at = now()
       WHERE id = ${routine.id}
         AND active = TRUE
         AND ${nextFireUnchanged}
         AND (next_fire_at IS NULL OR next_fire_at <= now())
      RETURNING id
    `;
    // EI-19411045952024591: record the PARK durably. `last_fired_at` above is overwritten
    // single-row state, so once a loop parks and is never re-armed there is nothing left
    // saying when it parked or who last held it — which is exactly why the 2026-08-03
    // 45min fire outage could not be diagnosed after the fact. Not awaited: this is an
    // instrument on the hot tick path and must never delay or fail a claim.
    if (rows.length > 0) {
      void recordLoopTransition(sql, {
        workspaceId: routine.workspaceId,
        installSlug: routine.installSlug,
        routineId: routine.id,
        routineName: routine.name,
        targetRole: routine.targetRole,
        targetOwnerId: routine.targetOwnerId,
        event: 'parked',
        actor: 'claim-due-routine',
        newNextFireAt: 'infinity',
        intervalSec: routine.rescheduleIntervalSec,
      });
    }
    return rows.length > 0;
  }

  // No recurrence and not a loop ⇒ a ONE-SHOT (a self-declared wake at an explicit
  // next_fire_at): claiming it DEACTIVATES it.
  if (!hasRecurrence) {
    const rows = await sql<{ id: string }[]>`
      UPDATE harness_shared.routines
         SET last_fired_at = now(),
             next_fire_at = NULL,
             active = FALSE,
             updated_at = now()
       WHERE id = ${routine.id}
         AND active = TRUE
         AND ${nextFireUnchanged}
         AND (next_fire_at IS NULL OR next_fire_at <= now())
      RETURNING id
    `;
    const claimed = rows.length > 0;
    // A plan-schedule ONE-SHOT that just auto-deactivated must ALSO un-arm its owning plan —
    // mirror disarmPlanSchedule's two-write — else the plan still reads schedule_active=true
    // ("armed") though its routine is dead and it will never fire again (EI-1371). The routine
    // name (`plan-schedule-<templateSlug>`) + target_role identify a plan-schedule routine; the
    // template slug is the name minus the prefix (cf. materialize-plan-schedule.ts
    // planScheduleRoutineName / PLAN_RUN_ACTION). pot-wake & other one-shots don't match, so they
    // never touch harness_plans.
    if (claimed && routine.targetRole === 'system:plan-run' && routine.name.startsWith('plan-schedule-')) {
      const templateSlug = routine.name.slice('plan-schedule-'.length);
      await sql`
        UPDATE harness_shared.harness_plans
           SET schedule_active = FALSE, updated_at = now()
         WHERE workspace_id = ${routine.workspaceId}
           AND harness_slug = ${await planSlugFor(routine)}
           AND plan_slug = ${templateSlug}
      `;
    }
    return claimed;
  }
  // EI-1387: a RECURRING plan-schedule routine past its owning plan's expires_at must
  // STOP firing at claim time — the Calendar (scheduled-occurrences.ts) only clamps the
  // DISPLAY window by expires_at, and neither the routines table nor computeNextFire
  // know about plan expiry, so without this check an expired recurring schedule would
  // keep advancing next_fire_at and firing forever. Deactivate instead of advancing —
  // mirroring the one-shot auto-deactivate above, including the two-write that un-arms
  // harness_plans.schedule_active (EI-1371) — and report NOT claimed so this due tick
  // does not also fire the expired occurrence. A bare cron/rrule routine that was never
  // materialized via plans:arm-schedule (name doesn't match plan-schedule-<slug>) has no
  // owning plan / expiry concept and falls straight through to the normal advance below.
  if (routine.targetRole === 'system:plan-run' && routine.name.startsWith('plan-schedule-')) {
    const templateSlug = routine.name.slice('plan-schedule-'.length);
    const planStorageSlug = await planSlugFor(routine);
    const [planRow] = await sql<{ expires_at: Date | null }[]>`
      SELECT expires_at FROM harness_shared.harness_plans
       WHERE workspace_id = ${routine.workspaceId}
         AND harness_slug = ${planStorageSlug}
         AND plan_slug = ${templateSlug}
    `;
    if (planRow?.expires_at && planRow.expires_at.getTime() <= Date.now()) {
      const rows = await sql<{ id: string }[]>`
        UPDATE harness_shared.routines
           SET last_fired_at = now(),
               next_fire_at = NULL,
               active = FALSE,
               updated_at = now()
         WHERE id = ${routine.id}
           AND active = TRUE
           AND ${nextFireUnchanged}
           AND (next_fire_at IS NULL OR next_fire_at <= now())
        RETURNING id
      `;
      if (rows.length > 0) {
        await sql`
          UPDATE harness_shared.harness_plans
             SET schedule_active = FALSE, updated_at = now()
           WHERE workspace_id = ${routine.workspaceId}
             AND harness_slug = ${planStorageSlug}
             AND plan_slug = ${templateSlug}
        `;
      }
      return false;
    }
  }

  const next = computeNextFire(cfg, new Date());
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.routines
       SET last_fired_at = now(),
           next_fire_at = ${next ? next.toISOString() : null}::timestamptz,
           updated_at = now()
     WHERE id = ${routine.id}
       AND active = TRUE
       AND ${nextFireUnchanged}
       AND (next_fire_at IS NULL OR next_fire_at <= now())
    RETURNING id
  `;
  return rows.length > 0;
}
