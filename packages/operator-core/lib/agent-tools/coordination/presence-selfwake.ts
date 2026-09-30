/**
 * presence-selfwake.ts — the FORWARD-LOOKING wake axis: "will anything wake this
 * agent again, unprompted?" (EI-19407725333778711).
 *
 * This is a THIRD axis, orthogonal to the two `presence-wakeability.ts` already
 * carries, and the whole point of the module is that it must not be folded into
 * either of them:
 *
 *   - `wakeable`     — a PUSH lands. There is a live `coord:inbox-wake:<id>`
 *                      await, so a coordinator's `events:emit` / `coord:dispatch`
 *                      WILL be delivered. Answers "can I hand this agent work?"
 *   - `sessionState` — what the agent is doing NOW (live | parked | …).
 *   - `selfWake`     — THIS module. Will the agent take another turn WITHOUT a
 *                      coordinator poking it? Answers "does `now` ever end?"
 *
 * Why the third axis had to exist (the incident, 2026-08-03 04:51–05:14Z, harness
 * papercusp): a fleet leader read `11 alive, 11 claims, 0 parked` from
 * fleet:assignments while three members had `routines.active = false` on their
 * `loop-<ownerId>` rows, disarmed 67 minutes earlier. They were live and
 * productive ONLY because the leader had sent a manual `wake: required`; the
 * moment their turn ended, nothing would ever have woken them. Every fleet
 * surface reported them as healthy, because every fleet surface answers a
 * question about the present.
 *
 * Earlier the same gap hid the original outage: 7 of 11 members could not
 * self-wake, and every surface reported `parked` with a fresh heartbeat —
 * BYTE-IDENTICAL to a correctly-idle member, because the member contract
 * explicitly tells a member to park when its lane drains. The healthy state and
 * the terminal state were indistinguishable from every read a leader had.
 *
 * The derived read that closes it:
 *
 *     sessionState: 'parked' + selfWake: 'none'  ⇒  a dead member in a healthy costume.
 *
 * ── Why `notify` awaits are EXCLUDED ────────────────────────────────────────
 * `event_awaits.policy` is one of wake | notify | announce, and only `wake`
 * causes a turn. A `notify` subscription injects into the inbox for the agent to
 * read on some LATER turn it takes for other reasons — it cannot itself produce
 * that turn — and `announce` is a gate DECLARATION, not a subscription at all.
 * Counting either as a self-wake source would re-create the exact bug this
 * module exists to kill, just one layer down: an agent with nothing but a
 * `notify` await will never wake, and would have reported `selfWake: 'event'`.
 *
 * ── Why `unknown` is not `none` ─────────────────────────────────────────────
 * A degraded fetch yields NO map entry, never a `'none'` verdict. "Nothing will
 * wake this agent" is an actionable, escalation-worthy claim; "I could not tell"
 * is not, and a reader that cannot distinguish them will either relaunch healthy
 * members or — far worse — learn to ignore the field. This mirrors the oracle's
 * own long-standing rule that a missing wakeability signal leaves `sessionState`
 * UNSET rather than guessing.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { COORD_INBOX_WAKE_PREFIX, classifyDormantSchedule } from './inbox-wake';
import { EXPLICIT_PARK_NOTE_MARKER } from '../../events/await/types';
import type { LoopStatus } from '../../harness/routines/loop';

/**
 * What will wake this agent unprompted, strongest source first.
 *   loop  — an ACTIVE `loop-<ownerId>` routine: the engine re-wakes it on a cadence.
 *   event — a standing `policy='wake'` event await (e.g. the member contract's
 *           `events:await { event:'work-item:claimable' }` park): the condition
 *           firing produces a turn.
 *   none  — NOTHING will. The agent acts again only if a human or a peer pokes it.
 */
export type SelfWakeSource = 'loop' | 'event' | 'none';

/** The raw per-agent self-wake signals `deriveSelfWake` consumes. */
export interface SelfWakeSignals {
  /** An active `loop-<ownerId>` routine row exists (`loop:arm`, still armed). */
  loopArmed: boolean;
  /** A live, unfired, uncancelled, unexpired `policy='wake'` await on a key OTHER
   *  than this agent's own `coord:inbox-wake:<id>` push channel. */
  standingEventAwait: boolean;
  /** The roll-up a supervisor reads. */
  selfWake: SelfWakeSource;
}

/**
 * PURE: the self-wake roll-up. `loop` outranks `event` because it is
 * unconditional — a cadence fires regardless of whether any condition is ever
 * met, whereas an await depends on an event that may never come.
 */
export function deriveSelfWake(input: {
  loopArmed: boolean;
  standingEventAwait: boolean;
}): SelfWakeSource {
  if (input.loopArmed) return 'loop';
  if (input.standingEventAwait) return 'event';
  return 'none';
}

/** The scheduled-fire pair a presence row carries (EI-22805550006169069). */
export interface DormantScheduleSignal {
  /** A self-wake is already scheduled. `null` = NOT MEASURED (a federated row, or
   *  the loop read degraded) — never collapse it to `false`, which would assert
   *  that nothing will ever wake this agent. */
  dormantScheduled: boolean | null;
  /** ISO time of that fire; null while a turn is in flight (parked) or when
   *  `dormantScheduled` is not true. Read the pair together. */
  nextFireAt: string | null;
}

/**
 * PURE: the QUANTITATIVE half of this module's axis.
 *
 * `deriveSelfWake` above answers "does `now` ever end?" — a yes/no. This answers
 * "WHEN?", and the difference is what makes a presence row safe to act on. An
 * agent DORMANT BETWEEN LOOP FIRES has, accurately, no live turn, no armed inbox
 * await, no claims and no recent activity: it renders byte-identical to a dead
 * one, so a coordinator reading that row reclaims its work or relaunches it. The
 * disconfirming datum already existed on the wake path (`coord:send` returns
 * `recipient_dormant_scheduled` with a concrete `nextFireAt`) — it was simply
 * absent from the surface people read BEFORE deciding.
 *
 * Delegates the actual rule to `classifyDormantSchedule` rather than restating
 * it, so this surface cannot drift from the wake path it exists to agree with —
 * `stalled` guard included: an ACTIVE loop parked-and-wedged for hours is not a
 * promise that anything will fire, and reporting it as scheduled would swap a
 * missing-information bug for a false-confidence one.
 */
export function deriveDormantSchedule(
  input: {
    /** A federated peer's loop lives on its home box — not measurable here. */
    federated?: boolean;
    /** Did the batched loop read actually succeed? An empty map is otherwise
     *  ambiguous: "no owner has a loop" and "the query failed" look identical. */
    measured: boolean;
    loop?: Pick<LoopStatus, 'active' | 'nextFireAt' | 'parked' | 'stalled'> | null;
  },
  nowMs: number = Date.now(),
): DormantScheduleSignal {
  if (input.federated || !input.measured) return { dormantScheduled: null, nextFireAt: null };
  const schedule = classifyDormantSchedule(input.loop ?? null, nowMs);
  return schedule
    ? { dormantScheduled: true, nextFireAt: schedule.nextFireAt }
    : { dormantScheduled: false, nextFireAt: null };
}

/**
 * PURE: the single most actionable derived read — a member that is NOT going to
 * act again unless someone pokes it, while LOOKING healthy.
 *
 * Deliberately counts `live` as well as `parked`. Counting only `parked` would
 * have MISSED the incident that motivated this module: those three members were
 * `live` (a manual wake was in flight) and would have stranded silently the
 * instant that turn ended. A `live` member with no self-wake source is not
 * healthy — it is a member with one turn left.
 *
 * `ended` / `suspect` are excluded: they are ALREADY visibly dead on every
 * surface, so counting them here would bury the signal this exists to raise
 * under noise a leader has already seen and acted on. `undefined` (unknown)
 * never counts — see the module header.
 */
export function isStrandedMember(input: {
  sessionState?: string | null;
  selfWake?: SelfWakeSource | null;
}): boolean {
  if (input.selfWake !== 'none') return false;
  const s = input.sessionState;
  return s === 'live' || s === 'parked' || s === 'draining' || s === 'recorded';
}

/**
 * IO seam: two batch queries keyed by `ownerIds` (a constant per read, never
 * per-agent — the same STORE MAXIMAL, READ MINIMAL shape as `fetchWakeability`).
 *
 * Owner ids are globally-unique session ids, so neither query needs workspace or
 * harness scoping to be correct — which also keeps this clear of the
 * multi-tenant `(workspace_id, harness_slug, slug)` trap that bites raw reads of
 * the slug-keyed tables.
 *
 * Best-effort by contract: a caller that cannot reach PG gets an EMPTY map, and
 * every consumer must treat a missing entry as UNKNOWN, never as `'none'`.
 */
export async function fetchSelfWake(ownerIds: string[], db?: Sql): Promise<Map<string, SelfWakeSignals>> {
  const out = new Map<string, SelfWakeSignals>();
  if (ownerIds.length === 0) return out;
  const sql = db ?? getOrgPg().sql;

  const [loops, awaits] = await Promise.all([
    sql<{ target_owner_id: string }[]>`
      SELECT DISTINCT target_owner_id
        FROM harness_shared.routines
       WHERE target_owner_id = ANY(${ownerIds}::text[])
         AND name LIKE 'loop-%'
         AND active = true`,
    sql<{ subscriber_id: string }[]>`
      SELECT DISTINCT subscriber_id
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ANY(${ownerIds}::text[])
         AND policy = 'wake'
         AND (
           event_key <> ${COORD_INBOX_WAKE_PREFIX} || subscriber_id
           OR note LIKE ${EXPLICIT_PARK_NOTE_MARKER + '%'}
         )
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())`,
  ]);

  const loopSet = new Set(loops.map((r) => r.target_owner_id));
  const awaitSet = new Set(awaits.map((r) => r.subscriber_id));
  for (const id of ownerIds) {
    const loopArmed = loopSet.has(id);
    const standingEventAwait = awaitSet.has(id);
    out.set(id, { loopArmed, standingEventAwait, selfWake: deriveSelfWake({ loopArmed, standingEventAwait }) });
  }
  return out;
}
