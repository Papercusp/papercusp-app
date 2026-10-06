/**
 * session-reset-continuation.ts — the CROSS-PROCESS half of "this owner's
 * SessionEnd is a scheduled continuation, not a death" (WI-6756).
 *
 * ROOT CAUSE (evidenced live 2026-08-02, su-e02f5c3d, 5 consecutive wakes):
 * a COLD loop wake delivered over `psu-socket-reset` / `psu-socket-recycle`
 * re-execs the CLI child under the SAME `ownerId`. The dying child fires the
 * ordinary SessionEnd/Stop lifecycle hook, and `activity/report.ts`'s P-002
 * fast path treats EVERY SessionEnd as a death — force-releasing every
 * work-item lease the owner holds via `releaseAllWorkItemLeasesForOwner`.
 * Because that release passes `expectedAssignee: ownerId`, the row is stamped
 * `last_released_by = <the owner itself>`, so downstream it reads as a
 * DELIBERATE release by the agent. Measured: bg-host logged
 * `wake #34295 delivered → su-e02f5c3d via psu-socket-reset` at
 * 00:03:33.186Z; dev-api logged `session-end lease release … released 2
 * item(s) [WI-5135,WI-3965]` at 00:03:33.598Z — 412ms later, every wake.
 *
 * WHY THIS IS A SEPARATE MECHANISM FROM {@link ./carry-respawn-marker}:
 * that marker solves the IDENTICAL bug class for `session:request-compaction`
 * (EI-18676518990229124) with a module-scoped in-memory `Map`, explicitly
 * justified because compaction's `injectIntoHost` and the subsequent
 * SessionEnd report "both execute in-process on the SAME operator". That
 * co-location does NOT hold for a cold loop wake: the wake is injected from
 * **papercup-bg-host.service** while the ending child's hook POSTs to
 * **papercup-dev-api.service** (confirmed from journal unit attribution). An
 * in-memory mark set by the injector is therefore invisible to the reader, so
 * this leg needs a signal that genuinely crosses the process boundary.
 *
 * WHY NO NEW TABLE / NO NEW WRITE PATH: the wake pipeline ALREADY records
 * every delivery durably in `harness_shared.event_wake_deliveries`, including
 * the `channel` that distinguishes a context-reset wake from an in-place warm
 * inject. Reading that ledger answers the exact causal question ("did a wake
 * that re-execs this owner's child just land?") from any process, with no new
 * state to keep consistent, and rides the existing
 * `idx_event_wake_deliveries_subscriber (subscriber_id, created_at DESC)`
 * index. A cache-backed marker was rejected deliberately: the L2 cache is
 * flag-gated and permitted to miss, and a correctness guard that silently
 * no-ops when a flag is off is worse than no guard.
 *
 * FAIL-SAFE BY CONSTRUCTION, in both directions:
 *  - Read throws / PG unreachable → the caller falls through to the ordinary
 *    release, i.e. exactly today's behavior. This guard can never STRAND a
 *    claim by failing.
 *  - A genuine death that happens to land inside the window keeps its claims
 *    until the P-001 scheduled backstop (`idle-session-reaper.ts`'s
 *    `runWorkItemLeaseReap`) frees them. That is the ORIGINAL pre-P-002
 *    coverage for that case — a delay, not a new gap. This is the same trade
 *    the in-memory marker already makes and is documented to accept.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { WakeChannel } from './events/await/types';

/**
 * Wake channels whose delivery DROPS THE CLI CHILD'S CONTEXT and brings the
 * same `ownerId` straight back — the deliveries whose SessionEnd is a
 * continuation. Warm channels (`psu-socket-inject` and friends) inject in
 * place without ending the session, so they never appear here: a SessionEnd
 * near a warm inject really is a death and must still release.
 *
 * ⚠ THE `-unconfirmed` VARIANTS BELONG HERE, and leaving them out silently
 * reverts WI-6756 for the COMMON case. WI-6862 split the reset/recycle
 * channels by whether the host ACKed the re-exec — but a host that simply
 * never sends an ack (any pre-WI-5872 host) books the `-unconfirmed` channel
 * for a reset that landed perfectly. This list answers "was a context reset
 * ATTEMPTED for this owner", not "did the host confirm it": omit them and the
 * `= ANY()` filter below stops matching, the SessionEnd reads as a death, and
 * every work-item lease the owner holds is force-released — the exact bug
 * WI-6756 exists to prevent.
 *
 * Over-matching is the FAIL-SAFE direction and under-matching is not: a
 * genuine death that lands in the window merely waits for the P-001 reaper
 * (documented above as an accepted delay), whereas a missed continuation
 * strips claims from a session that is still alive.
 *
 * `satisfies` pins every member to a real WakeChannel (a typo cannot compile);
 * the coverage of FUTURE reset-shaped channels is guarded by the test — tsc
 * cannot see an omission, only an invention.
 */
export const CONTEXT_RESET_WAKE_CHANNELS = [
  'psu-socket-reset',
  'psu-socket-recycle',
  'psu-socket-reset-unconfirmed',
  'psu-socket-recycle-unconfirmed',
] as const satisfies readonly WakeChannel[];

/**
 * How long after a context-reset wake its SessionEnd may still arrive.
 * Observed latency is ~0.4s; 30s is ~75x headroom for a loaded box while
 * staying well under the common 60s loop interval, so an unrelated death is
 * unlikely to fall inside a window opened by the previous fire.
 */
export const RESET_CONTINUATION_WINDOW_MS = 30_000;

export interface ResetContinuationHit {
  channel: string;
  /** When the reset wake was delivered (or created, if delivery went unstamped). */
  at: Date;
  ageMs: number;
}

/**
 * Did a context-reset wake land for `ownerId` recently enough that the
 * SessionEnd we are handling is that reset's context drop rather than a death?
 *
 * Returns the matching delivery (for logging the REASON — an unexplained
 * "release skipped" line is what made this bug take five wakes to find), or
 * null when no such wake is in the window. THROWS on a genuine PG failure so
 * the caller can decide; every caller should treat a throw as "not a
 * continuation" and proceed with the release.
 */
export async function recentContextResetWake(
  ownerId: string,
  opts: { sql?: Sql; windowMs?: number; nowMs?: number } = {},
): Promise<ResetContinuationHit | null> {
  if (!ownerId?.trim()) return null;
  const sql = opts.sql ?? getOrgPg().sql;
  const windowSec = Math.max(1, Math.round((opts.windowMs ?? RESET_CONTINUATION_WINDOW_MS) / 1000));
  const rows = await sql<Array<{ channel: string; at: Date }>>`
    SELECT w.channel, COALESCE(w.delivered_at, w.created_at) AS at
      FROM harness_shared.event_wake_deliveries w
     WHERE w.subscriber_id = ${ownerId}
       AND w.channel = ANY(${[...CONTEXT_RESET_WAKE_CHANNELS]}::text[])
       AND w.status = 'delivered'
       AND COALESCE(w.delivered_at, w.created_at) > now() - make_interval(secs => ${windowSec})
     ORDER BY w.created_at DESC
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const at = row.at instanceof Date ? row.at : new Date(row.at);
  return { channel: row.channel, at, ageMs: Math.max(0, (opts.nowMs ?? Date.now()) - at.getTime()) };
}

/**
 * Wake channels that start a ONE-TURN resume (`--resume <id> -p`) of an exited
 * session: the wake executor's channel 2, headless or in a managed pty. That
 * child exits when its single turn settles, so its SessionEnd is how `-p`
 * works, not a deliberate end of the session (WI-10005679).
 *
 * Both legs build the same env block, which carries PAPERCUSP_WAKE_DELIVERY_ID
 * (wake-executor.ts), and that id is what `isWakeResumeTurn` verifies.
 */
export const WAKE_RESUME_TURN_CHANNELS = [
  'resume',
  'resume-headless',
] as const satisfies readonly WakeChannel[];

/**
 * Is the SessionEnd we are handling the end of a one-turn wake resume?
 *
 * WI-10005679: such a child ended because `-p` ends, not because anyone ended
 * the session. The session was resumable before the turn (its standing
 * inbox-wake is what the executor resumed it from) and is exactly as
 * resumable after it. Treating that end as terminal retired the watch, so
 * every later coord:send to a recruited judge reported
 * `recipient_alive_not_wakeable`.
 *
 * Only a REAL ledger row counts: `deliveryId` comes from the child's env via
 * the lifecycle hook, so it must name a delivery to THIS owner on a one-turn
 * resume channel. No time window is applied. The id is bound to this one
 * process, and a resumed turn may legitimately run for a long time. THROWS on
 * a PG failure; callers treat a throw as "not a resume turn" and keep
 * today's cancel.
 */
export async function isWakeResumeTurn(
  ownerId: string,
  deliveryId: number | null | undefined,
  opts: { sql?: Sql } = {},
): Promise<boolean> {
  if (!ownerId?.trim()) return false;
  if (deliveryId == null || !Number.isSafeInteger(deliveryId) || deliveryId <= 0) return false;
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ one: number }>>`
    SELECT 1 AS one
      FROM harness_shared.event_wake_deliveries w
     WHERE w.id = ${deliveryId}
       AND w.subscriber_id = ${ownerId}
       AND w.channel = ANY(${[...WAKE_RESUME_TURN_CHANNELS]}::text[])
     LIMIT 1`;
  return rows.length > 0;
}
