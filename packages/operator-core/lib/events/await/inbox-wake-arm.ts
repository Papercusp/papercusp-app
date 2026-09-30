/**
 * armInboxWake / cancelInboxWake — the always-arm primitive
 * (turn-lifecycle-control-2026-06-08 D-001/D-002/D-003, P-002).
 *
 * Arming an agent's standing inbox-wake watch moves OUT of the agent's own
 * judgment (`coord:await-inbox`, "call this when idle") and INTO the harness
 * layer: the operator (re-)arms on every SessionStart so EVERY psu/Queen-
 * launched agent is wakeable even when it has no idea it will be woken. This is
 * pure composition over the shipped await primitive — `captureWakeHandleForOwner`
 * (the resume handle) + `upsertInboxWakeAwait` (idempotent registration on the
 * agent's own `coord:inbox-wake:<self>` key, the rendezvous a `coord:send
 * {wake:true}` fires). It builds no second wake pump.
 *
 * Idempotent by construction (D-002): re-arming refreshes the handle/floor/note
 * on the one standing row rather than duplicating, so calling it on every
 * lifecycle tick is safe. `coord:await-inbox` is now just an annotation on top
 * of this (D-005) — it refreshes the idle `note`, it is no longer the gate that
 * makes an agent wakeable.
 */

import { getOrgPg } from '@papercusp/db-org';
import { captureWakeHandleForOwner } from './handle';
import { upsertInboxWakeAwait, cancelInboxWakeAwaits } from './store';
import { startAwaitSweeper } from './engine';
import { inboxWakeKey } from '../../agent-tools/coordination/inbox-wake';

/** Standing inbox-wake floor (seconds): bursts of sends inside this window
 *  coalesce into one wake. Shares the watch primitive's env knob so the
 *  always-arm path and `coord:await-inbox` stay in lockstep. */
function idleWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_WATCH_MIN_SLEEP_SEC ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

export interface ArmInboxWakeResult {
  awaitId: number;
  eventKey: string;
  /** One line describing the captured wake-path quality (injectable/resumable
   *  vs inbox-degraded) — surfaced so a caller can log how good the wake is. */
  handleNote: string;
  /** The RESOLVED wake floor (seconds) actually armed on the standing row —
   *  the explicit `minSleepSec` when given, else the `idleWakeFloorSec()`
   *  default. Surfaced so `coord:await-inbox` reports the real floor (60s) it
   *  armed instead of misreporting `null` when the arg was omitted (EI-11648). */
  minSleepSec: number;
}

/**
 * (Re-)arm the standing inbox-wake watch for one agent. Safe to call on every
 * SessionStart / idle tick — it upserts the single standing row. Re-captures
 * the freshest resume handle each call (the native session id may only land in
 * adv_sessions shortly after the first arm; the executor also re-reads it at
 * fire time, so a null-handle first arm self-heals).
 */
export async function armInboxWake(input: {
  ownerId: string;
  note?: string | null;
  minSleepSec?: number | null;
  /** A plan run arming its own inbox-wake: the wake resumes the run via
   *  plans:resume instead of a session resume (overrides the captured handle). */
  planRunId?: number;
  /** @deprecated dead since WI-3575 — events:await is single-workspace by design
   *  (see store.ts); accepted-but-ignored for caller compat, do not thread new callers. */
  workspaceId?: string;
}): Promise<ArmInboxWakeResult> {
  const key = inboxWakeKey(input.ownerId);
  startAwaitSweeper();
  const { handle, note: handleNote } = await captureWakeHandleForOwner(input.ownerId, {
    planRunId: input.planRunId,
  });
  // Resolve the effective floor ONCE so the value we arm is the value we report
  // (EI-11648: previously the tool reported `null` when the arg was omitted, even
  // though this default floor was the one actually armed on the row).
  const minSleepSec = input.minSleepSec ?? idleWakeFloorSec();
  const row = await upsertInboxWakeAwait({
    subscriberId: input.ownerId,
    eventKey: key,
    note: input.note ?? 'always-armed inbox-wake (turn-lifecycle-control)',
    wakeHandle: handle,
    minSleepSec,
  });
  return { awaitId: row.id, eventKey: key, handleNote, minSleepSec };
}

/** Cancel an agent's standing inbox-wake watch — SessionEnd hygiene (D-003:
 *  a deliberately-ended session is not a wake target).
 *  @param workspaceId @deprecated dead since WI-3575 — events:await is single-workspace by
 *  design (see store.ts); accepted-but-ignored for caller compat, do not thread new callers.
 *  Returns rows cancelled. */
export async function cancelInboxWake(ownerId: string, _workspaceId?: string): Promise<number> {
  return cancelInboxWakeAwaits(ownerId);
}

/** In-memory per-owner throttle for the activity-hot-path self-heal below. The
 *  arm is normally done once at launch (bootstrap-su) + once at SessionStart, so
 *  the self-heal's DB probe should run at most ~once per owner per window, not on
 *  every tool call. Bounded; it is only a throttle, so eviction just re-probes. */
const ensuredArmedAt = new Map<string, number>();
const ENSURE_ARMED_TTL_MS = 120_000;

/**
 * SELF-HEAL safety net (launch-wakeability): ensure a LIVE tracked session has its
 * standing inbox-wake armed even if the arm was never recorded — the SessionStart
 * lifecycle hook POST is detached + fail-open + no-retry, so when it loses the race
 * at launch a live agent stays un-wakeable for its WHOLE life (observed: a live
 * adv_sessions row with 500+ tool calls and no await). Driven off `activity:report`
 * (every native tool call), so the FIRST tool call after a lost arm re-arms it.
 *
 * Cheap on the hot path by construction:
 *   - an in-memory per-owner throttle bounds the DB probe to ~once / ENSURE_ARMED_TTL_MS;
 *   - it arms ONLY an owner that BOTH has no live inbox-wake await AND has a live
 *     `adv_sessions` row (a tracked psu/console session) — never a bee (no adv row),
 *     a just-cancelled end (no live row after SessionEnd), or a random/ended id.
 *
 * Idempotent (armInboxWake upserts the one standing row) + best-effort: any failure
 * is swallowed and simply retried after the throttle window — it must never break
 * activity:report. Returns true iff it armed on this call.
 */
export async function ensureInboxWakeArmedForActiveSession(input: {
  ownerId: string;
  /** @deprecated dead since WI-3575 — forwarded to armInboxWake, itself a no-op; kept
   *  for caller compat only. */
  workspaceId?: string;
}): Promise<boolean> {
  const ownerId = input.ownerId;
  if (!ownerId) return false;
  const now = Date.now();
  const last = ensuredArmedAt.get(ownerId);
  if (last != null && now - last < ENSURE_ARMED_TTL_MS) return false; // throttled
  ensuredArmedAt.set(ownerId, now);
  if (ensuredArmedAt.size > 1024) {
    // Bounded: drop the oldest insertions (Map preserves insertion order) down to
    // half. A dropped owner just re-probes on its next report — harmless.
    for (const k of ensuredArmedAt.keys()) {
      ensuredArmedAt.delete(k);
      if (ensuredArmedAt.size <= 512) break;
    }
  }
  try {
    const { sql } = getOrgPg();
    const key = inboxWakeKey(ownerId);
    const armed = await sql<{ one: number }[]>`
      SELECT 1 AS one
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ${ownerId}
         AND event_key = ${key}
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())
       LIMIT 1`;
    if (armed.length > 0) return false; // already wakeable — nothing to heal
    // An owner can have multiple recorded incarnations.  Only the most recent
    // row describes the current session: an older crashed row may still have
    // ended_at IS NULL even after the latest incarnation ended cleanly.  Using
    // "any live row" here resurrects the ended owner on every later tool
    // report, recreating the standing inbox-wake we just cancelled.
    const live = await sql<{ started_at: string }[]>`
      SELECT started_at::text AS started_at
        FROM (
          SELECT started_at, ended_at
            FROM harness_shared.adv_sessions
           WHERE coord_owner_id = ${ownerId}
           ORDER BY started_at DESC, id DESC
           LIMIT 1
        ) latest
       WHERE latest.ended_at IS NULL`;
    if (live.length === 0) return false; // not a live tracked session — don't arm

    // EI-21003383555793967: an explicit events:cancel of the standing inbox wake is a
    // deliberate opt-out for THIS session, not evidence that SessionStart lost its arm.
    // Without this durable check, the next ordinary tool report (often events:status right
    // after cancellation) sees a live adv_sessions row and immediately recreates the await,
    // so loop:end + cancellation leaves a retired owner wakeable forever. Scope the marker to
    // the latest session incarnation: a new SessionStart naturally has a later started_at and
    // is entitled to arm a fresh standing watch.
    const explicitlyCancelled = await sql`
      SELECT 1 AS one
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ${ownerId}
         AND event_key = ${key}
         AND cancelled_at IS NOT NULL
         AND cancelled_at >= ${live[0]?.started_at}
       LIMIT 1`;
    if (explicitlyCancelled.length > 0) return false;

    await armInboxWake({ ownerId, workspaceId: input.workspaceId });
    return true;
  } catch {
    // Best-effort: a self-heal miss is harmless (it retries after the throttle
    // window). The throttle entry stands so a persistent fault can't hammer PG.
    return false;
  }
}
