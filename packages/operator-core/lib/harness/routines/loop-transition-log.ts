/**
 * Append-only engine-loop transition log — EI-19411045952024591.
 *
 * WHY THIS EXISTS
 * On 2026-08-03 five live fleet members stopped receiving loop fires for ~45min. Both
 * candidate root causes were refuted with primary evidence, and the investigation then
 * dead-ended — not for lack of effort, but because the fault is UNDIAGNOSABLE with the
 * state the system keeps. The two last-fire stores (`routines.last_fired_at` and
 * `harness_shared.autoloop_state`) are BOTH overwritten single-row state, so a loop that
 * parks and is never re-armed looks identical to one that fired and was swallowed.
 *
 * This records the transitions those single-row stores overwrite: `parked` (claimed and
 * parked at the 'infinity' in-flight sentinel), `rearmed` (moved back to a concrete fire
 * time), `disarmed` (deactivated), `revived` (un-disarmed — the only transition that crosses
 * back over `active = FALSE`). The diagnostic value is in the ABSENCE — a `parked` row with
 * no subsequent `rearmed` row IS the fault, and `actor` names the last code path that
 * touched the routine.
 *
 * ⚠ `disarmed` was DECLARED here and in the `event` column comment from day one and had NO
 * EMITTER for its whole life (WI-37571) — two call sites existed, both writing `parked` or
 * `rearmed`. So this table answered "was this loop ever disarmed?" with silence for 26+
 * real disarms/day, while its own docstring promised it recorded them. That is the worst
 * shape an instrument can fail in: it does not look broken, it looks like good news. The
 * only surviving record was `routines.metadata.loop_paused_*`, which is merged with `||`
 * and therefore holds at most ONE disarm per row forever — a re-disarm silently erases its
 * predecessor, so the flap sequence that a bounded-revival ratchet exists to control was
 * exactly what could not be reconstructed.
 *
 * A `disarmed`/`revived` pair is what makes the revival rate a first-class query instead of
 * an inference over mutable state — "the guard stopped disarming people" and "the revival
 * leg never ran" are indistinguishable without it.
 *
 * INVARIANT: this is EVIDENCE, never an input to scheduling. Nothing in the fire path may
 * read it, and a write failure here must never perturb the path it reports on — the whole
 * point is an instrument that cannot break the thing it measures. Every write is
 * fire-and-forget and swallows its own errors.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import os from 'node:os';

/**
 * The loop lifecycle transitions worth a durable row.
 *
 * The `event` column is plain `text` with NO check constraint, so widening this union needs
 * no migration — but the column COMMENT is the schema's own documentation of the vocabulary,
 * so a new member belongs in both (see migration 780 for `revived`).
 */
export type LoopTransitionEvent = 'parked' | 'rearmed' | 'disarmed' | 'revived';

export interface LoopTransitionInput {
  workspaceId: string;
  installSlug: string;
  routineId: string;
  routineName?: string | null;
  targetRole?: string | null;
  targetOwnerId?: string | null;
  event: LoopTransitionEvent;
  /** The code path making the transition, e.g. 'claim-due-routine'. */
  actor: string;
  /**
   * The next_fire_at this transition WROTE. Pass the literal string 'infinity' for a park
   * (postgres-js binds it straight into timestamptz), an ISO instant for a re-arm, or null
   * for a disarm.
   */
  newNextFireAt?: string | null;
  intervalSec?: number | null;
  detail?: Record<string, unknown> | null;
}

/** The latest durable lifecycle transition for one concrete loop routine. */
export interface LoopTransitionSnapshot {
  at: string;
  event: string;
  actor: string;
  newNextFireAt: string | null;
  intervalSec: number | null;
  detail: Record<string, unknown> | null;
}

/**
 * Tri-state diagnostic read. `unknown` is deliberately distinct from `none`: the
 * transition table is an optional, fail-soft instrument during rolling deploys, so
 * an unavailable read must never be reported as evidence that no transition exists.
 */
export type LatestLoopTransitionRead =
  | { status: 'found'; transition: LoopTransitionSnapshot }
  | { status: 'none' }
  | { status: 'unknown' };

function transitionTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * Read the newest transition for the targeted loop. This is diagnostic-only and
 * fails soft for the same reason the writer does: missing/temporarily unavailable
 * instrumentation must not make `loop:status` itself fail.
 */
export async function readLatestLoopTransition(
  input: {
    workspaceId: string | null | undefined;
    installSlug: string;
    routineName: string;
    targetOwnerId: string;
  },
  opts: { sql?: Sql } = {},
): Promise<LatestLoopTransitionRead> {
  if (!input.workspaceId || !input.installSlug || !input.routineName || !input.targetOwnerId) {
    return { status: 'unknown' };
  }
  const sql = opts.sql ?? getOrgPg().sql;
  try {
    const rows = await sql<
      Array<{
        at: Date | string | null;
        event: string | null;
        actor: string | null;
        new_next_fire_at: Date | string | null;
        interval_sec: string | number | null;
        detail: unknown;
      }>
    >`
      SELECT t.at, t.event, t.actor, t.new_next_fire_at, t.interval_sec, t.detail
        FROM harness_shared.routines r
        JOIN LATERAL (
          SELECT at, event, actor, new_next_fire_at, interval_sec, detail
            FROM harness_shared.routine_loop_transitions
           WHERE workspace_id = r.workspace_id
             AND routine_id = r.id
           ORDER BY at DESC
           LIMIT 1
        ) t ON TRUE
       WHERE r.workspace_id = ${input.workspaceId}
         AND r.install_slug = ${input.installSlug}
         AND r.name = ${input.routineName}
         AND r.target_owner_id = ${input.targetOwnerId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { status: 'none' };
    const at = transitionTimestamp(row.at);
    if (!at || !row.event || !row.actor) return { status: 'unknown' };
    const interval = row.interval_sec == null ? NaN : Number(row.interval_sec);
    const detail =
      row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
        ? (row.detail as Record<string, unknown>)
        : null;
    return {
      status: 'found',
      transition: {
        at,
        event: row.event,
        actor: row.actor,
        newNextFireAt: transitionTimestamp(row.new_next_fire_at),
        intervalSec: Number.isFinite(interval) ? interval : null,
        detail,
      },
    };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * How long a transition row is retained. A loop cycle writes 2 rows (park + re-arm), so a
 * ~20-loop fleet at mixed intervals produces low tens of thousands of rows/day — cheap to
 * keep for a forensic window, pointless to keep forever. Env-overridable, floored at 1 day
 * so a misconfigured value can never disable the very evidence this table exists to hold.
 */
export function transitionRetentionDays(): number {
  const n = Number(process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS ?? 7);
  return Number.isFinite(n) && n >= 1 ? n : 7;
}

/** Throttle gate for the piggybacked prune — same shape as autoloop's maybePruneStaleFireState. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAtMs = 0;

/**
 * Set once the table is observed to be absent (PG 42P01 undefined_table).
 *
 * The migration and the code that writes to it deploy on SEPARATE schedules, and the code
 * routinely lands first — so without this, a perfectly healthy operator would emit one warn
 * per park AND per re-arm, at loop cadence, across every loop, until the migration applied.
 * That is a log flood generated BY an instrument whose entire purpose is to make a quiet
 * failure legible; it would bury the signal it exists to surface. Warn ONCE, then go quiet
 * for the process — the next boot re-probes, so an applied migration self-heals with no
 * intervention. Deliberately NOT a general error latch: a transient write failure must keep
 * warning, because that one is worth seeing every time.
 */
let tableMissing = false;

/** Test seam: reset the prune throttle so a test can observe the prune deterministically. */
export function __resetPruneThrottleForTest(): void {
  lastPruneAtMs = 0;
  tableMissing = false;
}

/**
 * Retire transition rows past the retention window. Piggybacked on the write path (the
 * established autoloop F6 hygiene pattern) so the table self-maintains WITHOUT adding a
 * new scheduled routine — deliberately reusing that mechanism rather than introducing a
 * second one. Time-gated and fire-and-forget: adds no per-transition cost in the common
 * case and can never block or fail a transition.
 */
function maybePrune(sql: Sql, nowMs: number): void {
  if (nowMs - lastPruneAtMs < PRUNE_INTERVAL_MS) return;
  lastPruneAtMs = nowMs;
  const days = transitionRetentionDays();
  void (async () => {
    try {
      await sql`
        DELETE FROM harness_shared.routine_loop_transitions
         WHERE at < now() - ${`${days} days`}::interval
      `;
    } catch {
      // Hygiene only — a failed prune is never worth a log line on the fire path.
    }
  })();
}

/**
 * Append one loop transition. Fire-and-forget by construction: returns a promise that
 * always resolves, and callers on the hot fire path should NOT await it (see the two
 * call sites in claim.ts / reconcile-loop-routines.ts).
 */
export async function recordLoopTransition(sql: Sql, input: LoopTransitionInput): Promise<void> {
  if (tableMissing) return;
  try {
    await sql`
      INSERT INTO harness_shared.routine_loop_transitions
        (workspace_id, install_slug, routine_id, routine_name, target_role, target_owner_id,
         event, actor, new_next_fire_at, interval_sec, detail, host)
      VALUES (
        ${input.workspaceId},
        ${input.installSlug},
        ${input.routineId},
        ${input.routineName ?? null},
        ${input.targetRole ?? null},
        ${input.targetOwnerId ?? null},
        ${input.event},
        ${input.actor},
        ${input.newNextFireAt ?? null}::timestamptz,
        ${input.intervalSec ?? null},
        ${input.detail ? JSON.stringify(input.detail) : null}::jsonb,
        ${os.hostname()}
      )
    `;
    maybePrune(sql, Date.now());
  } catch (e) {
    // Fail-soft: the instrument must never break the fire path it measures. A missing
    // transition row degrades diagnosis; a thrown error here would degrade scheduling.
    if ((e as { code?: string } | null)?.code === '42P01') {
      tableMissing = true;
      console.warn(
        '[loop-transition-log] harness_shared.routine_loop_transitions is absent (migration 745 not yet applied) — ' +
          'loop transition recording is DISABLED for this process and will resume after the next restart once the ' +
          'migration lands. Loop scheduling is unaffected.',
      );
      return;
    }
    console.warn(
      `[loop-transition-log] record failed (${input.event}/${input.actor}/${input.routineId}):`,
      e instanceof Error ? e.message : e,
    );
  }
}
