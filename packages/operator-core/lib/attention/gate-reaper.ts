/**
 * gate-reaper.ts — the SESSION-INDEPENDENT close path for session_pending_gates
 * (WI-10002067, migration 1185).
 *
 * THE DEFECT THIS CLOSES. Migration 619 admitted exactly two terminal reasons,
 * `tool_result_observed` and `hook_cleared`, and both are written only by
 * machinery that needs the ASKING SESSION alive to observe something
 * (`closeGate` on the hook/bulk path, `closeGateByToolUseId` on the transcript
 * watcher). Neither has a session-independent caller, so when the asker dies
 * `closed_at` stays NULL forever and the row is unreachable BY CONSTRUCTION.
 * Measured 2026-09-20: 241 open gates, 189 of them older than 14 days, the
 * oldest open since 2026-07-17 — each one rendering to the human as "a session
 * is blocked waiting on you".
 *
 * WHY A PURE DECISION CORE. `decideGateReap` takes injected inputs and returns
 * a verdict, exactly like `deriveSessionState` in presence-wakeability.ts, so
 * every rule below is unit-testable without Postgres — including the rules
 * whose whole job is to NOT close something, which an integration test can only
 * assert by absence.
 *
 * THE SAFETY RAIL THAT MATTERS. Absence of evidence is not evidence of death.
 * Measured on the live population: all 198 askers holding an open gate have NO
 * coord_presence row (presence is TTL-reaped, so every old session looks the
 * same as a dead one), and 149 of them have no adv_sessions row either (file-
 * backed clients never register one). A predicate that read "invisible ⇒ gone"
 * would therefore have closed a LIVE session's gate the moment its presence row
 * aged out. So `unknown` never closes on its own — it must also clear an
 * explicit age floor, and that floor is a parameter rather than a constant so a
 * test can pin both sides of it.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { SessionIndependentCloseReason } from './gate-store';

/**
 * What we affirmatively know about the asking session.
 *
 * `unknown` is a FIRST-CLASS verdict, not a synonym for dead: it is what the
 * liveness surfaces return for a session that is merely old. Keeping it
 * distinct from `ended` is what stops the sweep inheriting the false-positive
 * described in this module's header.
 */
export type AskerLiveness = 'live' | 'ended' | 'unknown';

/** Default age floor before an `unknown` asker is treated as gone. Chosen
 *  against the measured distribution: 189 of 241 open gates are older than
 *  this, while the newest still-plausibly-live asker's gate was ~2 days old. */
export const DEFAULT_UNKNOWN_GONE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** How fresh a presence heartbeat must be to count as `live`. */
export const DEFAULT_PRESENCE_LIVE_WINDOW_MS = 60 * 60 * 1000;

export interface GateReapInput {
  now: Date;
  openedAt: Date;
  /** Non-null means the gate already reached a terminal state. */
  closedAt: Date | null;
  /** Deadline the ASKER declared at ask time; null = no deadline. */
  decideBy: Date | null;
  /** Disposition to apply when `decideBy` passes. Null with a non-null
   *  `decideBy` means "expire it, with no default to apply". */
  defaultIfUnanswered: unknown;
  askerLiveness: AskerLiveness;
  unknownGoneAfterMs?: number;
}

export type GateReapDecision =
  | { close: true; reason: SessionIndependentCloseReason; disposition: unknown }
  | { close: false; why: GateReapSkipReason };

/**
 * Note there is deliberately NO `deadline-not-reached` member: an unreached
 * deadline is not a reason to keep a gate open, because a gate whose asker died
 * before its deadline is still unreachable. It falls through to the asker rules
 * and is reported by whichever of those actually decided. A skip counter that
 * could never increment would be misleading telemetry.
 */
export type GateReapSkipReason = 'already-closed' | 'asker-live' | 'asker-unknown-within-grace';

/**
 * Decide whether one gate may be closed without the asking session.
 *
 * Rule order is load-bearing and each step is justified:
 *
 *  1. An already-closed gate is NEVER reopened. This mirrors `openOrTouchGate`'s
 *     open-scoped ON CONFLICT and `reopenGate`'s compare-and-set: only the
 *     explicit inverse may resurrect a row, never a sweep.
 *  2. A passed `decide_by` wins even against a LIVE asker. That is not an
 *     oversight — the deadline is the asker's OWN declared contract, so
 *     honouring it is obeying the asker, not overriding it.
 *  3. A live asker is never reaped.
 *  4. An affirmatively `ended` asker is reaped.
 *  5. An `unknown` asker is reaped only past the age floor (see header).
 */
export function decideGateReap(input: GateReapInput): GateReapDecision {
  if (input.closedAt !== null) return { close: false, why: 'already-closed' };

  if (input.decideBy !== null) {
    if (input.now.getTime() >= input.decideBy.getTime()) {
      return { close: true, reason: 'default_applied', disposition: input.defaultIfUnanswered ?? null };
    }
    // An unreached deadline does NOT stop the asker-gone rules below: a gate
    // whose asker died before its deadline is still unreachable, and waiting
    // for the deadline would leave exactly the rows this work-item exists to
    // retire sitting open. Fall through.
  }

  if (input.askerLiveness === 'live') return { close: false, why: 'asker-live' };
  if (input.askerLiveness === 'ended') return { close: true, reason: 'asker_gone', disposition: null };

  const floor = input.unknownGoneAfterMs ?? DEFAULT_UNKNOWN_GONE_AFTER_MS;
  const ageMs = input.now.getTime() - input.openedAt.getTime();
  if (ageMs >= floor) return { close: true, reason: 'asker_gone', disposition: null };
  return { close: false, why: 'asker-unknown-within-grace' };
}

export interface GateSweepResult {
  /** Gates examined this tick. */
  examined: number;
  closedAskerGone: number;
  closedDefaultApplied: number;
  skipped: Record<GateReapSkipReason, number>;
  /**
   * TRUE when the fetch hit `limit` and more open gates remain.
   *
   * Reported ON THE AGGREGATE deliberately. The predecessor path got this
   * wrong in exactly the way the repo's own rule warns about: the watcher's
   * close path seeds from `listPendingGates(limit 200)`, hard-clamped
   * oldest-first, so once 241 gates had accumulated the 41 NEWEST became
   * structurally invisible to it and its "nothing left to close" was a bounded
   * measurement rendered as a total.
   */
  truncatedByLimit: boolean;
}

interface OpenGateLivenessRow {
  id: string;
  workspace_id: string;
  session_id: string;
  ref_id: string;
  opened_at: Date;
  decide_by: Date | null;
  default_if_unanswered: unknown;
  asker_liveness: AskerLiveness;
}

/**
 * Close every open gate that no longer needs its asking session.
 *
 * Requires migration 1185 (adds `decide_by` / `default_if_unanswered` and
 * widens the `closed_reason` CHECK), so this ships with it and not before.
 */
export async function sweepSessionIndependentGates(opts?: {
  now?: Date;
  unknownGoneAfterMs?: number;
  presenceLiveWindowMs?: number;
  limit?: number;
  dryRun?: boolean;
}): Promise<GateSweepResult> {
  const { sql } = getOrgPg();
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? 1000;
  const presenceWindowMs = opts?.presenceLiveWindowMs ?? DEFAULT_PRESENCE_LIVE_WINDOW_MS;

  const rows = await sql<OpenGateLivenessRow[]>`
    SELECT g.id::text            AS id,
           g.workspace_id        AS workspace_id,
           g.session_id          AS session_id,
           g.ref_id              AS ref_id,
           g.opened_at           AS opened_at,
           g.decide_by           AS decide_by,
           g.default_if_unanswered AS default_if_unanswered,
           CASE
             WHEN p.owner_id IS NOT NULL
              AND p.last_active_at > now() - (${presenceWindowMs}::bigint * interval '1 millisecond')
               THEN 'live'
             WHEN a.ended_at IS NOT NULL THEN 'ended'
             ELSE 'unknown'
           END                   AS asker_liveness
      FROM harness_shared.session_pending_gates g
      LEFT JOIN harness_shared.coord_presence p ON p.owner_id = g.session_id
      LEFT JOIN LATERAL (
        SELECT s.ended_at FROM harness_shared.adv_sessions s
         WHERE s.session_id = g.session_id
         ORDER BY s.started_at DESC LIMIT 1
      ) a ON true
     WHERE g.closed_at IS NULL
     ORDER BY g.opened_at ASC
     LIMIT ${limit + 1}
  `;

  const truncatedByLimit = rows.length > limit;
  const batch = truncatedByLimit ? rows.slice(0, limit) : rows;

  const result: GateSweepResult = {
    examined: batch.length,
    closedAskerGone: 0,
    closedDefaultApplied: 0,
    skipped: {
      'already-closed': 0,
      'asker-live': 0,
      'asker-unknown-within-grace': 0,
    },
    truncatedByLimit,
  };

  for (const row of batch) {
    const decision = decideGateReap({
      now,
      openedAt: new Date(row.opened_at),
      closedAt: null,
      decideBy: row.decide_by === null ? null : new Date(row.decide_by),
      defaultIfUnanswered: row.default_if_unanswered,
      askerLiveness: row.asker_liveness,
      unknownGoneAfterMs: opts?.unknownGoneAfterMs,
    });

    if (!decision.close) {
      result.skipped[decision.why] += 1;
      continue;
    }
    if (decision.reason === 'asker_gone') result.closedAskerGone += 1;
    else result.closedDefaultApplied += 1;

    if (opts?.dryRun) continue;

    // `closed_at IS NULL` is re-asserted here as a compare-and-set: the row was
    // read outside this statement, so a hook or watcher may have closed it in
    // between. Losing that race must be a no-op, never an overwrite of a
    // session-dependent (more specific) terminal reason.
    //
    // WI-10002067: this cast is `::bigint`, NOT `::uuid`. `session_pending_gates.id`
    // is a BIGINT; the SELECT above projects it as `g.id::text`, so `row.id` is a
    // numeric string. Casting that to uuid raises SQLSTATE 22P02 on the FIRST gate
    // that qualifies, and because this await sits inside the per-row loop with no
    // inner catch, that one throw aborts the ENTIRE sweep — which the caller's outer
    // try/catch then swallows into a log line that never reaches the journal. The
    // measured signature was: transcript-watcher closes landing normally while
    // asker_gone/default_applied stayed at exactly zero against 238 open gates.
    await sql`
      UPDATE harness_shared.session_pending_gates
         SET closed_at = ${now}, closed_reason = ${decision.reason}, updated_at = now()
       WHERE id = ${row.id}::bigint
         AND closed_at IS NULL
    `;
  }

  return result;
}
