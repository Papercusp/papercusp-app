/**
 * cold-nohost-park-guard — bound the ended-but-resumable LIMBO WINDOW of a cold
 * engine loop (EI-21431587306904888).
 *
 * THE GAP THIS CLOSES. A cold (`carry:'cold'`) loop wake refuses the Channel 2
 * `resume-headless` fallback on purpose: resuming rehydrates the predecessor
 * transcript, which defeats the fresh-context contract and can kill the session
 * outright when that transcript is already over the context ceiling (the very
 * failure the park branch was added to stop). So when the owner's psu host is
 * gone — a headless member ended by signal, its host process dead — every cold
 * fire parks with "no injectable psu host". For an ended session no host EVER
 * reappears on its own, so before this guard the loop burned fires forever and
 * the member's lane stranded silently: no self-respawn, no self-end, no leader
 * escalation. Measured live 2026-08-25: a gen-11 drain member black-holed every
 * 60s fire for ~25min until its fleet leader noticed by hand (`coord:wake` was
 * the out-of-band rescue). Once a session goes fully TERMINAL the loop already
 * self-ends (`loop-terminal-unreachable`); the ended-but-RESUMABLE window was
 * the uncovered residue.
 *
 * THE REMEDY — pause + escalate, NOT auto-respawn (owner policy, WI-2339 fix E:
 * the loop death/respawn watchdog never respawns). Each time the wake executor
 * parks an eligible cold fire for want of a host, this guard advances a streak
 * of DISTINCT consecutive undeliverable fires (keyed on the marker's
 * `wakeCount`, so parked-row RETRIES of the same fire never inflate it). At the
 * threshold (default 3 distinct fires) it:
 *   1. auto-pauses the loop (`autoPauseLoopRoutine` — the same primitive the
 *      cost-cap / dead-man / unreachable guards use; the paused state IS the
 *      notification for `loop:status` readers),
 *   2. records the terminal fire marker (`loop-terminal-unreachable`, 'error')
 *      so `loop:status` / the chronic-failure sweep read exactly the shape a
 *      terminal self-end produces and never re-escalate it as a live failure,
 *   3. opens a loud advisory escalation under LOOP_DEATH_WATCHDOG_IDENTITY with
 *      the shared `loop-death:<installSlug>:<routineId>` subjectSignature, so
 *      the existing `reconcileDeadLoopEscalations` auto-resolve leg covers it.
 *
 * WHY the standing inbox-wake await is deliberately NOT cancelled here (unlike
 * `terminateDeadLoop`'s WI-2339 fix D): the owner is ended but RESUMABLE — a
 * leader's warm `coord:wake` demonstrably recovers it via the ordinary resume
 * leg, and that recovery route rides the standing await. Cancelling it would
 * break the exact rescue the escalation asks a human/leader to perform.
 *
 * SAFETY. Fail-soft throughout: any read/write/import failure returns null and
 * the caller parks exactly as before — an uncertain read must never pause a
 * loop. A re-armed loop restarts `wakeCount` at 1, which the pure streak
 * function reads as a reset (streak := 1), so stale metadata from a prior
 * incarnation can never pre-satisfy the threshold. All IO deps are imported
 * dynamically at call time (house pattern in the wake path) so this module adds
 * no static edge into the harness/routines graph from the wake executor.
 */
import type { Sql } from 'postgres';

/** routines.metadata key holding the persisted streak. */
export const COLD_NOHOST_PARK_META_KEY = 'cold_nohost_park';

/** Distinct consecutive undeliverable cold fires before pause+escalate. */
export const DEFAULT_COLD_NOHOST_ESCALATION_FIRES = 3;

/** Threshold accessor, env-overridable; floored at 2 so a single blip never escalates. */
export function coldNoHostEscalationFires(): number {
  const env = Number(process.env.PAPERCUSP_COLD_NOHOST_ESCALATION_FIRES);
  return Number.isFinite(env) && env >= 2 ? Math.floor(env) : DEFAULT_COLD_NOHOST_ESCALATION_FIRES;
}

export interface ColdNoHostParkStreak {
  /** The marker `wakeCount` of the most recent parked fire counted. */
  lastWakeCount: number;
  /** Distinct consecutive parked fires so far (1-based). */
  streak: number;
}

/**
 * Pure streak advance. `wakeCount` is the loop fire's 1-based total-fire number
 * (stamped by loop-fire, monotone per loop incarnation, restarting at 1 on
 * re-arm). Three cases:
 *  - same fire retrying (wakeCount === prev.lastWakeCount) → streak unchanged;
 *  - the immediately-next fire also parked (prev.lastWakeCount + 1) → streak+1;
 *  - anything else (a gap ⇒ intervening fires were delivered/dropped; a smaller
 *    number ⇒ the loop was re-armed) → reset to a fresh streak of 1.
 */
export function nextColdNoHostParkStreak(
  prev: ColdNoHostParkStreak | null,
  wakeCount: number,
): ColdNoHostParkStreak {
  if (prev && wakeCount === prev.lastWakeCount) return prev;
  if (prev && wakeCount === prev.lastWakeCount + 1) {
    return { lastWakeCount: wakeCount, streak: prev.streak + 1 };
  }
  return { lastWakeCount: wakeCount, streak: 1 };
}

/** Parse the persisted metadata value defensively (absent/malformed ⇒ null). */
export function parseColdNoHostParkStreak(raw: unknown): ColdNoHostParkStreak | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { lastWakeCount?: unknown; streak?: unknown };
  const lastWakeCount = typeof o.lastWakeCount === 'number' && Number.isFinite(o.lastWakeCount) ? o.lastWakeCount : null;
  const streak = typeof o.streak === 'number' && Number.isFinite(o.streak) && o.streak >= 1 ? o.streak : null;
  if (lastWakeCount == null || streak == null) return null;
  return { lastWakeCount, streak };
}

export interface ColdNoHostParkVerdict {
  /** 'tracked' = streak advanced, below threshold — caller parks as before.
   *  'escalated' = threshold reached THIS call: loop paused + escalation opened.
   *  'already-paused' = the loop row is already inactive (a prior escalation, a
   *  loop:end, or another guard) — caller parks; nothing further to do. */
  action: 'tracked' | 'escalated' | 'already-paused';
  streak: number;
}

export interface ColdNoHostParkInput {
  /** The loop-instance routine id from the delivery marker (WI-5510). */
  routineId: string | null | undefined;
  /** The fire's 1-based total-fire number from the delivery marker. */
  wakeCount: number | null | undefined;
  /** The wake's subscriber (the loop owner) — for the escalation text. */
  subscriberId: string;
}

/**
 * Record one cold no-host park and pause+escalate at the threshold. NEVER
 * throws; returns null whenever the streak cannot be tracked (missing marker
 * fields, unknown routine, any IO failure) — the caller then parks exactly as
 * it always has.
 */
export async function recordColdNoHostParkAndMaybeEscalate(
  input: ColdNoHostParkInput,
): Promise<ColdNoHostParkVerdict | null> {
  const { routineId, wakeCount } = input;
  if (!routineId || typeof wakeCount !== 'number' || !Number.isFinite(wakeCount) || wakeCount <= 0) {
    return null;
  }
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql as Sql;
    const rows = await sql<
      Array<{
        active: boolean;
        metadata: Record<string, unknown> | null;
        install_slug: string;
        name: string | null;
        workspace_id: string;
      }>
    >`
      SELECT active, metadata, install_slug, name, workspace_id
        FROM harness_shared.routines
       WHERE id = ${routineId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const prev = parseColdNoHostParkStreak(row.metadata?.[COLD_NOHOST_PARK_META_KEY]);
    if (!row.active) return { action: 'already-paused', streak: prev?.streak ?? 0 };

    const next = nextColdNoHostParkStreak(prev, wakeCount);
    await sql`
      UPDATE harness_shared.routines
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object(
                           ${COLD_NOHOST_PARK_META_KEY}::text,
                           jsonb_build_object(
                             'lastWakeCount', ${next.lastWakeCount}::int,
                             'streak', ${next.streak}::int,
                             'updatedAt', now()::text
                           )
                         )
       WHERE id = ${routineId}
    `;

    if (next.streak < coldNoHostEscalationFires()) return { action: 'tracked', streak: next.streak };

    // Threshold reached: pause + terminal fire marker + loud escalation.
    // Each leg is individually fail-soft AFTER the pause — the pause is the one
    // write that must land for the limbo to actually end.
    const reason =
      `cold no-host limbo (EI-21431587306904888): ${next.streak} distinct consecutive cold loop fires found ` +
      `no injectable psu host for ended-but-resumable owner ${input.subscriberId} — auto-paused instead of ` +
      `parking indefinitely. To resume the work: relaunch the member (preferred — preserves the fresh-context ` +
      `boundary) or coord:wake it to warm-resume, then re-arm the loop (loop:arm).`;
    const { autoPauseLoopRoutine } = await import('../../harness/routines/loop-cost-cap');
    await autoPauseLoopRoutine(sql, routineId, reason, 'cold-nohost-park-guard');

    const { runWithWorkspace } = await import('../../workspace-als');
    try {
      const { recordFire, LOOP_TERMINAL_AUTO_PAUSE_STATUS } = await import('../../autoloop');
      await runWithWorkspace(row.workspace_id, () =>
        recordFire(row.install_slug, row.name ?? routineId, LOOP_TERMINAL_AUTO_PAUSE_STATUS, 'error'),
      );
    } catch (e) {
      console.warn(
        `[cold-nohost-park-guard] recordFire('error') failed for paused loop '${routineId}': ${e instanceof Error ? e.message : e}`,
      );
    }
    try {
      const { openEscalation } = await import('../../agent-tools/coordination/escalations');
      const { LOOP_DEATH_WATCHDOG_IDENTITY, LOOP_DEATH_SIGNATURE_PREFIX } = await import(
        '../../harness/routines/reconcile-loop-routines'
      );
      await runWithWorkspace(row.workspace_id, () =>
        openEscalation(LOOP_DEATH_WATCHDOG_IDENTITY, {
          severity: 'advisory',
          summary:
            `Cold loop '${row.name ?? routineId}' auto-paused — owner ${input.subscriberId} ended (still resumable) and ` +
            `${next.streak} consecutive cold fires found no injectable psu host.`,
          body:
            `The cold no-host park guard (EI-21431587306904888) confirmed loop '${row.name ?? routineId}' ` +
            `(routine ${routineId}, harness ${row.install_slug}, owner ${input.subscriberId}) is firing into the ` +
            `ended-but-resumable limbo window: the owner's psu host process is gone, a cold wake refuses ` +
            `resume-headless (it would rehydrate the predecessor transcript, defeating the fresh-context contract), ` +
            `and for an ended session no injectable host ever reappears on its own. The loop was AUTO-PAUSED ` +
            `(active=false) after ${next.streak} distinct undeliverable fires instead of black-holing its cadence.\n\n` +
            `This is inform-only: the watchdog does NOT auto-respawn (owner policy). To resume the work, relaunch ` +
            `the member session fresh (preferred — preserves the fresh-context boundary) or coord:wake it to ` +
            `warm-resume, then re-arm the loop (loop:arm), or reclaim its work-items.`,
          harness_slug: row.install_slug,
          meta: { subjectSignature: `${LOOP_DEATH_SIGNATURE_PREFIX}:${row.install_slug}:${routineId}` },
        }),
      );
    } catch (e) {
      console.warn(
        `[cold-nohost-park-guard] escalation failed for paused loop '${routineId}': ${e instanceof Error ? e.message : e}`,
      );
    }
    return { action: 'escalated', streak: next.streak };
  } catch {
    return null; // fail-soft: an uncertain read/write must never change park behavior
  }
}
