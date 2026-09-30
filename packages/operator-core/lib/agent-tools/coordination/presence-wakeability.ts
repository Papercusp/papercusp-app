/**
 * presence-wakeability.ts — the coord:presence "can a coordinator actually hand
 * this agent work right now?" signals (fleet-dispatch-wake-clarity-2026-06-22
 * P-001 / D-001).
 *
 * Two derived, near-free per-agent signals turn the roster from "who's alive"
 * (the misleading `active:17`-that's-really-6 count a coordinator can't act on)
 * into "who can take work":
 *
 *   - wakeable    — there is a LIVE `coord:inbox-wake:<id>` standing await, so an
 *                   events:emit / coord:dispatch WILL deliver a wake. This is the
 *                   authoritative woken:1-vs-woken:0 signal: a cleanly-ended or
 *                   reaped session has cancelled its await (cancelInboxWakeAwaits)
 *                   → not wakeable → a wake reaches nobody (relaunch only).
 *   - sessionState — live | parked | draining | suspect | ended:
 *       ended  = NOT wakeable (no live await; the dead/zombie row — never wake it,
 *                it needs a relaunch).
 *       live   = wakeable AND a turn is running right now (fresh heartbeat AND a
 *                recent agent_activity turn with NO trailing '■ session ended').
 *       parked   = wakeable but not running (between turns) — the ideal dispatch
 *                  target: a wake resumes it.
 *       draining = heartbeat is stale but a wake-await remains; the session may
 *                  be winding down and must not count as a healthy member.
 *       suspect  = a local process is confirmed gone (or the hard stale ceiling
 *                  fired) while claims may still need reconciliation.
 *
 * Why the live-vs-parked split needs the agent_activity end-marker (the crux of
 * D-001): heartbeat LAGS. An su session ENDS (its process exits) right after it
 * announces "ready", yet its `heartbeat_at` reads fresh for up to PRESENCE_STALE_MS
 * — so the heartbeat-only `stale` flag reports a just-ended session as "active"
 * (exactly the confusion this plan fixes). The `■ session ended` lifecycle marker
 * is the crisp instant signal that the turn is over even while the heartbeat is
 * still warm.
 *
 * STORE MAXIMAL, READ MINIMAL: four batch queries keyed by the roster's ownerIds
 * (a constant per read, never per-agent). `deriveSessionState` is pure (unit
 * tested); `fetchWakeability` is the IO seam. The caller treats it best-effort —
 * a query failure degrades the roster to today's behavior (no wakeable /
 * sessionState fields) and NEVER breaks the presence read.
 */

import { getOrgPg } from '@papercusp/db-org';
// Source the CONSTANT from the pure package, not the local './presence' re-export:
// './presence' constructs a PgPresenceStore at module load, so unit tests blanket-mock
// it — and a factory that omits this constant made line 88's top-level read throw
// "No PRESENCE_STALE_MS export is defined on the mock", crashing COLLECTION in ~16
// unrelated suites (WI-39450 gate reds). The pure module has no side effects, so it is
// unaffected by that mock. Matches recipient-resolve/audience-host/federated-presence.
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import { COORD_INBOX_WAKE_PREFIX } from './inbox-wake';
import { SESSION_END_MARKER } from '../activity/lifecycle-markers';
import { WAKE_TURN_CHANNELS } from '../../events/await/types';

/**
 * Coordinator-facing session state.
 *   live     — a turn is running now (wakeable + recent activity).
 *   parked   — wakeable but idle (the ideal coord:dispatch target).
 *   draining — stale heartbeat but still wakeable; wind-down/reconciliation.
 *   suspect  — process is confirmed gone while claims may still be held.
 *   ended    — NOT wakeable, no authoritative liveness signal → dead, relaunch.
 *   recorded — authoritatively LIVE per the session log (`adv_sessions.ended_at
 *              IS NULL`) but not (yet) inbox-wake-dispatchable. The state of a
 *              session surfaced from the session log that has not self-registered
 *              a coord await — every console/autonomous agent, and any
 *              interactive session in its launch→first-await window. Distinct
 *              from `ended`: it is alive, just not coord-wakeable
 *              (presence-derive-from-session-log-2026-06-22 P-001).
 */
export type SessionState = 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded';

/**
 * PURE: whether a liveness read is too ambiguous to use for a takeover.
 * Draining means the heartbeat is stale while an inbox wake is still armed;
 * suspect means the process signal is gone while claims may still need
 * reconciliation. Both need a fresh required wake before a coordinator
 * assumes the owner is dead or alive. null means liveness was not derived.
 */
export function needsLivenessConfirmation(
  sessionState: SessionState | null | undefined,
): boolean | null {
  if (sessionState == null) return null;
  return sessionState === 'draining' || sessionState === 'suspect';
}

/** The raw per-agent signals `deriveSessionState` consumes. */
export interface WakeabilitySignals {
  /** A live `coord:inbox-wake:<id>` standing await exists → emit will deliver a wake. */
  wakeable: boolean;
  /** A turn is running now: recent activity with no trailing session-end marker. */
  liveTurn: boolean;
  /**
   * A durable, terminal wake attempt completed recently and no recorded
   * activity followed it. This is deliberately separate from `liveTurn`: queued,
   * parked, or still-delivering rows are not a confirmed miss.
   */
  wakeAttemptMiss?: boolean;
  /**
   * Epoch-ms of this owner's most recent agent_activity or attributed tool
   * invocation, or null when neither exists inside ACTIVITY_LOOKBACK_WINDOW_MS.
   * Distinct from `liveTurn`, which is a 10-minute boolean: this is the raw
   * age the ACTIVITY-clock ceilings below need (EI-21356812816484561).
   */
  lastActivityMs?: number | null;
}

/**
 * PURE: a terminal wake attempt is a pickup miss only when the activity
 * watermark has not advanced past the attempt. Missing activity is affirmative
 * absence; an unparseable activity timestamp is unknown and therefore fails
 * closed so a force-reclaim cannot be authorized from corrupt telemetry.
 */
export function isConfirmedWakeAttemptMiss(
  attemptAtMs: number | null | undefined,
  lastActivityAtMs: number | null | undefined,
): boolean {
  if (attemptAtMs == null || !Number.isFinite(attemptAtMs)) return false;
  if (lastActivityAtMs == null) return true;
  if (!Number.isFinite(lastActivityAtMs)) return false;
  return lastActivityAtMs <= attemptAtMs;
}

/** "Recent turn" window for the liveTurn signal — matches the presence stale
 *  window so the two liveness clocks stay aligned. */
export const LIVE_TURN_WINDOW_MS = PRESENCE_STALE_MS;

/**
 * How far back a MISSED WAKE stays visible as evidence (EI-21356139961831796).
 *
 * Deliberately much longer than LIVE_TURN_WINDOW_MS, because the two windows
 * answer different questions. "Is a turn in flight?" is inherently a recent
 * question — 10 minutes. "Did the wake we sent ever produce a turn?" does not
 * decay: an owner woken 6 hours ago that has taken no turn since is exactly as
 * un-dispatchable now as it was a minute after the attempt.
 *
 * Sharing one window made the miss evidence expire after 10 minutes, so a
 * warm-dead owner silently became a `parked` dispatch target again and was
 * re-selected on the next routing pass — the loop this constant breaks. The
 * bound exists only to keep the query cheap (it is indexed by
 * subscriber_id + event_key), not because the evidence goes stale.
 */
export const WAKE_MISS_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the activity clock reads. `agent_activity` is retained for
 * seven days, so the liveness query must cover that same bounded horizon:
 * otherwise a heartbeat-fresh owner whose last turn is older than the
 * wake-miss window becomes indistinguishable from a brand-new owner and
 * incorrectly falls through to `parked`.
 */
export const ACTIVITY_LOOKBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * WARM-IDLE band (EI-21356812816484561): heartbeat fresh, but no turn for this
 * long. Mirrors `WARM_IDLE_ACTIVITY_STALE_MS` in release-force-guard.ts, which
 * has run this exact predicate in production since EI-18712366018708650.
 *
 * Reported, NEVER fatal. Crossing it does not change `sessionState`: an owner
 * can be legitimately parked for hours waiting on a peer, and a wake would land
 * fine. It is surfaced so routers can DE-PRIORITISE rather than mis-declare —
 * measured 2026-08-24: 107 of 180 heartbeat-fresh rows sat in this band, every
 * one of them offered to dispatch as an equal-footing `parked` candidate.
 */
export const WARM_IDLE_ACTIVITY_MS = 3 * PRESENCE_STALE_MS;

/**
 * The ACTIVITY-clock dead ceiling (EI-21356812816484561) — the counterpart to
 * `PRESENCE_DEAD_MS`, which only ever watched the HEARTBEAT clock and so could
 * see a process that DIED but never one that is alive with a wedged agent loop.
 *
 * Deliberately 12× the warm-idle band rather than equal to it, because the two
 * mistakes cost different amounts. `PRESENCE_DEAD_MS` can be aggressive (30m)
 * since a cold heartbeat means the process is GONE, so a wrong call costs one
 * spawn. Here the process is ALIVE: a wrong `ended` spawns a DUPLICATE agent
 * beside a working one, and it is self-fulfilling — a parked owner's activity
 * is only old because nobody woke it, and `ended` makes peers stop trying.
 *
 * 6h is past any legitimate park this system produces (loop intervals clamp to
 * 1h; `events:await` timeouts are minutes). It is also the SECOND line of
 * defence, not the first: `wakeAttemptMiss` already catches the precise
 * "we woke it and it did not answer" case at any age, so this timer only has
 * to catch the tail nobody has tried to wake — where declaring `ended` changes
 * nothing about who was waking it, and only stops fresh routing offering it.
 * Measured 2026-08-24: 32 of 180 rows, vs 107 at the warm-idle band.
 */
export const ACTIVITY_DEAD_MS = 6 * 60 * 60 * 1000;

/** PURE: is the last turn older than the ACTIVITY dead ceiling? Conservative on
 *  missing data — a null last-activity returns FALSE, because "no activity row
 *  inside the evidence window" is also what a brand-new session looks like. */
export function isActivityDead(lastActivityAtMs: number | null | undefined, nowMs: number): boolean {
  if (lastActivityAtMs == null || !Number.isFinite(lastActivityAtMs)) return false;
  return nowMs - lastActivityAtMs > ACTIVITY_DEAD_MS;
}

/**
 * The DEAD ceiling (fleet-liveness-zombie-await-2026-07-07). A heartbeat cold
 * beyond this is authoritative-dead REGARDLESS of a lingering wake-await.
 *
 * Why this is needed: `wakeable` (a live `coord:inbox-wake:<id>` await) is the
 * gate for `ended`, on the assumption that a session cancels its await when it
 * stops (cancelInboxWakeAwaits). But an ABRUPT death — a host reboot, an OOM
 * kill, a SIGKILL — skips that cleanup, so the await OUTLIVES the process. Such
 * a dead session then reads `wakeable:true` forever and `deriveSessionState`
 * pins it to `parked` ("the ideal dispatch target") with an hour-cold heartbeat
 * — the invisible-dead-fleet bug (a whole fleet, killed by a reboot, still
 * counted as live members). The 3-state model had NO time-based backstop: the
 * `stale` flag only downgraded `live`→`parked`, never forced `ended`.
 *
 * 3× PRESENCE_STALE_MS = 30m, matching the parked-claim reclaim grace
 * (STALE_CLAIM_PARKED_GRACE_MS / reclaimParkedGraceMs): past 30m a parked
 * holder's CLAIMS are already reclaimed, so treating its SESSION as ended at the
 * same threshold is consistent policy, not a new one. A genuinely parked+idle
 * member in an active fleet is dispatched well inside 30m; if it has been cold
 * 30m it is done or dead, and `ended` (→ relaunch) is the safe read — the
 * asymmetry favours it (a needless relaunch costs one spawn; a mis-`parked`
 * zombie costs an invisible dead fleet). A `recorded` (session-log-authoritative)
 * row is classified before this path, so it is never force-ended by heartbeat.
 */
export const PRESENCE_DEAD_MS = 3 * PRESENCE_STALE_MS;

/**
 * PURE: is a heartbeat cold beyond the DEAD ceiling? Conservative on missing
 * data — a null/unparseable timestamp returns FALSE (only force-end when we
 * AFFIRMATIVELY know a heartbeat has been cold > PRESENCE_DEAD_MS), so a
 * transiently-absent heartbeat on a fresh row is never mistaken for death.
 */
export function isHardStale(heartbeatAtMs: number | null | undefined, nowMs: number): boolean {
  if (heartbeatAtMs == null || !Number.isFinite(heartbeatAtMs)) return false;
  return nowMs - heartbeatAtMs > PRESENCE_DEAD_MS;
}

/**
 * PURE: the coordinator-facing session state from the raw signals. Order
 * matters — `pidConfirmedDead` (WI-3898 P1: a local `kill(pid, 0)` probe that
 * came back ESRCH — see `probeProcessLiveness` in presence.ts) is authoritative
 * FIRST: it is a DIRECT OS-level observation that the process is gone, not a
 * timing heuristic, so it beats even `hardStale`'s 30-minute wait — a locally
 * co-located dead agent is detected in ~seconds instead of up to 30 minutes.
 * Then `hardStale` (a zombie await from an abrupt death can't outvote an
 * hour-cold heartbeat, see PRESENCE_DEAD_MS). THEN — before wakeability gates
 * anything — a turn genuinely IN FLIGHT wins: a session with `liveTurn` (recent
 * `agent_activity` and NO trailing `■ session ended` marker) is demonstrably
 * alive and is `live`, EVEN WHEN it is not wakeable. Only a non-wakeable session
 * with NO live turn (cleanly ended: the end-marker cancelled activity, or an idle
 * session that never registered / already cancelled its await) is `ended`. Then a
 * stale but wakeable session is `draining`, else `parked` (wakeable but idle — the
 * dispatch target). A confirmed-dead owner with claims remains `suspect` until
 * claim cleanup runs; one with no claims is `ended`.
 *
 * EI-12699: wakeability and liveness are ORTHOGONAL axes and must not be
 * conflated. A `cup:spawn`'d one-turn bee (invoke-once.ts) doing agentic build
 * work never registers a `coord:inbox-wake:<id>` await, so `wakeable:false` — yet
 * it is very much alive mid-turn. The old `!wakeable ⇒ ended` short-circuit fired
 * AHEAD of the liveTurn check and served a self-contradictory row (`ended` +
 * `wakeable:false` while `lastActiveSecAgo` was seconds), so peers' `wake:'required'`
 * reported `recipient_dead` and black-holed messages into a LIVE agent (and
 * manufactured false "the bee died / was reaped" root causes). `wakeable` stays its
 * own emitted field, so the honest read for such a bee is now `live` + `wakeable:false`
 * — "alive and working, but a wake won't land; retry or use a durable surface (the
 * work-item checkpoint)", never "this agent is gone".
 *
 * Injected inputs so the boundary unit-tests without PG. `hardStale`/`pidConfirmedDead`
 * default to false/undefined, so a caller that doesn't compute them keeps prior
 * behavior unchanged.
 */
export function deriveSessionState(input: {
  stale: boolean;
  wakeable: boolean;
  liveTurn: boolean;
  hardStale?: boolean;
  /** WI-3898 P1: `probeProcessLiveness(...) === false` for a row whose `host`
   *  matched the reader's own machine — a confirmed-gone OS process. `null`
   *  (inconclusive: remote host, no pid ever recorded, or EPERM) or `undefined`
   *  (not probed) must NEVER be passed here as `true` — only an affirmative
   *  ESRCH result may. */
  pidConfirmedDead?: boolean;
  /**
   * A wake was AFFIRMATIVELY attempted on this owner and NO activity followed
   * it (`isConfirmedWakeAttemptMiss` above). This is direct evidence about
   * dispatchability rather than a timing heuristic: we did the thing that is
   * supposed to start a turn, and no turn started.
   *
   * Conservative by construction — it is only ever true when an attempt
   * timestamp EXISTS, so a never-woken idle session is unaffected, and it goes
   * false the moment activity postdates the attempt. Never pass a "we did not
   * check" as `true`.
   */
  wakeAttemptMiss?: boolean;
  /**
   * The last turn is older than ACTIVITY_DEAD_MS while the process still
   * heartbeats (EI-21356812816484561) — a wedged agent loop nobody has tried to
   * wake. Same conservative contract as `hardStale`: only ever pass an
   * affirmative measurement, never "we did not look".
   */
  activityDead?: boolean;
  /** The owner still has a plan/work-item claim that cleanup must reconcile. */
  claimsHeld?: boolean;
}): SessionState {
  if (input.pidConfirmedDead || input.hardStale) return input.claimsHeld ? 'suspect' : 'ended';
  // EI-12699: a turn genuinely IN FLIGHT (recent activity, no end-marker) means
  // the session is ALIVE and is NEVER `ended`, even when it is not
  // inbox-wake-dispatchable — a fresh liveTurn is `live`; the rare
  // stale-heartbeat-but-recently-active combo is `draining` (confirm before
  // assuming dead), never a flat `ended`. This must precede the `!wakeable ⇒
  // ended` gate, which otherwise mislabels a live-but-not-wakeable one-turn bee
  // (invoke-once.ts) as dead and serves a self-contradictory row (`ended` while
  // lastActiveSecAgo is seconds).
  if (input.liveTurn) return input.stale ? 'draining' : 'live';
  // WARM-DEAD (EI-21356139961831796). `hardStale` above is the time-based
  // backstop for a lingering wake-await, but it is keyed on the HEARTBEAT
  // clock, so it only catches a process that DIED. A process that is alive and
  // heartbeating while its agent loop is wedged keeps `hardStale` false and
  // `wakeable` true forever, and fell through to `parked` — the docstring's
  // "ideal dispatch target". Measured case: pid alive 22h54m, heartbeat 7s
  // fresh, last turn 21h25m ago, two delivered wakes and zero turns, still
  // scored the top consult responder.
  //
  // A confirmed wake MISS settles it without a new timer: we already did the
  // thing that starts a turn and nothing started, so this owner is not a
  // dispatch target whatever its heartbeat says. Placed AFTER `liveTurn` so an
  // in-flight turn always wins — the two cannot disagree, since
  // `isConfirmedWakeAttemptMiss` is false whenever activity postdates the
  // attempt. `claimsHeld` mirrors the `hardStale` line: claims outlive the
  // session until cleanup reconciles them.
  //
  // This also removes a live contradiction: release-force-guard.ts already
  // reads this exact signal as not-live (`live = … && !wakeAttemptMiss`) for
  // the highest-stakes call it makes — force-releasing a peer's claim — while
  // the shared oracle behind consult routing, coord:dispatch, fleet:assignments
  // and coord:roster was calling the same owner the best available target.
  if (input.wakeAttemptMiss) return input.claimsHeld ? 'suspect' : 'ended';
  // EI-21356812816484561: the ACTIVITY-clock counterpart to `hardStale`, for the
  // owner nobody has tried to wake (so there is no miss to observe) but whose
  // agent loop has produced nothing for ACTIVITY_DEAD_MS while the process kept
  // heartbeating. Also placed after `liveTurn`, for the same reason.
  if (input.activityDead) return input.claimsHeld ? 'suspect' : 'ended';
  if (!input.wakeable) return 'ended';
  if (input.stale) return 'draining';
  return 'parked';
}

/**
 * PURE: force `intentStale` TRUE the instant `sessionState` is confirmed
 * non-live (`parked` | `draining` | `suspect` | `ended`), overriding the 30-minute activity heuristic
 * (INTENT_STALE_SEC in presence-tier1.ts) — EI-9262.
 *
 * The gap: a killed/exited agent's `sessionState` flips to `parked`/`ended`
 * (via wakeability + the hardStale ceiling above) LONG before its
 * `lastActiveSecAgo` crosses the 30-minute `intentStale` threshold — the real
 * repro was `state: parked` at ~10 minutes cold. A reader that trusts
 * `intentStale` alone (rather than cross-checking `sessionState`) sees a
 * fresh-looking declared intent ("P-016: …") for an agent that is no longer
 * taking turns, and can be misled into standing down a takeover that should
 * proceed, or into thinking dead work is still being handled.
 *
 * `sessionState` is the higher-fidelity, faster-converging signal (a live
 * inbox-wake await + a recent-activity end-marker, vs. a flat 30-minute
 * clock), so the moment it says NOT live, the declared intent must read as
 * unreliable too — collapsing the exposure window from up to 30 minutes down
 * to `sessionState`'s own (much smaller) computation lag. `recorded` is left
 * alone: it means authoritatively-live-per-session-log (not yet
 * inbox-registered), not idle/dead, and its `intent` is always the empty
 * synthesized placeholder anyway.
 */
export function overrideIntentStaleForSessionState(
  intentStale: boolean | null,
  sessionState: SessionState | null,
): boolean | null {
  if (sessionState === 'parked' || sessionState === 'draining' || sessionState === 'suspect' || sessionState === 'ended') return true;
  return intentStale;
}

/**
 * IO seam: two batch queries keyed by `ownerIds` (the LOCAL roster — federated
 * `fed:…` ids never match these local tables, so passing them just wastes a
 * comparison; the caller omits them and treats federated rows as state-unknown).
 *
 *  1. wakeable — owners with a live standing `coord:inbox-wake:<id>` await. The
 *     await store keys these `event_key = COORD_INBOX_WAKE_PREFIX || subscriber_id`
 *     (one per agent, partial-unique index); a row that is unfired, uncancelled,
 *     and unexpired means a `{wake:true}` send / coord:dispatch will deliver.
 *  2. liveTurn — per owner, the most-recent activity within LIVE_TURN_WINDOW_MS is
 *     NOT (or is after) the most-recent `■ session ended` lifecycle marker. The
 *     recency window + the end-marker together separate a turn-in-flight from a
 *     just-ended-but-still-warm session.
 *  3. wakeAttemptMiss — per owner, a recent terminal delivery on a turn-burning
 *     wake channel whose attempt timestamp is not followed by agent activity.
 *     Pending/parked/delivering rows and no-turn channels are intentionally
 *     excluded: queueing is not pickup, and settlement without a turn is not a
 *     confirmed wake attempt.
 */
export async function fetchWakeability(
  ownerIds: string[],
  sqlOverride?: ReturnType<typeof getOrgPg>['sql'],
): Promise<Map<string, WakeabilitySignals>> {
  const out = new Map<string, WakeabilitySignals>();
  if (ownerIds.length === 0) return out;
  const sql = sqlOverride ?? getOrgPg().sql;
  const windowSec = Math.max(1, Math.round(LIVE_TURN_WINDOW_MS / 1000));
  // EI-21356139961831796: the wake-miss comparison needs a LONGER horizon than
  // liveTurn (see WAKE_MISS_EVIDENCE_WINDOW_MS). Both the attempts AND the
  // activity lookup widen together — widening only the attempts side would
  // manufacture FALSE misses, because isConfirmedWakeAttemptMiss treats a null
  // last-activity as "no turn since the attempt", and a turn 20 minutes ago
  // reads as null through a 10-minute window. liveTurn keeps its own 10-minute
  // meaning via the explicit recency check below.
  const missWindowSec = Math.max(windowSec, Math.round(WAKE_MISS_EVIDENCE_WINDOW_MS / 1000));
  const activityWindowSec = Math.max(windowSec, Math.round(ACTIVITY_LOOKBACK_WINDOW_MS / 1000));
  const nowMs = Date.now();

  const [wake, turns, attempts, toolCalls] = await Promise.all([
    sql<{ subscriber_id: string }[]>`
      SELECT DISTINCT subscriber_id
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ANY(${ownerIds}::text[])
         AND event_key = ${COORD_INBOX_WAKE_PREFIX} || subscriber_id
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())`,
    sql<{ owner_id: string; last_any: string | null; last_end: string | null }[]>`
      SELECT owner_id,
             max(created_at) AS last_any,
             max(created_at) FILTER (WHERE kind = 'lifecycle' AND summary = ${SESSION_END_MARKER}) AS last_end
        FROM harness_shared.agent_activity
       WHERE owner_id = ANY(${ownerIds}::text[])
         AND created_at > now() - make_interval(secs => ${activityWindowSec})
       GROUP BY owner_id`,
    sql<{ owner_id: string; attempt_at: string | null }[]>`
      SELECT owner_id, max(attempt_at) AS attempt_at
        FROM (
          SELECT subscriber_id AS owner_id,
                 max(COALESCE(delivered_at, created_at)) AS attempt_at
            FROM harness_shared.event_wake_deliveries
           WHERE subscriber_id = ANY(${ownerIds}::text[])
             AND event_key = ${COORD_INBOX_WAKE_PREFIX} || subscriber_id
             AND status IN ('delivered', 'dropped', 'dead')
             AND (
               status IN ('dropped', 'dead')
               OR channel = ANY(${WAKE_TURN_CHANNELS as unknown as string[]}::text[])
             )
             AND COALESCE(delivered_at, created_at) > now() - make_interval(secs => ${missWindowSec})
           GROUP BY subscriber_id
          UNION ALL
          SELECT subscriber_id AS owner_id,
                 max(attempted_at) AS attempt_at
            FROM harness_shared.event_wake_attempts
           WHERE subscriber_id = ANY(${ownerIds}::text[])
             AND event_key = ${COORD_INBOX_WAKE_PREFIX} || subscriber_id
             AND attempted_at > now() - make_interval(secs => ${missWindowSec})
           GROUP BY subscriber_id
       ) AS evidence
      GROUP BY owner_id`,
    // Codex turns can emit tool_invocations without a newer agent_activity row.
    // invoked_at is stamped at dispatch-settle time with coord_owner_id; this is
    // the same per-owner freshness source already used by fleet presence.
    sql<{ owner_id: string; last_tool_call_at: Date | string | null }[]>`
      SELECT coord_owner_id AS owner_id, max(invoked_at) AS last_tool_call_at
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ANY(${ownerIds}::text[])
         AND invoked_at > now() - make_interval(secs => ${activityWindowSec})
       GROUP BY coord_owner_id`,
  ]);

  const wakeSet = new Set(wake.map((r) => r.subscriber_id));
  const turnByOwner = new Map(turns.map((r) => [r.owner_id, r]));
  const attemptByOwner = new Map(attempts.map((r) => [r.owner_id, r]));
  const toolCallByOwner = new Map(toolCalls.map((r) => [r.owner_id, r]));
  for (const id of ownerIds) {
    const t = turnByOwner.get(id);
    const lastAny = t?.last_any ? Date.parse(t.last_any) : null;
    const lastEnd = t?.last_end ? Date.parse(t.last_end) : null;
    const toolCallAt = toolCallByOwner.get(id)?.last_tool_call_at;
    const lastToolCall =
      toolCallAt == null
        ? null
        : toolCallAt instanceof Date
          ? toolCallAt.getTime()
          : Date.parse(toolCallAt);
    const activityTimes = [lastAny, lastToolCall].filter(
      (time): time is number => time != null && Number.isFinite(time),
    );
    const lastActivity = activityTimes.length > 0 ? Math.max(...activityTimes) : null;
    // A turn is in flight when there is recent activity AND it is not (only) the
    // trailing session-end marker — i.e. no end-marker, or activity after it.
    // Combine agent_activity and owner-attributed tool calls so native Codex
    // tool turns stay live when they do not emit a newer activity row.
    // EI-21356139961831796: the activity query now spans the (much longer)
    // miss-evidence window, so liveTurn MUST assert its own recency explicitly
    // — otherwise an owner whose last turn was hours ago would satisfy
    // "activity exists, no trailing end-marker" and read `live`. This check
    // restores exactly the previous 10-minute meaning.
    const liveTurn =
      lastActivity != null &&
      nowMs - lastActivity <= LIVE_TURN_WINDOW_MS &&
      (lastEnd == null || Number.isNaN(lastEnd) || lastActivity > lastEnd);
    const attempt = attemptByOwner.get(id)?.attempt_at;
    const attemptAt = attempt ? Date.parse(attempt) : null;
    const wakeAttemptMiss = isConfirmedWakeAttemptMiss(attemptAt, lastActivity);
    out.set(id, {
      wakeable: wakeSet.has(id),
      liveTurn,
      // Keep the raw wakeability shape backward-compatible: absence means no
      // confirmed miss, while the oracle still projects an explicit false for
      // callers that need to distinguish "no miss" from a degraded read.
      ...(wakeAttemptMiss ? { wakeAttemptMiss: true } : {}),
      // EI-21356812816484561: raw last-turn age for the ACTIVITY-clock
      // ceilings, free from the widened query above. Spread-when-present for
      // the same backward-compatibility reason as `wakeAttemptMiss` — an owner
      // with no activity in the window emits NO key rather than a null, so a
      // reader cannot mistake "nothing in the window" for a measured value.
      ...(lastActivity != null ? { lastActivityMs: lastActivity } : {}),
    });
  }
  return out;
}
