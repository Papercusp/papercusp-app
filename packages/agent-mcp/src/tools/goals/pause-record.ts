/**
 * The goal DELIBERATE-PAUSE record — who paused this goal, when, and why
 * (goal-live-holder-guarantee-2026-08-18 P-005, D-009).
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────
 *
 * `goals.status = 'paused'` already existed, with a real fan-out behind it
 * (`stop-seam.ts` → `operator-core/lib/goals/stop-fanout.ts`): it gates
 * placement on the pots the goal owns and disarms the engine loops of sessions
 * attributed to it. What it did NOT carry is any record of the DECISION. A
 * reader sees a bare label — no timestamp of its own (`updated_at` is bumped by
 * any other edit), no author, no reason — and therefore cannot tell an owner's
 * deliberate hold from a machine fan-out, nor whether the hold is still
 * current. That is the same question D-004 asks about a deactivated goal.
 *
 * ── WHY THIS SHAPE, VERBATIM ────────────────────────────────────────────────
 *
 * This is a SOLVED problem one layer down, and the shape is copied rather than
 * reinvented. `routines:set` has persisted `metadata.pause { reason, pausedBy,
 * pausedAtMs }` on every pause since EI-18654017982759582, which existed
 * because "a routine paused during an incident with no reason/owner recorded
 * has TWICE stayed silently paused for days ... nothing durable said WHO paused
 * it or WHY, so a responder could not tell a stuck bug from a deliberate hold".
 *
 * It then failed a THIRD time (EI-19336000265007219) for the opposite reason:
 * the record was WRITTEN and never READ BACK, so the responder it was written
 * for still saw a bare `active:false`. Hence {@link readGoalPause} lands in the
 * same change as {@link stampGoalPause}, and `goals:get` surfaces it at BOTH
 * detail levels. A durable record nobody can read is not a fix — it is the same
 * silence with better bookkeeping.
 *
 * Field names are deliberately IDENTICAL to the routines record (`reason`,
 * `pausedBy`, `pausedAtMs`, and `lastPause.resumedAtMs`) so the two layers read
 * the same and a future extraction into one shared module is mechanical. D-009
 * records why that extraction is not done here: routines live in operator-core,
 * the dependency runs operator-core → agent-mcp (see `_core.ts`'s header), and
 * a shared home would mean either a cycle or a new `libs/generic` submodule.
 *
 * ── WHY IT LIVES IN agent-mcp ───────────────────────────────────────────────
 *
 * Same reason as `_core.ts` and `stop-seam.ts`: the WRITER is `goals:update`,
 * which lives here, while the READERS that matter most (the liveness watchdog,
 * P-004's derived activity read) live in operator-core and import this package.
 * Pure — node/zod only, no pg, no operator-core — so either side can hold it.
 */

/** The stored shape. `reason` is required at the write boundary, never optional. */
export interface GoalPauseRecord {
  reason: string;
  pausedBy: string;
  pausedAtMs: number;
}

/** The stored shape after a resume — the audit copy, kept under `lastPause`. */
export interface GoalLastPauseRecord extends GoalPauseRecord {
  resumedAtMs: number;
}

/**
 * The READ view: every field independently nullable, because this parses
 * whatever is actually in the jsonb rather than what we hope is there. `at` is
 * an ISO string — the stored form is epoch ms (the routines precedent), and
 * every consumer of this view renders or compares a timestamp, not a number.
 */
export interface GoalPauseView {
  reason: string | null;
  by: string | null;
  at: string | null;
}

/** The metadata key. One literal, so a writer and a reader cannot disagree. */
export const GOAL_PAUSE_KEY = 'pause';
/** The audit key a resume moves the record to. */
export const GOAL_LAST_PAUSE_KEY = 'lastPause';

function viewOf(value: unknown): GoalPauseView | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const atMs = typeof rec.pausedAtMs === 'number' ? rec.pausedAtMs : null;
  return {
    reason: typeof rec.reason === 'string' ? rec.reason : null,
    by: typeof rec.pausedBy === 'string' ? rec.pausedBy : null,
    at: atMs !== null && Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
  };
}

/**
 * Read the CURRENT pause record out of a goal's metadata, or null when the goal
 * is not paused. Mirrors `routines/list.ts`'s `pauseOf` exactly, including its
 * tolerance: a malformed or partial record still yields a view with null legs
 * rather than throwing, because a reader that crashes on bad jsonb is worse
 * than one that reports what it found.
 */
export function readGoalPause(metadata: Record<string, unknown> | null | undefined): GoalPauseView | null {
  return viewOf(metadata?.[GOAL_PAUSE_KEY]);
}

/** Read the archived record of the most recent pause that has since been resumed. */
export function readGoalLastPause(
  metadata: Record<string, unknown> | null | undefined,
): GoalPauseView | null {
  return viewOf(metadata?.[GOAL_LAST_PAUSE_KEY]);
}

/**
 * Stamp a pause onto a metadata document. PURE — returns a new object and never
 * mutates the input, so a caller can build `next` without disturbing `prev`.
 *
 * Every other metadata key is preserved by the spread. That matters: goal
 * metadata carries `spentCents`, `drainFleet`, `startedBy` and friends, all
 * written by other paths, and a pause that dropped them would be a data loss
 * bug wearing an audit-trail costume.
 */
export function stampGoalPause(
  metadata: Record<string, unknown> | null | undefined,
  opts: { reason: string; pausedBy: string; nowMs?: number },
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  const record: GoalPauseRecord = {
    reason: opts.reason,
    pausedBy: opts.pausedBy,
    pausedAtMs: opts.nowMs ?? Date.now(),
  };
  next[GOAL_PAUSE_KEY] = record;
  return next;
}

/**
 * Clear the pause, moving it to `lastPause` with a `resumedAtMs` stamp. PURE.
 *
 * Called for EVERY non-`paused` status, not just `active`: a goal that goes
 * straight from paused to `killed`/`achieved` is no longer paused either, and
 * leaving a live `pause` record on a terminal goal would have {@link
 * readGoalPause} report a hold that is over — the same false-premise state the
 * record exists to prevent, inverted.
 *
 * A no-op (returns an equivalent document) when there is nothing to clear, so
 * callers need no `if` around it.
 */
export function clearGoalPause(
  metadata: Record<string, unknown> | null | undefined,
  opts: { nowMs?: number } = {},
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  const current = next[GOAL_PAUSE_KEY];
  if (!current || typeof current !== 'object') return next;
  next[GOAL_LAST_PAUSE_KEY] = {
    ...(current as Record<string, unknown>),
    resumedAtMs: opts.nowMs ?? Date.now(),
  };
  delete next[GOAL_PAUSE_KEY];
  return next;
}

/**
 * Is this goal DELIBERATELY paused? RE-EXPORTED — the definition moved to
 * `@papercusp/operator-core`'s `lib/goals/activity.ts` (plan D-011), which is
 * where the status/liveness fold that needs it lives.
 *
 * Reaching for it from there through THIS package's barrel made operator-core's
 * cheapest pure module import the whole agent-mcp index, forming a cycle for the
 * sake of one string comparison. The re-export keeps every P-005 caller — and
 * `src/index.ts` — pointed at the same name, so the move is invisible to them.
 *
 * Note the SUBPATH import (the `create.ts:24` precedent), never the
 * `@papercusp/operator-core` root barrel: re-exporting through that barrel would
 * drag operator-core's whole index into this module — the identical weight
 * problem this move exists to remove, merely pointing the other way.
 */
export { isGoalAdministrativelyPaused } from '@papercusp/operator-core/lib/goals/activity';
